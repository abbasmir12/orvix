#!/usr/bin/env node
// Runs the same mission in "solo" (single-agent baseline) and "qwen"
// (Orvix Agent Society) mode against a running Orvix API, waits for both
// to finish, and writes a comparison report for the hackathon submission.
//
// Usage: node scripts/benchmark.mjs "Build a 2D snake game in the browser"
//   [--api-url http://localhost:8787] [--timeout 900000] [--poll 4000]

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const mission = positional.join(" ").trim() ||
  "Build a 2D snake game in the browser with keyboard controls, score display, and game over screen";

function flagValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const apiUrl = flagValue("api-url", process.env.ORVIX_API_URL ?? "http://localhost:8787");
const timeoutMs = Number(flagValue("timeout", "900000"));
const pollMs = Number(flagValue("poll", "4000"));

async function postJson(path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function getJson(path) {
  const response = await fetch(`${apiUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMissionToCompletion(mode) {
  console.log(`\n[${mode}] starting mission: ${mission}`);
  const started = Date.now();
  const created = await postJson("/missions", { mission, mode });
  const missionId = created.missionId;
  console.log(`[${mode}] mission accepted: ${missionId}`);

  let lastPhase = "";
  while (Date.now() - started < timeoutMs) {
    const detail = await getJson(`/missions/${missionId}`);
    const phase = `${detail.summary.phase}${detail.summary.isComplete ? " (complete)" : ""}`;
    if (phase !== lastPhase) {
      console.log(`[${mode}] phase: ${phase} (t+${Math.round((Date.now() - started) / 1000)}s)`);
      lastPhase = phase;
    }
    if (detail.summary.isComplete) {
      const metrics = await getJson(`/missions/${missionId}/metrics`);
      return { missionId, detail, metrics, timedOut: false };
    }
    await sleep(pollMs);
  }

  console.warn(`[${mode}] timed out after ${timeoutMs}ms; capturing partial state`);
  const detail = await getJson(`/missions/${missionId}`);
  const metrics = await getJson(`/missions/${missionId}/metrics`);
  return { missionId, detail, metrics, timedOut: true };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function formatRow(label, solo, society) {
  return `| ${label} | ${solo} | ${society} |`;
}

async function main() {
  const health = await getJson("/health");
  if (health.qwen !== "configured") {
    throw new Error("Qwen is not configured on the API (DASHSCOPE_API_KEY missing); benchmark needs live Qwen calls for both modes.");
  }

  const solo = await runMissionToCompletion("solo");
  const society = await runMissionToCompletion("qwen");

  const soloMetrics = solo.metrics;
  const societyMetrics = society.metrics;

  const report = {
    mission,
    apiUrl,
    generatedAt: new Date().toISOString(),
    solo: { ...soloMetrics, timedOut: solo.timedOut },
    society: { ...societyMetrics, timedOut: society.timedOut },
    comparison: {
      wallClockSpeedup: soloMetrics.wallClockMs > 0
        ? Number((soloMetrics.wallClockMs / Math.max(societyMetrics.wallClockMs, 1)).toFixed(2))
        : null,
      soloFilesWritten: soloMetrics.filesWritten,
      societyFilesWritten: societyMetrics.filesWritten,
      soloQwenCalls: soloMetrics.qwenCalls,
      societyQwenCalls: societyMetrics.qwenCalls,
      soloTotalTokens: soloMetrics.totalTokens,
      societyTotalTokens: societyMetrics.totalTokens
    }
  };

  const reportDir = new URL("../.orvix/benchmarks/", import.meta.url);
  await import("node:fs/promises").then((fs) => fs.mkdir(reportDir, { recursive: true }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = new URL(`benchmark-${stamp}.json`, reportDir);
  const mdPath = new URL(`benchmark-${stamp}.md`, reportDir);
  const latestMdPath = new URL("benchmark-report.md", reportDir);

  const markdown = `# Orvix Benchmark: Solo Baseline vs Agent Society

**Mission:** ${mission}
**Generated:** ${report.generatedAt}
**API:** ${apiUrl}

| Metric | Solo (1 agent) | Orvix Society |
| --- | --- | --- |
${formatRow("Completed", solo.detail.summary.isComplete ? "yes" : `no (timed out)`, society.detail.summary.isComplete ? "yes" : "no (timed out)")}
${formatRow("Wall-clock time", `${Math.round(soloMetrics.wallClockMs / 1000)}s`, `${Math.round(societyMetrics.wallClockMs / 1000)}s`)}
${formatRow("Agents", soloMetrics.agents, societyMetrics.agents)}
${formatRow("Tasks completed", `${soloMetrics.tasksCompleted}/${soloMetrics.tasks}`, `${societyMetrics.tasksCompleted}/${societyMetrics.tasks}`)}
${formatRow("PRs approved", `${soloMetrics.pullRequestsApproved}/${soloMetrics.pullRequests}`, `${societyMetrics.pullRequestsApproved}/${societyMetrics.pullRequests}`)}
${formatRow("Files written", soloMetrics.filesWritten, societyMetrics.filesWritten)}
${formatRow("Review comment rounds", soloMetrics.reviewComments, societyMetrics.reviewComments)}
${formatRow("Qwen calls", soloMetrics.qwenCalls, societyMetrics.qwenCalls)}
${formatRow("Total tokens", soloMetrics.totalTokens, societyMetrics.totalTokens)}
${formatRow("Prompt / completion tokens", `${soloMetrics.promptTokens} / ${soloMetrics.completionTokens}`, `${societyMetrics.promptTokens} / ${societyMetrics.completionTokens}`)}

**Wall-clock speedup (solo time / society time): ${report.comparison.wallClockSpeedup ?? "n/a"}x**

Raw data: \`${jsonPath.pathname}\`
`;

  const fs = await import("node:fs/promises");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(mdPath, markdown);
  await fs.writeFile(latestMdPath, markdown);

  console.log(`\n${markdown}`);
  console.log(`Report written to ${mdPath.pathname} and ${latestMdPath.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
