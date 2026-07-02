import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeStateSnapshot } from "@orvix/core";
import { addReasoningArtifact, appendEvent, broadcast, workspaceOf, type MissionRun } from "./run.js";
import { postBookEntry } from "./book.js";
import { isNonBlockingReviewerPr } from "./review.js";

export function shouldRunRuntimeAcceptance(run: MissionRun) {
  if (hasRuntimeGatePassed(run) || run.state.isComplete) return false;
  const requiredPrs = run.state.pullRequests.filter((pr) => !isNonBlockingReviewerPr(run, pr));
  if (requiredPrs.length === 0) return false;
  return requiredPrs.every((pr) => pr.status === "Approved");
}

export type RuntimeAcceptanceResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; output: string }>;
  findings: string[];
};

export async function runRuntimeAcceptanceGate(run: MissionRun): Promise<RuntimeAcceptanceResult> {
  if (hasRuntimeGatePassed(run)) {
    return { ok: true, checks: [], findings: [] };
  }

  appendEvent(run, "Runtime QA started mission acceptance checks", "info");
  const checks: RuntimeAcceptanceResult["checks"] = [];
  const findings: string[] = [];
  const projectType = workspaceOf(run).projectType ?? "generic";
  const repoDir = workspaceOf(run).repoDir;

  if (projectType === "nextjs" || projectType === "react-vite" || projectType === "express-api" || projectType === "node-cli") {
    if (!existsSync(resolve(repoDir, "node_modules"))) {
      checks.push(runCommandCheck(repoDir, "npm install --package-lock=false", ["install", "--package-lock=false"]));
    }
    checks.push(runCommandCheck(repoDir, "npm run build", ["run", "build"]));
  }

  if (projectType === "python") {
    checks.push(runCommandCheck(repoDir, "python src/main.py", ["src/main.py"], "python"));
  }

  if (projectType === "nextjs" || projectType === "react-vite") {
    const staticFindings = scanMissionPlaceholders(run);
    findings.push(...staticFindings);
    if (checks.every((check) => check.ok)) {
      const pageChecks = await runWebPageSmokeChecks(run);
      checks.push(...pageChecks.checks);
      findings.push(...pageChecks.findings);
    }
  }

  const failedChecks = checks.filter((check) => !check.ok);
  findings.push(...failedChecks.map((check) => `${check.name} failed: ${check.output.slice(0, 500)}`));
  const ok = findings.length === 0;

  addReasoningArtifact(run, {
    kind: "agent_execution",
    status: ok ? "completed" : "failed",
    content: JSON.stringify({
      agent: {
        id: "runtime-qa-agent",
        name: "Runtime QA Agent",
        role: "Runs project commands and verifies mission acceptance"
      },
      task: {
        id: "task-runtime-acceptance",
        title: "Verify generated project against mission",
        branch: "main",
        acceptanceCriteria: [
          "Project install/build command succeeds",
          "Primary pages do not show scaffold placeholder content",
          "Visible app output matches the user mission"
        ]
      },
      plan: {
        summary: "Runtime QA verifies the actual generated project before MasterMind final approval.",
        transcript: [
          {
            type: "decision",
            text: "All PRs are approved, but MasterMind cannot approve final delivery until the generated project builds and the visible pages match the mission.",
            beforeToolIndex: 0
          }
        ],
        toolCalls: []
      },
      runtimeAcceptance: {
        projectType,
        checks,
        findings
      },
      results: []
    })
  });

  if (ok) {
    postBookEntry(run, {
      type: "decision",
      fromAgentId: "mastermind-agent",
      scope: "mission",
      visibility: "global",
      topics: ["runtime", "acceptance", "verification"],
      status: "final",
      priority: "high",
      message: "Runtime acceptance passed. Build and visible-page checks are clean enough for final MasterMind approval."
    });
    appendEvent(run, "Runtime QA passed mission acceptance checks", "success");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    return { ok, checks, findings };
  }

  routeRuntimeFindingsForRevision(run, findings);
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return { ok, checks, findings };
}

export function runCommandCheck(cwd: string, name: string, args: string[], command = "npm") {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { name, ok: true, output: output.slice(-2000) };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}\n${failure.message ?? ""}`.trim();
    return { name, ok: false, output: output.slice(-4000) };
  }
}

export function scanMissionPlaceholders(run: MissionRun) {
  const findings: string[] = [];
  const files = collectFiles(workspaceOf(run).repoDir, ["app", "src"], /\.(tsx|ts|jsx|js|css)$/);
  const placeholderPatterns = [
    /Runnable Next\.js starting point/i,
    /Orvix Project Scaffold/i,
    /Specialist agents can now build inside a real app structure/i,
    /Mission-aware scaffold/i,
    /Agent-ready file layout/i,
    /Reviewable UI surface/i
  ];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (placeholderPatterns.some((pattern) => pattern.test(content))) {
      findings.push(`${relativePath(workspaceOf(run).repoDir, file)} still contains scaffold placeholder content.`);
    }
  }

  const missionTerms = missionAcceptanceTerms(run.mission);
  const appText = files.map((file) => readFileSync(file, "utf8")).join("\n").toLowerCase();
  const missingTerms = missionTerms.filter((term) => !appText.includes(term));
  if (missingTerms.length > 0) {
    findings.push(`Visible app files do not clearly contain mission terms: ${missingTerms.join(", ")}.`);
  }

  findings.push(...scanMissionSpecificSourceIssues(run, files));

  return findings;
}

export function scanMissionSpecificSourceIssues(run: MissionRun, files: string[]) {
  const findings: string[] = [];
  const mission = run.mission.toLowerCase();
  const projectType = workspaceOf(run).projectType ?? "generic";
  const sourceByRelativePath = new Map(files.map((file) => [relativePath(workspaceOf(run).repoDir, file), readFileSync(file, "utf8")]));
  const combined = Array.from(sourceByRelativePath.values()).join("\n");
  const appSource = sourceByRelativePath.get("src/App.tsx") ?? sourceByRelativePath.get("app/page.tsx") ?? "";

  if (/\bmock|placeholder|stub/i.test(appSource)) {
    findings.push("Primary app entry still contains mock/placeholder/stub implementation text.");
  }

  if (projectType === "react-vite" && /game|2d|canvas|playable|score|keyboard/.test(mission)) {
    const hasCanvas = /<canvas\b/i.test(appSource) || /createElement\(["']canvas["']/i.test(appSource);
    if (!hasCanvas) {
      findings.push("React game mission does not mount a canvas in src/App.tsx.");
    }
    if (sourceByRelativePath.has("src/game/useGameLoop.ts") && !/useGameLoop/.test(appSource.replace(/function\s+useGameLoopMock[\s\S]*?\n}/, ""))) {
      findings.push("src/App.tsx does not wire the real src/game/useGameLoop.ts hook.");
    }
    if (sourceByRelativePath.has("src/game/input.ts") && !/useInput/.test(appSource)) {
      findings.push("src/App.tsx does not wire the real src/game/input.ts hook.");
    }
    if (sourceByRelativePath.has("src/game/renderer.ts") && !/render/.test(appSource)) {
      findings.push("src/App.tsx does not wire the real src/game/renderer.ts renderer.");
    }
    for (const term of ["score", "gameover", "playing"]) {
      if (!combined.toLowerCase().includes(term)) {
        findings.push(`React game source does not include required game state term: ${term}.`);
      }
    }
  }

  return findings;
}

export function missionAcceptanceTerms(mission: string) {
  const text = mission.toLowerCase();
  return ["crm", "auth", "dashboard", "contacts", "notes"]
    .filter((term) => text.includes(term));
}

export async function runWebPageSmokeChecks(run: MissionRun) {
  const checks: RuntimeAcceptanceResult["checks"] = [];
  const findings: string[] = [];
  const port = await findFreePort(3100);
  const isNext = workspaceOf(run).projectType === "nextjs";
  const args = isNext ? ["run", "dev", "--", "-p", String(port)] : ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn("npm", args, {
    cwd: workspaceOf(run).repoDir,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });

  try {
    const ready = await waitForUrl(`http://127.0.0.1:${port}`, 30000);
    checks.push({ name: "npm run dev", ok: ready, output: logs.slice(-2000) });
    if (!ready) {
      findings.push(`Development server did not become reachable. Logs: ${logs.slice(-800)}`);
      return { checks, findings };
    }

    const routes = runtimeRoutesForMission(run.mission);
    for (const route of routes) {
      const result = await fetchText(`http://127.0.0.1:${port}${route}`);
      checks.push({ name: `GET ${route}`, ok: result.ok, output: result.text.slice(0, 800) });
      if (!result.ok) {
        findings.push(`${route} did not return a successful response.`);
      }
      if (/Runnable Next\.js starting point|Orvix Project Scaffold|Mission-aware scaffold/i.test(result.text)) {
        findings.push(`${route} still renders scaffold placeholder copy instead of the requested product.`);
      }
    }
  } finally {
    child.kill("SIGTERM");
  }

  return { checks, findings };
}

export function runtimeRoutesForMission(mission: string) {
  const text = mission.toLowerCase();
  const routes = ["/"];
  if (text.includes("dashboard")) routes.push("/dashboard");
  if (text.includes("contacts")) routes.push("/dashboard/contacts", "/contacts");
  if (text.includes("notes")) routes.push("/notes");
  if (text.includes("auth") || text.includes("login")) routes.push("/login");
  return Array.from(new Set(routes)).slice(0, 6);
}

export async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fetchText(url);
    if (result.ok) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  }
  return false;
}

export async function fetchText(url: string) {
  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      text: await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : "fetch failed"
    };
  }
}

export async function findFreePort(start: number) {
  for (let port = start; port < start + 50; port += 1) {
    const available = await new Promise<boolean>((resolvePromise) => {
      const server = createServer();
      server.once("error", () => resolvePromise(false));
      server.once("listening", () => {
        server.close(() => resolvePromise(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  return start;
}

export function collectFiles(root: string, directories: string[], pattern: RegExp) {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      const absolute = resolve(dir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) visit(absolute);
      if (stats.isFile() && pattern.test(absolute)) files.push(absolute);
    }
  };
  directories.forEach((directory) => visit(resolve(root, directory)));
  return files;
}

export function relativePath(root: string, file: string) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

export function routeRuntimeFindingsForRevision(run: MissionRun, findings: string[]) {
  const owner = findRuntimeFixOwner(run);
  const message = [
    "Runtime acceptance failed. MasterMind is waking the owning agent before final approval.",
    "",
    ...findings.map((finding) => `- ${finding}`),
    "",
    "Fix the visible product experience and verification failures, then reopen the PR/revision path."
  ].join("\n");

  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    toAgentIds: owner ? [owner.id] : [],
    scope: "mission",
    visibility: owner ? "mentioned" : "global",
    topics: ["runtime", "acceptance", "revision", "mission-fit"],
    priority: "urgent",
    status: "open",
    message
  });
  appendEvent(run, `Runtime QA blocked final approval: ${findings[0] ?? "acceptance failed"}`, "warning");

  if (!owner) return;
  run.state = {
    ...run.state,
    agents: run.state.agents.map((agent) => agent.id === owner.id
      ? { ...agent, status: "blocked", currentActivity: "Runtime acceptance fixes required", progress: Math.min(agent.progress, 84) }
      : agent.id === "mastermind-agent"
        ? { ...agent, status: "active", currentActivity: "Routing runtime acceptance failure", progress: Math.max(agent.progress, 88) }
        : agent),
    tasks: run.state.tasks.map((task) => task.ownerAgentId === owner.id
      ? { ...task, status: "blocked" }
      : task),
    pullRequests: run.state.pullRequests.map((pr) => pr.ownerAgentId === owner.id
      ? {
          ...pr,
          status: "Changes requested",
          reviewerStatus: "Requested changes",
          comments: [...pr.comments, `Runtime acceptance failed: ${findings[0] ?? "mission output incomplete"}`]
        }
      : pr)
  };
}

export function findRuntimeFixOwner(run: MissionRun) {
  return run.state.agents.find((agent) => /frontend|ui|dashboard|page|interface|experience/i.test(`${agent.name} ${agent.role}`)) ??
    run.state.agents.find((agent) => /qa|test|runtime|quality|validator/i.test(`${agent.name} ${agent.role}`)) ??
    run.state.agents.find((agent) => agent.id !== "mastermind-agent");
}

export function hasRuntimeGatePassed(run: MissionRun) {
  return run.state.bookEntries.some((entry) =>
    entry.fromAgentId === "mastermind-agent" &&
    entry.type === "decision" &&
    entry.topics.includes("runtime") &&
    entry.topics.includes("acceptance") &&
    entry.message.includes("Runtime acceptance passed")
  );
}

