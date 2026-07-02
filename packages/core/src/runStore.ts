import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AgentSignal, OrvixBookEntry, ReasoningArtifact, SimulationState, TimelineEvent } from "./types.js";

export type RunStore = {
  rootDir: string;
  runDir: string;
  artifactsDir: string;
};

const safeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function createRunStore(missionId: string, root = process.cwd()): RunStore {
  const rootDir = resolve(root, ".orvix", "runs");
  const runDir = resolve(rootDir, missionId);
  const artifactsDir = resolve(runDir, "artifacts");

  mkdirSync(artifactsDir, { recursive: true });

  return {
    rootDir,
    runDir,
    artifactsDir
  };
}

export function writeRunManifest(store: RunStore, input: { missionId: string; mission: string; mode: string; createdAt: string }) {
  writeFileSync(resolve(store.runDir, "manifest.json"), pretty(input), "utf8");
}

export function writeStateSnapshot(store: RunStore, state: SimulationState, reasoningArtifacts: ReasoningArtifact[] = []) {
  writeFileSync(resolve(store.runDir, "state.json"), pretty({
    state,
    reasoningArtifacts: reasoningArtifacts.map(snapshotReasoningArtifact)
  }), "utf8");
}

export function appendRunEvent(store: RunStore, event: TimelineEvent) {
  appendFileSync(resolve(store.runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export function appendBookEntry(store: RunStore, entry: OrvixBookEntry) {
  appendFileSync(resolve(store.runDir, "book.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export function appendAgentSignal(store: RunStore, signal: AgentSignal) {
  appendFileSync(resolve(store.runDir, "signals.jsonl"), `${JSON.stringify(signal)}\n`, "utf8");
}

export function writeReasoningArtifact(store: RunStore, artifact: ReasoningArtifact) {
  const filename = artifact.kind === "agent_execution" || artifact.kind === "pr_review"
    ? `${safeName(artifact.kind)}-${safeName(artifact.id)}.json`
    : `${safeName(artifact.kind)}.json`;
  const absolutePath = resolve(store.artifactsDir, filename);
  const payload = artifact.content
    ? parseArtifactContent(artifact.content) ?? artifact.content
    : { error: artifact.error ?? "No artifact content" };

  writeFileSync(absolutePath, pretty({
    id: artifact.id,
    kind: artifact.kind,
    status: artifact.status,
    createdAt: artifact.createdAt,
    reasoningContent: artifact.reasoningContent,
    payload
  }), "utf8");

  return relative(process.cwd(), absolutePath);
}

export function writeTaskGraphArtifact(store: RunStore, state: SimulationState) {
  const absolutePath = resolve(store.artifactsDir, "task-graph.json");
  writeFileSync(absolutePath, pretty({
    tasks: state.tasks,
    pullRequests: state.pullRequests,
    agentCalls: state.agentCalls
  }), "utf8");

  return relative(process.cwd(), absolutePath);
}

function parseArtifactContent(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function snapshotReasoningArtifact(artifact: ReasoningArtifact): ReasoningArtifact {
  return {
    ...artifact,
    content: artifact.content ? summarizeArtifactContent(artifact.content) : undefined,
    reasoningContent: artifact.reasoningContent ? summarizeText(artifact.reasoningContent, 1000) : undefined
  };
}

function summarizeArtifactContent(content: string) {
  const parsed = parseArtifactContent(content);
  if (!parsed || typeof parsed !== "object") {
    return summarizeText(content, 2000);
  }

  const record = parsed as Record<string, unknown>;
  return JSON.stringify({
    agent: record.agent,
    task: record.task,
    revision: record.revision,
    revisionNumber: record.revisionNumber,
    scaffold: record.scaffold,
    decision: record.decision,
    runtimeAcceptance: record.runtimeAcceptance,
    resultCount: Array.isArray(record.results) ? record.results.length : undefined,
    summary: record.summary
  });
}

function summarizeText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}... [truncated in state snapshot; full artifact is stored separately]`;
}
