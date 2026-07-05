export * from "@orvix/core/types";

/** Mirrors the API's PlanningStageEvent (apps/api/src/run.ts) sent over the "planning" SSE event. */
export type PlanningStageId = "research" | "council" | "scaffold" | "analysis" | "orvix_map" | "organization" | "rubric";
export type PlanningStageStatus = "started" | "completed" | "degraded" | "failed";
export type PlanningStageEvent = {
  stage: PlanningStageId;
  status: PlanningStageStatus;
  detail?: string;
  elapsedMs?: number;
  at: string;
};

/** Mirrors the API's broadcastAgentTurn payload (apps/api/src/agentRuntime.ts) sent over the "agent_turn" SSE event. */
export type AgentTurnEvent = {
  missionId: string;
  agentId: string;
  agentName: string;
  taskId: string;
  branch: string;
  turn: number;
  at: string;
  kind: "note" | "tool" | "harness" | "compaction";
  tool?: string;
  path?: string;
  ok?: boolean;
  detail?: string;
  context?: { promptTokens: number; windowTokens: number; percent: number };
};

/** One resumable run from GET /missions/disk. */
export type DiskRunSummary = {
  missionId: string;
  mission: string;
  mode: string;
  createdAt: string;
  isComplete: boolean;
  inMemory: boolean;
};

/** Mirrors the API's metricsSummary payload (apps/api/src/run.ts) served at GET /missions/:id/metrics. */
export type RunMetricsSummary = {
  missionId: string;
  mode: string;
  isComplete: boolean;
  wallClockMs: number;
  qwenCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalQwenDurationMs: number;
  callsByRole: Record<string, number>;
  tokensByRole: Record<string, number>;
  agents: number;
  tasks: number;
  tasksCompleted: number;
  pullRequests: number;
  pullRequestsApproved: number;
  filesWritten: number;
  reviewComments: number;
};
