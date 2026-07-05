import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRunStore, writeStateSnapshot, type ReasoningArtifact, type SimulationState } from "@orvix/core";
import type { ProjectScaffoldType, Workspace } from "@orvix/workspace";
import { projectRoot, workspaceRoot } from "./envConfig.js";
import {
  appendEvent,
  broadcast,
  createRunMetrics,
  runs,
  usesQwenReasoning,
  type MissionMode,
  type MissionRun
} from "./run.js";
import { getExecutedBranches } from "./agentRuntime.js";
import { startAutomaticAutopilot } from "./scheduler.js";

/**
 * Rebuilds a MissionRun from its on-disk snapshot (.orvix/runs/<id>) and
 * workspace (.orvix/workspaces/<id>) so a restarted API can continue a
 * mission instead of losing it with the process. Metrics restart from zero
 * (token history lives in the artifacts, not in memory) and any PR that a
 * dead session left "In progress" without execution evidence is re-queued so
 * the scheduler pool can re-run it rather than deadlock on a phantom owner.
 */
export function resumeRun(missionId: string): { ok: true; run: MissionRun; resumed: boolean } | { ok: false; error: string } {
  const existing = runs.get(missionId);
  if (existing) return { ok: true, run: existing, resumed: false };

  const runDir = resolve(projectRoot, ".orvix", "runs", missionId);
  const statePath = resolve(runDir, "state.json");
  const manifestPath = resolve(runDir, "manifest.json");
  if (!existsSync(statePath) || !existsSync(manifestPath)) {
    return { ok: false, error: "no_snapshot_on_disk" };
  }

  let manifest: { mission?: string; mode?: string };
  let snapshot: { state?: SimulationState; reasoningArtifacts?: ReasoningArtifact[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    snapshot = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    return { ok: false, error: `snapshot_unreadable: ${error instanceof Error ? error.message : "parse failed"}` };
  }
  if (!snapshot.state || !manifest.mission) {
    return { ok: false, error: "snapshot_incomplete" };
  }

  const mode: MissionMode = manifest.mode === "qwen" || manifest.mode === "solo" ? manifest.mode : "mock";
  const store = createRunStore(missionId, projectRoot);
  const run: MissionRun = {
    id: missionId,
    mission: manifest.mission,
    mode,
    state: snapshot.state,
    stepIndex: 0,
    reasoningArtifacts: snapshot.reasoningArtifacts ?? [],
    store,
    workspace: loadWorkspaceFromDisk(missionId),
    planningStages: [],
    subscribers: new Set(),
    metrics: createRunMetrics(),
    progressTimer: setInterval(() => {
      if (run.state.isComplete) clearInterval(run.progressTimer);
    }, 5000)
  };
  runs.set(missionId, run);

  if (run.state.isComplete) {
    // Still wakeable: an owner request can reopen work, and the autopilot it
    // kicks refuses to run while planning looks incomplete.
    run.qwenPlanningComplete = usesQwenReasoning(run);
    appendEvent(run, "Mission resumed from disk (complete; owner requests can reopen it)", "info");
    return { ok: true, run, resumed: true };
  }

  if (!run.workspace) {
    appendEvent(run, "Mission resumed but its workspace is missing on disk; planning cannot continue — start a new mission", "warning");
    return { ok: true, run, resumed: true };
  }

  // Re-queue work the previous process left in unrecoverable states: PRs
  // "In progress" without execution evidence (session died mid-flight) and
  // tasks/agents stuck "blocked" or "active" by failed sessions. A blocked
  // status only means something while the process that set it is alive —
  // legitimate review blocks re-assert themselves through PR statuses.
  const executedBranches = getExecutedBranches(run);
  const phantomBranches = new Set(
    run.state.pullRequests
      .filter((pr) => pr.status === "In progress" && !executedBranches.has(pr.branch))
      .map((pr) => pr.branch)
  );
  const approvedBranches = new Set(run.state.pullRequests.filter((pr) => pr.status === "Approved").map((pr) => pr.branch));
  const staleTask = (task: SimulationState["tasks"][number]) =>
    (phantomBranches.has(task.branch) || task.status === "blocked" || task.status === "active") &&
    task.status !== "completed" &&
    !approvedBranches.has(task.branch);
  const staleCount = run.state.tasks.filter(staleTask).length;
  if (staleCount > 0 || phantomBranches.size > 0) {
    const staleOwners = new Set(run.state.tasks.filter(staleTask).map((task) => task.ownerAgentId));
    run.state = {
      ...run.state,
      pullRequests: run.state.pullRequests.map((pr) => phantomBranches.has(pr.branch)
        ? { ...pr, status: "Queued" as const, reviewerStatus: "Pending" as const }
        : pr),
      tasks: run.state.tasks.map((task) => staleTask(task) ? { ...task, status: "queued" } : task),
      agents: run.state.agents.map((agent) => staleOwners.has(agent.id) && agent.status !== "completed"
        ? { ...agent, status: "queued", currentActivity: "Re-queued after resume" }
        : agent)
    };
    appendEvent(run, `Resume re-queued ${staleCount} interrupted workstream${staleCount === 1 ? "" : "s"} from the previous process`, "info");
  }

  run.qwenPlanningComplete = usesQwenReasoning(run);
  appendEvent(run, "Mission resumed from disk snapshot; scheduler pool is restarting", "success");
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  if (usesQwenReasoning(run)) {
    startAutomaticAutopilot(run);
  }
  return { ok: true, run, resumed: true };
}

/** Best-effort scaffold detection from the repo itself (manifest does not store it). */
function loadWorkspaceFromDisk(missionId: string): Workspace | undefined {
  const rootDir = resolve(workspaceRoot, missionId);
  const repoDir = resolve(rootDir, "repo");
  if (!existsSync(resolve(repoDir, ".git"))) return undefined;

  let projectType: ProjectScaffoldType = "generic";
  const packagePath = resolve(repoDir, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      projectType = deps.next ? "nextjs" : deps.vite ? "react-vite" : deps.express ? "express-api" : "node-cli";
    } catch {
      projectType = "generic";
    }
  } else if (existsSync(resolve(repoDir, "src", "main.py"))) {
    projectType = "python";
  }

  return {
    missionId,
    rootDir,
    repoDir,
    docsDir: resolve(repoDir, "docs"),
    worktreesDir: resolve(rootDir, "worktrees"),
    projectType
  };
}

/** Lists resumable missions from disk for the CLI (most recent first). */
export function listRunsOnDisk() {
  const runsDir = resolve(projectRoot, ".orvix", "runs");
  if (!existsSync(runsDir)) return [];
  const entries: Array<{ missionId: string; mission: string; mode: string; createdAt: string; isComplete: boolean; inMemory: boolean }> = [];
  for (const name of readdirSync(runsDir)) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(runsDir, name, "manifest.json"), "utf8"));
      const snapshot = JSON.parse(readFileSync(resolve(runsDir, name, "state.json"), "utf8"));
      entries.push({
        missionId: manifest.missionId ?? name,
        mission: String(manifest.mission ?? "").slice(0, 120),
        mode: String(manifest.mode ?? "mock"),
        createdAt: String(manifest.createdAt ?? ""),
        isComplete: Boolean(snapshot.state?.isComplete),
        inMemory: runs.has(name)
      });
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
