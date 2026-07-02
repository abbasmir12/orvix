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
import { normalizeOrvixMap, type OrvixMap, type QwenPlanningResearchRequest } from "@orvix/qwen";
import type { Workspace } from "@orvix/workspace";
import { envPositiveInt } from "./envConfig.js";

export type MissionRun = {
  id: string;
  mission: string;
  mode: "mock" | "qwen";
  state: SimulationState;
  stepIndex: number;
  orchestratorTimer?: NodeJS.Timeout;
  reasoningArtifacts: ReasoningArtifact[];
  store: RunStore;
  workspace: Workspace;
  subscribers: Set<ServerResponse>;
  progressTimer: NodeJS.Timeout;
  stepTimer?: NodeJS.Timeout;
  autopilotActive?: boolean;
  autoAutopilotStarted?: boolean;
  qwenPlanningComplete?: boolean;
};

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
  if (run.mode !== "qwen") return 4;
  if (kind === "execution") return envPositiveInt("QWEN_EXECUTION_CONCURRENCY", 4, 8);
  if (kind === "revision") return envPositiveInt("QWEN_REVISION_CONCURRENCY", 3, 8);
  return envPositiveInt("QWEN_REVIEW_CONCURRENCY", 2, 8);
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
    workspaceDir: run.workspace.repoDir
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

