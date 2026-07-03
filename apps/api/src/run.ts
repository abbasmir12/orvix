import type { ServerResponse } from "node:http";
import {
  advanceMissionState,
  appendRunEvent,
  appendTimelineEvent,
  applySimulationStep,
  simulationSteps,
  writeReasoningArtifact,
  writeStateSnapshot,
  type ReasoningArtifact,
  type RunStore,
  type SimulationState,
  type TimelineEvent
} from "@orvix/core";
import { normalizeOrvixMap, setQwenUsageListener, type OrvixMap, type QwenPlanningResearchRequest, type QwenUsageEvent } from "@orvix/qwen";
import type { Workspace } from "@orvix/workspace";
import { envPositiveInt } from "./envConfig.js";

export type PlanningStageId =
  | "research"
  | "council"
  | "scaffold"
  | "analysis"
  | "orvix_map"
  | "organization"
  | "rubric";

export type PlanningStageStatus = "started" | "completed" | "degraded" | "failed";

export type PlanningStageEvent = {
  stage: PlanningStageId;
  status: PlanningStageStatus;
  detail?: string;
  elapsedMs?: number;
  at: string;
};

export type MissionMode = "mock" | "qwen" | "solo";

export type RunMetrics = {
  qwenCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalQwenDurationMs: number;
  callsByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
  startedAt: number;
  completedAt?: number;
};

export function createRunMetrics(): RunMetrics {
  return {
    qwenCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalQwenDurationMs: 0,
    callsByRole: {},
    tokensByRole: {},
    startedAt: Date.now()
  };
}

export type MissionRun = {
  id: string;
  mission: string;
  mode: MissionMode;
  state: SimulationState;
  stepIndex: number;
  orchestratorTimer?: NodeJS.Timeout;
  reasoningArtifacts: ReasoningArtifact[];
  store: RunStore;
  /** Created by the planning pipeline after the scaffold decision; absent while planning runs. */
  workspace?: Workspace;
  planningStages: PlanningStageEvent[];
  subscribers: Set<ServerResponse>;
  progressTimer: NodeJS.Timeout;
  stepTimer?: NodeJS.Timeout;
  autopilotActive?: boolean;
  autoAutopilotStarted?: boolean;
  qwenPlanningComplete?: boolean;
  metrics: RunMetrics;
};

/** Qwen mode and its solo-baseline variant both use real multi-turn agent sessions. */
export function usesQwenReasoning(run: MissionRun) {
  return run.mode === "qwen" || run.mode === "solo";
}

/** Workspace accessor for post-planning code paths; HTTP routes must 409 before reaching here. */
export function workspaceOf(run: MissionRun): Workspace {
  if (!run.workspace) {
    throw new Error("workspace_not_ready: mission planning has not created the workspace yet");
  }
  return run.workspace;
}

export function recordPlanningStage(
  run: MissionRun,
  stage: PlanningStageId,
  status: PlanningStageStatus,
  detail?: string,
  elapsedMs?: number
) {
  const event: PlanningStageEvent = {
    stage,
    status,
    detail: detail?.slice(0, 400),
    elapsedMs,
    at: new Date().toISOString()
  };
  run.planningStages.push(event);
  broadcast(run, "planning", event);
  return event;
}

/** Runs a planning stage with timing and honest degraded/failed reporting. */
export async function runPlanningStage<T>(
  run: MissionRun,
  stage: PlanningStageId,
  work: () => Promise<T>,
  options: { detail?: string; degradedDetail?: (error: unknown) => string } = {}
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  recordPlanningStage(run, stage, "started", options.detail);
  const startedAt = Date.now();
  try {
    const value = await work();
    recordPlanningStage(run, stage, "completed", undefined, Date.now() - startedAt);
    return { ok: true, value };
  } catch (error) {
    const message = options.degradedDetail
      ? options.degradedDetail(error)
      : error instanceof Error ? error.message : "Unknown planning error";
    recordPlanningStage(run, stage, "degraded", message, Date.now() - startedAt);
    return { ok: false, error };
  }
}

export type PlanningResearchResult = {
  request: QwenPlanningResearchRequest;
  queryResults: unknown[];
  fetchedUrls: unknown[];
  fallback?: boolean;
  error?: string;
};

export const runs = new Map<string, MissionRun>();
export const port = Number(process.env.PORT ?? 8787);
export const reviewAttemptLimit = 50;
export const agentExecutionToolCallLimit = 32;

export function schedulerConcurrency(run: MissionRun, kind: "execution" | "revision" | "review") {
  if (!usesQwenReasoning(run)) return 4;
  if (kind === "execution") return envPositiveInt("QWEN_EXECUTION_CONCURRENCY", 4, 8);
  if (kind === "revision") return envPositiveInt("QWEN_REVISION_CONCURRENCY", 3, 8);
  return envPositiveInt("QWEN_REVIEW_CONCURRENCY", 2, 8);
}

/** Attributes every Qwen usage event tagged with a runId (via withQwenUsageRun) to that run's metrics. */
setQwenUsageListener((event: QwenUsageEvent) => {
  if (!event.runId) return;
  const run = runs.get(event.runId);
  if (!run) return;
  const metrics = run.metrics;
  metrics.qwenCalls += 1;
  metrics.promptTokens += event.promptTokens;
  metrics.completionTokens += event.completionTokens;
  metrics.totalTokens += event.totalTokens;
  metrics.totalQwenDurationMs += event.durationMs;
  metrics.callsByRole[event.role] = (metrics.callsByRole[event.role] ?? 0) + 1;
  metrics.tokensByRole[event.role] = (metrics.tokensByRole[event.role] ?? 0) + event.totalTokens;
});

function countFilesWritten(run: MissionRun) {
  const paths = new Set<string>();
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || !artifact.content) continue;
    try {
      const parsed = JSON.parse(artifact.content) as {
        plan?: { toolCalls?: Array<{ tool?: string; path?: string }> };
      };
      for (const call of parsed.plan?.toolCalls ?? []) {
        if (call.tool === "write_file" && call.path) paths.add(call.path);
      }
    } catch {
      // best-effort metric; malformed artifact content is skipped
    }
  }
  return paths.size;
}

export function metricsSummary(run: MissionRun) {
  const metrics = run.metrics;
  const wallClockMs = (metrics.completedAt ?? Date.now()) - metrics.startedAt;
  return {
    missionId: run.id,
    mode: run.mode,
    isComplete: run.state.isComplete,
    wallClockMs,
    qwenCalls: metrics.qwenCalls,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    totalTokens: metrics.totalTokens,
    totalQwenDurationMs: metrics.totalQwenDurationMs,
    callsByRole: metrics.callsByRole,
    tokensByRole: metrics.tokensByRole,
    agents: run.state.agents.length,
    tasks: run.state.tasks.length,
    tasksCompleted: run.state.tasks.filter((task) => task.status === "completed").length,
    pullRequests: run.state.pullRequests.length,
    pullRequestsApproved: run.state.pullRequests.filter((pr) => pr.status === "Approved").length,
    filesWritten: countFilesWritten(run),
    reviewComments: run.state.pullRequests.reduce((sum, pr) => sum + pr.comments.length, 0)
  };
}

export function writeSse(response: ServerResponse, event: string, data: unknown) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(run: MissionRun, event: string, data: unknown) {
  for (const subscriber of run.subscribers) {
    writeSse(subscriber, event, data);
  }
}

export function latestEvent(state: SimulationState): TimelineEvent | null {
  return state.events[state.events.length - 1] ?? null;
}

export function appendEvent(run: MissionRun, message: string, severity: TimelineEvent["severity"]) {
  run.state = appendTimelineEvent(run.state, message, severity);
  const event = latestEvent(run.state);
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  if (event) {
    appendRunEvent(run.store, event);
    broadcast(run, "timeline", event);
  }
}

export function addReasoningArtifact(
  run: MissionRun,
  artifact: Omit<ReasoningArtifact, "id" | "createdAt">
) {
  const nextArtifact: ReasoningArtifact = {
    id: `reasoning-${run.reasoningArtifacts.length + 1}`,
    createdAt: new Date().toISOString(),
    ...artifact
  };
  nextArtifact.artifactPath = writeReasoningArtifact(run.store, nextArtifact);

  run.reasoningArtifacts.push(nextArtifact);
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "reasoning", nextArtifact);
}

export function orvixMapContext(run: MissionRun): OrvixMap | null {
  for (const artifact of [...run.reasoningArtifacts].reverse()) {
    if (artifact.kind !== "orvix_map" || !artifact.content) continue;
    try {
      return normalizeOrvixMap(JSON.parse(artifact.content) as Partial<OrvixMap>, {
        mission: run.mission,
        productType: run.state.analysis.projectType
      });
    } catch {
      continue;
    }
  }
  return null;
}

export function mapWorkPacketForAgent(run: MissionRun, agentId: string, taskId?: string) {
  const map = orvixMapContext(run);
  if (!map) return null;
  const agent = run.state.agents.find((candidate) => candidate.id === agentId);
  const task = taskId ? run.state.tasks.find((candidate) => candidate.id === taskId) : undefined;
  const haystack = `${agent?.id ?? ""} ${agent?.name ?? ""} ${agent?.role ?? ""} ${task?.title ?? ""} ${task?.acceptanceCriteria?.join(" ") ?? ""}`.toLowerCase();
  const packets = map.agentWorkPackets.filter((packet) => packet && typeof packet === "object");
  const matchesHaystack = (value: unknown) => {
    const text = String(value ?? "").toLowerCase().trim();
    return text.length > 0 && haystack.includes(text);
  };
  return packets.find((packet) =>
    matchesHaystack(packet.id) ||
    matchesHaystack(packet.suggestedAgentRole) ||
    (packet.owns ?? []).some(matchesHaystack)
  ) ?? packets.find((packet) =>
    String(packet.suggestedAgentRole ?? "").toLowerCase().split(/\s+/).some((word) => word.length > 4 && haystack.includes(word))
  ) ?? null;
}

export function scheduleOrchestratorStep(run: MissionRun) {
  if (run.state.isComplete) {
    clearInterval(run.progressTimer);
    broadcast(run, "complete", {
      missionId: run.id,
      status: "completed_orchestration"
    });
    return;
  }

  run.orchestratorTimer = setTimeout(() => {
    run.state = advanceMissionState(run.state);
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);

    const event = latestEvent(run.state);
    if (event) {
      appendRunEvent(run.store, event);
      broadcast(run, "timeline", event);
    }

    scheduleOrchestratorStep(run);
  }, run.stepIndex++ === 0 ? 900 : 1600);
}

export function scheduleNextStep(run: MissionRun) {
  if (run.stepIndex >= simulationSteps.length) {
    return;
  }

  run.stepTimer = setTimeout(() => {
    const step = simulationSteps[run.stepIndex];
    run.state = applySimulationStep(run.state, step, run.stepIndex);
    run.stepIndex += 1;
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);

    broadcast(run, "state", run.state);
    const event = latestEvent(run.state);
    if (event) {
      appendRunEvent(run.store, event);
      broadcast(run, "timeline", event);
    }

    if (run.state.isComplete) {
      clearInterval(run.progressTimer);
      broadcast(run, "complete", {
        missionId: run.id,
        status: "completed_simulation"
      });
      return;
    }

    scheduleNextStep(run);
  }, run.stepIndex === 0 ? 900 : 1600);
}

export function runSummary(run: MissionRun) {
  return {
    id: run.id,
    mission: run.mission,
    mode: run.mode,
    phase: run.state.phase,
    isComplete: run.state.isComplete,
    agents: run.state.agents.length,
    pullRequests: run.state.pullRequests.length,
    events: run.state.events.length,
    reasoningArtifacts: run.reasoningArtifacts.length,
    runDir: run.store.runDir,
    workspaceDir: run.workspace?.repoDir ?? null,
    planning: run.planningStages.at(-1) ?? null
  };
}

export function stopScriptedTimers(run: MissionRun) {
  if (run.stepTimer) {
    clearTimeout(run.stepTimer);
    run.stepTimer = undefined;
  }

  if (run.orchestratorTimer) {
    clearTimeout(run.orchestratorTimer);
    run.orchestratorTimer = undefined;
  }
}

