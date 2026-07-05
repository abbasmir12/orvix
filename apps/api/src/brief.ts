import { isQwenConfigured, QwenClient, withQwenUsageRun } from "@orvix/qwen";
import { listWorkspaceFiles } from "@orvix/workspace";
import {
  addReasoningArtifact,
  appendEvent,
  broadcast,
  orvixMapContext,
  usesQwenReasoning,
  workspaceOf,
  type MissionRun
} from "./run.js";
import { postBookEntry } from "./book.js";

export type MissionBrief = {
  version: number;
  trigger: string;
  generatedAt: string;
  title: string;
  summary: string;
  features: string[];
  keyFiles: Array<{ path: string; purpose: string }>;
  howToTest: string[];
  userActions: string[];
  nextSteps: string[];
};

export function missionBriefs(run: MissionRun): MissionBrief[] {
  const briefs: MissionBrief[] = [];
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "mission_brief" || artifact.status !== "completed" || !artifact.content) continue;
    try {
      briefs.push(JSON.parse(artifact.content) as MissionBrief);
    } catch {
      continue;
    }
  }
  return briefs.sort((a, b) => a.version - b.version);
}

/**
 * MasterMind's debrief for the owner, generated after every delivery and
 * versioned per delivery: v1 on first completion, v2 after an owner change
 * request re-completes the mission, and so on. Failure to generate never
 * affects mission state — the brief is reporting, not gating.
 */
export async function generateMissionBrief(run: MissionRun, trigger: string) {
  if (!usesQwenReasoning(run) || !isQwenConfigured() || !run.workspace) return null;
  const version = missionBriefs(run).length + 1;
  appendEvent(run, `MasterMind is writing mission debrief v${version}`, "info");

  try {
    const listing = listWorkspaceFiles(workspaceOf(run));
    const files = listing.ok && "files" in listing && Array.isArray(listing.files)
      ? listing.files.map((file) => (file as { path?: string }).path).filter(Boolean).slice(0, 120)
      : [];
    const ownerRequests = run.state.bookEntries
      .filter((entry) => entry.fromAgentId === "owner")
      .slice(-5)
      .map((entry) => entry.message.slice(0, 200));

    const brief = await withQwenUsageRun(run.id, () => new QwenClient().missionBriefJson({
      mission: run.mission,
      briefVersion: version,
      trigger,
      projectType: workspaceOf(run).projectType,
      tasks: run.state.tasks.map((task) => ({ title: task.title, status: task.status, owner: task.ownerAgentId })),
      pullRequests: run.state.pullRequests.map((pr) => ({ id: pr.id, title: pr.title, status: pr.status, branch: pr.branch })),
      files,
      orvixMapSummary: orvixMapContext(run)?.mapSummary,
      recentOwnerRequests: ownerRequests
    }));

    const record: MissionBrief = {
      version,
      trigger,
      generatedAt: new Date().toISOString(),
      title: brief.title || `Delivery ${version}`,
      summary: brief.summary || "",
      features: brief.features ?? [],
      keyFiles: brief.keyFiles ?? [],
      howToTest: brief.howToTest ?? [],
      userActions: brief.userActions ?? [],
      nextSteps: brief.nextSteps ?? []
    };
    addReasoningArtifact(run, {
      kind: "mission_brief",
      status: "completed",
      content: JSON.stringify(record)
    });
    postBookEntry(run, {
      type: "decision",
      fromAgentId: "mastermind-agent",
      scope: "mission",
      visibility: "global",
      topics: ["brief", "delivery", `v${version}`],
      priority: "high",
      status: "final",
      message: `Mission debrief v${version} ready: ${record.title} — ${record.summary.slice(0, 160)}`
    });
    appendEvent(run, `MasterMind published mission debrief v${version}: ${record.title}`, "success");
    broadcast(run, "state", run.state);
    return record;
  } catch (error) {
    appendEvent(run, `Mission debrief v${version} failed: ${error instanceof Error ? error.message : "unknown"}`, "warning");
    return null;
  }
}
