import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeStateSnapshot } from "@orvix/core";
import { isQwenConfigured, QwenClient } from "@orvix/qwen";
import { addReasoningArtifact, appendEvent, broadcast, orvixMapContext, workspaceOf, type MissionRun } from "./run.js";
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
  /** True when the gate failed only because the Qwen judge was unreachable. */
  judgeUnavailable?: boolean;
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

  const pageSamples: Array<{ route: string; ok: boolean; textSnippet: string }> = [];
  if (projectType === "nextjs" || projectType === "react-vite") {
    const staticFindings = scanMissionPlaceholders(run);
    findings.push(...staticFindings);
    if (checks.every((check) => check.ok)) {
      const pageChecks = await runWebPageSmokeChecks(run);
      checks.push(...pageChecks.checks);
      findings.push(...pageChecks.findings);
      pageSamples.push(...pageChecks.pageSamples);
    }
  }

  const failedChecks = checks.filter((check) => !check.ok);
  findings.push(...failedChecks.map((check) => `${check.name} failed: ${check.output.slice(0, 500)}`));

  // Deterministic evidence is clean; in qwen mode, Runtime QA (Qwen) now
  // judges mission fit from the real build output and fetched pages instead
  // of hardcoded keyword scans.
  if (findings.length === 0 && run.mode === "qwen" && isQwenConfigured()) {
    const map = orvixMapContext(run);
    try {
      const verdict = await new QwenClient().runtimeAcceptanceVerdictJson({
        mission: run.mission,
        productType: projectType,
        acceptanceGates: map?.acceptanceGates ?? run.state.analysis.successCriteria,
        forbiddenOutputs: map?.forbiddenOutputs ?? [],
        checks,
        pageSamples,
        sourceSample: primarySourceSample(run)
      });
      if (verdict.pass) {
        appendEvent(run, `Runtime QA mission-fit verdict: ${verdict.summary || "generated product matches the mission"}`, "success");
      } else {
        findings.push(...(verdict.findings.length > 0 ? verdict.findings : [verdict.summary || "Runtime QA rejected mission fit without details"]));
        appendEvent(run, `Runtime QA mission-fit verdict failed: ${verdict.summary}`, "warning");
      }
    } catch (error) {
      // An unavailable judge must not silently pass the gate, but it is not
      // the agents' fault either: fail without routing a revision so the
      // scheduler simply retries the gate on a later turn.
      const message = `Runtime QA verdict unavailable: ${error instanceof Error ? error.message : "Qwen error"}; acceptance gate will retry`;
      appendEvent(run, message, "warning");
      return { ok: false, checks, findings: [message], judgeUnavailable: true };
    }
  }

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

  return findings;
}

/** The visible entry file, for the Runtime QA judge to sanity-check mission fit. */
export function primarySourceSample(run: MissionRun) {
  const repoDir = workspaceOf(run).repoDir;
  for (const candidate of ["src/App.tsx", "app/page.tsx", "src/index.ts", "src/main.py"]) {
    const absolute = resolve(repoDir, candidate);
    if (existsSync(absolute)) {
      return `// ${candidate}\n${readFileSync(absolute, "utf8")}`;
    }
  }
  return undefined;
}

export async function runWebPageSmokeChecks(run: MissionRun) {
  const checks: RuntimeAcceptanceResult["checks"] = [];
  const findings: string[] = [];
  const pageSamples: Array<{ route: string; ok: boolean; textSnippet: string }> = [];
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
      return { checks, findings, pageSamples };
    }

    const routes = runtimeRoutesFromMap(run);
    for (const route of routes) {
      const result = await fetchText(`http://127.0.0.1:${port}${route}`);
      checks.push({ name: `GET ${route}`, ok: result.ok, output: result.text.slice(0, 800) });
      pageSamples.push({ route, ok: result.ok, textSnippet: stripPageHtml(result.text).slice(0, 2000) });
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

  return { checks, findings, pageSamples };
}

/** Smoke-test routes come from the locked Orvix Map surfaces, not mission keywords. */
export function runtimeRoutesFromMap(run: MissionRun) {
  const routes = ["/"];
  const map = orvixMapContext(run);
  for (const surface of map?.surfaces ?? []) {
    if (!surface || typeof surface !== "object") continue;
    const type = String(surface.type ?? "");
    const path = String(surface.path ?? "");
    if ((type === "route" || type === "screen" || type === "page") && path.startsWith("/")) {
      routes.push(path);
    }
  }
  return Array.from(new Set(routes)).slice(0, 6);
}

function stripPageHtml(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * Fast build check on main after a merge wave. Catches "looks good but does
 * not compile" merges immediately instead of at the final acceptance gate.
 * On failure the merging PR's owner gets a revision with the build output.
 */
export async function runIncrementalBuildGate(run: MissionRun, mergedPrIds: number[]) {
  const workspace = workspaceOf(run);
  const projectType = workspace.projectType ?? "generic";
  if (!["nextjs", "react-vite", "express-api", "node-cli"].includes(projectType)) {
    return { ok: true, skipped: true };
  }

  appendEvent(run, "Runtime QA started incremental build check on main after merge wave", "info");
  const checks: RuntimeAcceptanceResult["checks"] = [];
  if (!existsSync(resolve(workspace.repoDir, "node_modules"))) {
    checks.push(runCommandCheck(workspace.repoDir, "npm install --package-lock=false", ["install", "--package-lock=false"]));
  }
  checks.push(runCommandCheck(workspace.repoDir, "npm run build", ["run", "build"]));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    appendEvent(run, "Incremental build check passed on main", "success");
    return { ok: true, checks };
  }

  const findings = failed.map((check) => `${check.name} failed after merge: ${check.output.slice(0, 600)}`);
  const mergedPrs = run.state.pullRequests.filter((pr) => mergedPrIds.includes(pr.id));
  const owners = Array.from(new Set(mergedPrs.map((pr) => pr.ownerAgentId)));
  postBookEntry(run, {
    type: "conflict",
    fromAgentId: "mastermind-agent",
    toAgentIds: owners,
    scope: "mission",
    visibility: owners.length > 0 ? "mentioned" : "global",
    topics: ["build-break", "runtime", "merge", ...mergedPrs.map((pr) => pr.branch)],
    priority: "urgent",
    status: "open",
    message: [
      `The main branch stopped building after merging PR${mergedPrIds.length === 1 ? "" : "s"} ${mergedPrIds.map((id) => `#${id}`).join(", ")}.`,
      ...findings.map((finding) => `- ${finding}`),
      "The merging owner(s) must fix the build in a revision before further merges land on a broken main."
    ].join("\n")
  });

  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((pr) => mergedPrIds.includes(pr.id)
      ? {
          ...pr,
          status: "Changes requested",
          reviewerStatus: "Requested changes",
          comments: [...pr.comments, `Build broke on main after this merge: ${findings[0]?.slice(0, 200)}`].slice(-6)
        }
      : pr),
    tasks: run.state.tasks.map((task) => owners.includes(task.ownerAgentId) ? { ...task, status: "blocked" } : task),
    agents: run.state.agents.map((agent) => owners.includes(agent.id)
      ? { ...agent, status: "blocked", currentActivity: "Fixing post-merge build break" }
      : agent)
  };
  appendEvent(run, `Incremental build check failed after merge wave: ${findings[0]?.slice(0, 160)}`, "warning");
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return { ok: false, checks, findings };
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

