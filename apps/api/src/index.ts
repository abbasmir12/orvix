import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  advanceMissionState,
  type Agent,
  type AgentExecutionPlan,
  type AgentToolCall,
  type AgentToolName,
  type AgentSignal,
  appendAgentSignal,
  appendBookEntry,
  appendTimelineEvent,
  appendRunEvent,
  applyMissionAnalysis,
  applyOrganizationDesign,
  applySimulationStep,
  createRunStore,
  createInitialSimulation,
  nudgeActiveProgress,
  simulationSteps,
  writeReasoningArtifact,
  writeRunManifest,
  writeStateSnapshot,
  writeTaskGraphArtifact,
  type OrganizationDesign,
  type OrvixBookEntry,
  type OrvixBookEntryType,
  type OrvixBookPriority,
  type OrvixBookScope,
  type OrvixBookVisibility,
  type PullRequest,
  type PullRequestReviewDecision,
  type QwenMissionAnalysis,
  type ReasoningArtifact,
  type RunStore,
  type SimulationState,
  type TimelineEvent
} from "@orvix/core";
import {
  createQwenConfig,
  isQwenConfigured,
  normalizeOrvixMap,
  QwenClient,
  type OrvixMap,
  type QwenPlanningCouncilDraft,
  type QwenPlanningResearchRequest,
  type QwenProjectScaffoldDecision
} from "@orvix/qwen";
import {
  branchExists,
  checkoutGitBranch,
  commitWorkspaceChanges,
  createGitBranch,
  createMissionWorkspace,
  ensureAgentWorktree,
  getBranchDiff,
  getGitStatus,
  getWorkspaceDiff,
  listWorkspaceFiles,
  mergeWorkspaceBranch,
  readWorkspaceFile,
  deleteWorkspacePath,
  syncWorkspaceBranch,
  writeWorkspaceFile,
  type Workspace,
  type ProjectScaffoldType
} from "@orvix/workspace";

function findEnvFile(start = process.cwd()) {
  let current = resolve(start);

  while (true) {
    const candidate = resolve(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function loadEnvFile(path = findEnvFile()) {
  if (!path) {
    return;
  }

  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();
const projectRoot = dirname(findEnvFile() ?? resolve(process.cwd(), ".env"));
const workspaceRoot = resolve(projectRoot, ".orvix", "workspaces");

type MissionRun = {
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

type PlanningResearchResult = {
  request: QwenPlanningResearchRequest;
  queryResults: unknown[];
  fetchedUrls: unknown[];
  fallback?: boolean;
  error?: string;
};

const runs = new Map<string, MissionRun>();
const port = Number(process.env.PORT ?? 8787);
const reviewAttemptLimit = 50;
const agentExecutionToolCallLimit = 32;

function envPositiveInt(name: string, fallback: number, max = 20) {
  const value = Number(process.env[name] ?? "");
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

function schedulerConcurrency(run: MissionRun, kind: "execution" | "revision" | "review") {
  if (run.mode !== "qwen") return 4;
  if (kind === "execution") return envPositiveInt("QWEN_EXECUTION_CONCURRENCY", 4, 8);
  if (kind === "revision") return envPositiveInt("QWEN_REVISION_CONCURRENCY", 3, 8);
  return envPositiveInt("QWEN_REVIEW_CONCURRENCY", 2, 8);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(body, null, 2));
}

function notFound(response: ServerResponse) {
  sendJson(response, 404, { error: "not_found" });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function writeSse(response: ServerResponse, event: string, data: unknown) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(run: MissionRun, event: string, data: unknown) {
  for (const subscriber of run.subscribers) {
    writeSse(subscriber, event, data);
  }
}

function latestEvent(state: SimulationState): TimelineEvent | null {
  return state.events[state.events.length - 1] ?? null;
}

function appendEvent(run: MissionRun, message: string, severity: TimelineEvent["severity"]) {
  run.state = appendTimelineEvent(run.state, message, severity);
  const event = latestEvent(run.state);
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  if (event) {
    appendRunEvent(run.store, event);
    broadcast(run, "timeline", event);
  }
}

function addReasoningArtifact(
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

function postBookEntry(run: MissionRun, input: {
  type: OrvixBookEntryType;
  fromAgentId: string;
  message: string;
  toAgentIds?: string[];
  scope?: OrvixBookScope;
  visibility?: OrvixBookVisibility;
  taskId?: string;
  prId?: number;
  replyTo?: string;
  topics?: string[];
  priority?: OrvixBookPriority;
  status?: OrvixBookEntry["status"];
}) {
  const topics = normalizeTopics(input.topics ?? inferTopics(input.message));
  const routedAgentIds = input.visibility === "global" && !input.toAgentIds?.length
    ? []
    : routeBookEntry(run, input.toAgentIds ?? [], topics, input.fromAgentId);
  const entry: OrvixBookEntry = {
    id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: input.type,
    scope: input.scope ?? (input.taskId ? "task" : "mission"),
    visibility: input.visibility ?? (routedAgentIds.length > 0 ? "mentioned" : "global"),
    fromAgentId: input.fromAgentId,
    toAgentIds: routedAgentIds,
    taskId: input.taskId,
    prId: input.prId,
    replyTo: input.replyTo,
    topics,
    message: input.message,
    status: input.status ?? (input.type === "question" ? "open" : input.type === "contract" || input.type === "decision" ? "final" : "resolved"),
    priority: input.priority ?? "normal",
    createdAt: new Date().toISOString()
  };

  run.state = {
    ...run.state,
    bookEntries: [...run.state.bookEntries, entry].slice(-200)
  };

  appendBookEntry(run.store, entry);
  for (const toAgentId of routedAgentIds) {
    createAgentSignal(run, {
      toAgentId,
      fromAgentId: input.fromAgentId,
      bookEntryId: entry.id,
      type: signalTypeForEntry(entry),
      message: `${agentName(run, input.fromAgentId)} posted ${entry.type}: ${entry.message.slice(0, 120)}`
    });
  }

  if (input.replyTo) {
    run.state = {
      ...run.state,
      bookEntries: run.state.bookEntries.map((candidate) => candidate.id === input.replyTo
        ? { ...candidate, status: "answered" }
        : candidate)
    };
  }

  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  broadcast(run, "book", entry);
  return entry;
}

function normalizeBookEntryType(type: unknown): OrvixBookEntryType {
  const allowed: OrvixBookEntryType[] = [
    "question",
    "answer",
    "note",
    "assumption",
    "proposal",
    "decision",
    "conflict",
    "contract",
    "handoff",
    "review_note"
  ];

  return allowed.includes(type as OrvixBookEntryType) ? type as OrvixBookEntryType : "note";
}

function createAgentSignal(run: MissionRun, input: Omit<AgentSignal, "id" | "status" | "createdAt">) {
  const signal: AgentSignal = {
    id: `signal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: "unread",
    createdAt: new Date().toISOString(),
    ...input
  };

  run.state = {
    ...run.state,
    agentSignals: [...run.state.agentSignals, signal].slice(-300)
  };
  appendAgentSignal(run.store, signal);
  broadcast(run, "signal", signal);
  return signal;
}

function getBookContext(run: MissionRun, agentId: string, taskId?: string) {
  const unreadSignals = run.state.agentSignals.filter((signal) => signal.toAgentId === agentId && signal.status === "unread");
  const signalEntryIds = new Set(unreadSignals.map((signal) => signal.bookEntryId));
  const relevantEntries = run.state.bookEntries.filter((entry) =>
    entry.visibility === "global" ||
    entry.fromAgentId === agentId ||
    entry.toAgentIds.includes(agentId) ||
    signalEntryIds.has(entry.id) ||
    Boolean(taskId && entry.taskId === taskId) ||
    entry.type === "decision" ||
    entry.type === "contract" ||
    entry.status === "open"
  );

  return {
    entries: relevantEntries.slice(-25),
    unreadSignals: unreadSignals.slice(-12),
    ownershipIndex: run.state.ownershipIndex
  };
}

function markSignalRead(run: MissionRun, input: { signalId?: string; entryId?: string }, agentId: string) {
  let changed = 0;
  run.state = {
    ...run.state,
    agentSignals: run.state.agentSignals.map((signal) => {
      const belongsToAgent = signal.toAgentId === agentId;
      const matchesSignal = Boolean(input.signalId && signal.id === input.signalId);
      const matchesEntry = Boolean(input.entryId && signal.bookEntryId === input.entryId);
      const matchesImplicitUnread = !input.signalId && !input.entryId && signal.status === "unread";
      if (belongsToAgent && signal.status !== "read" && (matchesSignal || matchesEntry || matchesImplicitUnread)) {
        changed += 1;
        return { ...signal, status: "read" };
      }
      return signal;
    })
  };
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return changed;
}

function routeBookEntry(run: MissionRun, explicitAgentIds: string[], topics: string[], fromAgentId: string) {
  const routed = new Set(explicitAgentIds.filter((agentId) => agentId !== fromAgentId));
  for (const topic of topics) {
    for (const agentId of run.state.ownershipIndex[topic] ?? []) {
      if (agentId !== fromAgentId) {
        routed.add(agentId);
      }
    }
  }
  return Array.from(routed).slice(0, 6);
}

function inferTopics(message: string) {
  return message
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length > 3)
    .slice(0, 8);
}

function normalizeTopics(topics: string[]) {
  return Array.from(new Set(topics.map((topic) =>
    topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  ).filter(Boolean))).slice(0, 12);
}

function signalTypeForEntry(entry: OrvixBookEntry): AgentSignal["type"] {
  if (entry.type === "answer") return "answer";
  if (entry.type === "conflict") return "conflict";
  if (entry.type === "decision") return "decision";
  if (entry.type === "review_note") return "review";
  if (entry.type === "contract") return "contract_update";
  return "mention";
}

function normalizeBookPriority(value: unknown): OrvixBookPriority {
  const allowed: OrvixBookPriority[] = ["low", "normal", "high", "urgent"];
  return allowed.includes(value as OrvixBookPriority) ? value as OrvixBookPriority : "normal";
}

function agentName(run: MissionRun, agentId: string) {
  return run.state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

function planningBookContext(run: MissionRun) {
  return run.state.bookEntries
    .filter((entry) => entry.scope === "mission" && entry.createdAt)
    .slice(-20)
    .map((entry) => ({
      type: entry.type,
      fromAgentId: entry.fromAgentId,
      topics: entry.topics,
      message: entry.message,
      priority: entry.priority,
      status: entry.status
    }));
}

function planningResearchContext(run: MissionRun) {
  for (const artifact of [...run.reasoningArtifacts].reverse()) {
    if (artifact.kind !== "mission_analysis") continue;
    if (!artifact.content) continue;
    try {
      const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
      if (parsed.source === "qwen_planning_research") {
        return parsed.planningResearch ?? parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function scaffoldContext(run: MissionRun) {
  for (const artifact of [...run.reasoningArtifacts].reverse()) {
    if (artifact.kind !== "agent_execution" || !artifact.content) continue;
    try {
      const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
      if (parsed.scaffold) {
        return parsed.scaffold;
      }
    } catch {
      continue;
    }
  }
  return {
    type: run.workspace.projectType ?? "generic",
    files: []
  };
}

function orvixMapContext(run: MissionRun): OrvixMap | null {
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

function mapWorkPacketForAgent(run: MissionRun, agentId: string, taskId?: string) {
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

function createEmergencyOrvixMap(run: MissionRun, reason: string): OrvixMap {
  const scaffold = scaffoldContext(run) as Record<string, unknown>;
  const projectType = String(run.state.analysis.projectType ?? scaffold.type ?? "software-project");
  const isReactLike = /react|vite|next|web|game|frontend|ui|dashboard/i.test(`${projectType} ${run.mission} ${String(scaffold.type ?? "")}`);
  const entryFile = String(scaffold.type ?? "").includes("nextjs") ? "app/page.tsx" : isReactLike ? "src/App.tsx" : "src/index.ts";
  const surfaceType = /api|backend|server/i.test(projectType) ? "endpoint" : /cli|command/i.test(projectType) ? "command" : isReactLike ? "route" : "module";

  return {
    version: "1.0-emergency",
    status: "locked",
    mission: run.mission,
    productType: projectType,
    mapSummary: `Emergency Orvix Map locked after blueprint generation failed: ${reason}. Agents must build a coherent ${projectType} inside the selected scaffold and avoid unrelated placeholder output.`,
    surfaces: [
      {
        id: "surface-primary",
        type: surfaceType,
        path: surfaceType === "route" ? "/" : undefined,
        name: "Primary Product Surface",
        purpose: "Main user-facing or callable surface that proves the mission works end to end.",
        sections: [
          {
            id: "section-primary-experience",
            name: "Primary Experience",
            purpose: "Mission-specific visible/callable functionality with no scaffold placeholder content.",
            components: [
              {
                id: "component-primary-entry",
                name: "PrimaryEntry",
                fileHint: entryFile,
                purpose: "Wires the main product experience into the runnable scaffold.",
                elements: [
                  {
                    id: "primary-output",
                    type: isReactLike ? "screen" : "module",
                    testId: "primary-output",
                    contentRule: "Shows or exposes mission-specific behavior, not generic starter text.",
                    behavior: "Provides the central product interaction from start to finish."
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    systems: [
      {
        id: "system-runtime-core",
        name: "Runtime Core",
        purpose: "Owns the main state, behavior, and execution loop needed for the requested product.",
        fileHints: [entryFile, "src/lib/runtime.ts", "src/types.ts"],
        contracts: run.state.analysis.successCriteria.slice(0, 5)
      },
      {
        id: "system-quality-gates",
        name: "Quality Gates",
        purpose: "Verifies build, runtime behavior, and removal of unrelated scaffold content.",
        fileHints: ["package.json", "README.md"],
        contracts: ["Build command must pass", "Visible output must match mission", "No wrong-domain files should remain"]
      }
    ],
    designSystem: {
      theme: isReactLike ? "mission-specific polished interface" : "clear developer-facing interface",
      colors: {},
      typography: {},
      motion: [],
      layoutRules: ["Use the selected scaffold entry points", "Keep the primary experience visible or callable immediately"]
    },
    dataContracts: [],
    interactionContracts: [
      {
        id: "interaction-primary-flow",
        trigger: "User opens/runs the generated project",
        response: "The requested product starts with mission-specific behavior and can be exercised end to end.",
        ownerHint: "Primary Implementation Specialist"
      }
    ],
    agentWorkPackets: [
      {
        id: "packet-primary-product",
        suggestedAgentRole: "Primary Implementation Specialist",
        owns: ["surface-primary", "system-runtime-core"],
        mustCreateOrUpdate: [entryFile, "src/lib/runtime.ts"],
        acceptance: run.state.analysis.successCriteria.slice(0, 5),
        coordinationNotes: ["Publish assumptions in Orvix Book if details are missing from this emergency map."]
      },
      {
        id: "packet-runtime-qa",
        suggestedAgentRole: "Runtime QA Specialist",
        owns: ["system-quality-gates"],
        mustCreateOrUpdate: ["README.md"],
        acceptance: ["Build passes", "No scaffold placeholders remain", "Main flow satisfies mission criteria"],
        coordinationNotes: ["Review against the emergency Orvix Map and mission analysis."]
      }
    ],
    acceptanceGates: [
      ...run.state.analysis.successCriteria.slice(0, 6),
      "Selected scaffold build command passes",
      "No unrelated wrong-domain scaffold content remains"
    ],
    forbiddenOutputs: [
      "Wrong framework layout for the selected scaffold",
      "Unrelated CRM/dashboard/game/domain files",
      "Only documentation with no runnable product changes",
      "Visible scaffold placeholder content as the final app"
    ],
    openQuestions: []
  };
}

async function bootstrapQwenReasoning(run: MissionRun) {
  if (!isQwenConfigured()) {
    appendEvent(run, "Qwen reasoning skipped: DASHSCOPE_API_KEY is missing", "warning");
    scheduleOrchestratorStep(run);
    return;
  }

  const client = new QwenClient();
  appendEvent(run, "Qwen reasoning layer connected to MasterMind Agent", "success");
  let organizationDesign: OrganizationDesign | null = null;
  const planningResearch = planningResearchContext(run);
  let lockedOrvixMap: OrvixMap | null = null;

  try {
    appendEvent(run, "MasterMind analysis started with Qwen using planning research", "info");
    const missionAnalysis = await client.analyzeMissionJson(run.mission, planningResearch);
    const appliedMissionAnalysis: Partial<SimulationState["analysis"]> = {
      projectType: missionAnalysis.projectType,
      complexity: missionAnalysis.complexity,
      primaryGoal: missionAnalysis.summary,
      features: missionAnalysis.features,
      risks: missionAnalysis.risks,
      successCriteria: missionAnalysis.successCriteria,
      strategy: "Qwen-generated organization + orchestrated task execution"
    };
    run.state = applyMissionAnalysis(run.state, appliedMissionAnalysis);
    addReasoningArtifact(run, {
      kind: "mission_analysis",
      status: "completed",
      content: JSON.stringify(missionAnalysis)
    });
    postBookEntry(run, {
      type: "decision",
      fromAgentId: "mastermind-agent",
      message: `MasterMind analysis: ${missionAnalysis.summary} Project type: ${missionAnalysis.projectType}. Success criteria: ${missionAnalysis.successCriteria.join("; ")}.`,
      scope: "mission",
      visibility: "global",
      topics: ["mission-analysis", "success-criteria", missionAnalysis.projectType],
      priority: "high",
      status: "final"
    });
    appendEvent(run, "Qwen MasterMind returned mission analysis", "success");
  } catch (error) {
    addReasoningArtifact(run, {
      kind: "mission_analysis",
      status: "completed",
      content: JSON.stringify({
        fallback: true,
        stage: "mission_analysis",
        error: error instanceof Error ? error.message : "Unknown Qwen error",
        analysis: run.state.analysis
      })
    });
    appendEvent(run, "Qwen mission analysis failed; continuing with mock planner", "warning");
  }

  try {
    appendEvent(run, "Blueprint Architect started Orvix Map draft", "info");
    const mapInput = {
      mission: run.mission,
      analysis: run.state.analysis,
      planningResearch,
      planningCouncil: planningBookContext(run),
      scaffold: scaffoldContext(run)
    };
    let draftMap: OrvixMap;
    try {
      draftMap = await client.draftOrvixMapJson(mapInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Qwen error";
      appendEvent(run, `Full Orvix Map draft failed; retrying compact Blueprint Architect map: ${message}`, "warning");
      draftMap = await client.draftCompactOrvixMapJson({
        mission: run.mission,
        analysis: run.state.analysis,
        planningCouncil: planningBookContext(run),
        scaffold: scaffoldContext(run),
        previousError: message
      });
    }

    let firstReview;
    try {
      firstReview = await client.reviewOrvixMapJson({
        ...mapInput,
        orvixMap: draftMap
      });
    } catch (error) {
      firstReview = {
        decision: "approve" as const,
        summary: `MasterMind review unavailable, so the current Orvix Map was locked with explicit review debt: ${error instanceof Error ? error.message : "Unknown Qwen error"}`,
        missingRequirements: [],
        requestedChanges: [],
        suggestions: ["Runtime QA and Critic Council should inspect Orvix Map coverage during implementation."],
        revisedMap: undefined as OrvixMap | undefined
      };
      appendEvent(run, `MasterMind Orvix Map review timed out; locking current map with review debt`, "warning");
    }
    let review = firstReview;
    if (firstReview.decision === "revise") {
      appendEvent(run, `MasterMind requested Orvix Map revision: ${firstReview.summary}`, "warning");
      draftMap = firstReview.revisedMap ?? await client.reviseOrvixMapJson({
        ...mapInput,
        originalMap: draftMap,
        review: firstReview
      });
      review = await client.reviewOrvixMapJson({
        ...mapInput,
        orvixMap: draftMap
      });
    }

    lockedOrvixMap = {
      ...((review.revisedMap ?? draftMap) as OrvixMap),
      version: (review.revisedMap ?? draftMap).version || "1.0",
      status: "locked"
    };
    addReasoningArtifact(run, {
      kind: "orvix_map",
      status: "completed",
      content: JSON.stringify(lockedOrvixMap)
    });
    postBookEntry(run, {
      type: review.decision === "approve" ? "decision" : "assumption",
      fromAgentId: "mastermind-agent",
      message: [
        `Orvix Map locked v${lockedOrvixMap.version}: ${lockedOrvixMap.mapSummary}`,
        `Surfaces: ${lockedOrvixMap.surfaces.map((surface) => surface.id).slice(0, 8).join(", ") || "none listed"}.`,
        `Work packets: ${lockedOrvixMap.agentWorkPackets.map((packet) => packet.id).slice(0, 12).join(", ") || "none listed"}.`,
        `Review: ${review.summary}`
      ].join(" "),
      scope: "mission",
      visibility: "global",
      topics: ["orvix-map", "blueprint", "contracts", "acceptance"],
      priority: "high",
      status: "final"
    });
    appendEvent(run, "MasterMind locked Orvix Map for agents and reviewers", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Qwen error";
    lockedOrvixMap = createEmergencyOrvixMap(run, message);
    addReasoningArtifact(run, {
      kind: "orvix_map",
      status: "completed",
      content: JSON.stringify(lockedOrvixMap)
    });
    postBookEntry(run, {
      type: "assumption",
      fromAgentId: "mastermind-agent",
      message: `Emergency Orvix Map locked because Blueprint Forge failed: ${message}. Agents must treat this as the minimum build contract and coordinate missing details in Orvix Book.`,
      scope: "mission",
      visibility: "global",
      topics: ["orvix-map", "blueprint", "fallback", "contracts"],
      priority: "high",
      status: "final"
    });
    appendEvent(run, `Emergency Orvix Map locked after Blueprint Forge failure: ${message}`, "warning");
  }

  try {
    appendEvent(run, "Strategy Weaver organization design started with Qwen", "info");
    try {
      organizationDesign = await client.designOrganizationJson({
        analysis: run.state.analysis,
        planningCouncil: planningBookContext(run),
        planningResearch,
        orvixMap: lockedOrvixMap ?? orvixMapContext(run)
      });
    } catch (error) {
      appendEvent(
        run,
        `Qwen organization design returned an unusable response; retrying compact org design: ${error instanceof Error ? error.message : "Unknown Qwen error"}`,
        "warning"
      );
      organizationDesign = await client.designOrganizationJson({ analysis: run.state.analysis, planningResearch, orvixMap: lockedOrvixMap ?? orvixMapContext(run) });
    }
    run.state = applyOrganizationDesign(run.state, organizationDesign);
    writeTaskGraphArtifact(run.store, run.state);
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    addReasoningArtifact(run, {
      kind: "organization_design",
      status: "completed",
      content: JSON.stringify(organizationDesign)
    });
    broadcast(run, "state", run.state);
    appendEvent(run, "Qwen Strategy Weaver returned organization design", "success");
  } catch (error) {
    addReasoningArtifact(run, {
      kind: "organization_design",
      status: "completed",
      content: JSON.stringify({
        fallback: true,
        stage: "organization_design",
        error: error instanceof Error ? error.message : "Unknown Qwen error",
        organization: run.state.organization,
        agents: run.state.agents,
        tasks: run.state.tasks
      })
    });
    appendEvent(run, `Qwen organization design failed; continuing with mock org: ${error instanceof Error ? error.message : "Unknown Qwen error"}`, "warning");
  }

  try {
    appendEvent(run, "Critic Council rubric drafting started with Qwen", "info");
    const reviewRubric = await client.reviewPullRequestJson(run.state.pullRequests[1] ?? run.state.pullRequests[0]);
    addReasoningArtifact(run, {
      kind: "review_rubric",
      status: "completed",
      content: JSON.stringify(reviewRubric)
    });
    appendEvent(run, "Qwen Critic Council prepared PR review rubric", "success");
  } catch (error) {
    addReasoningArtifact(run, {
      kind: "review_rubric",
      status: "completed",
      content: JSON.stringify({
        fallback: true,
        stage: "review_rubric",
        error: error instanceof Error ? error.message : "Unknown Qwen error",
        rubric: "Scripted Critic Council review remains active until Qwen review rubric is available."
      })
    });
    appendEvent(run, "Qwen review rubric failed; continuing with scripted review", "warning");
  }

  addReasoningArtifact(run, {
    kind: "final_report",
    status: "completed",
    content: JSON.stringify({
      missionStatus: "deferred",
      completedFeatures: [],
      openIssues: ["Release report will be drafted after PR approval and runtime acceptance."],
      mergedPRs: [],
      releaseRecommendation: "Wait for implementation, review, and runtime QA.",
      nextSteps: ["Run automatic scheduler", "Review PRs", "Run runtime acceptance gate"]
    })
  });
  appendEvent(run, "Release Marshal deferred final report until reviewed work exists", "info");

  appendEvent(run, "Qwen planning complete; automatic scheduler is starting agent execution", "success");
  run.qwenPlanningComplete = true;
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  startAutomaticAutopilot(run);
}

function scheduleOrchestratorStep(run: MissionRun) {
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

function scheduleNextStep(run: MissionRun) {
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

async function chooseInitialScaffold(
  mission: string,
  mode: "mock" | "qwen",
  analysis: SimulationState["analysis"],
  planningCouncil?: QwenPlanningCouncilDraft | null,
  planningResearch?: PlanningResearchResult | null
): Promise<QwenProjectScaffoldDecision | null> {
  if (mode !== "qwen" || !isQwenConfigured()) return null;

  try {
    return await new QwenClient().chooseProjectScaffoldJson({ mission, analysis, planningCouncil, planningResearch });
  } catch {
    return null;
  }
}

async function draftInitialPlanningCouncil(
  mission: string,
  mode: "mock" | "qwen",
  analysis: SimulationState["analysis"],
  planningResearch?: PlanningResearchResult | null
): Promise<QwenPlanningCouncilDraft | null> {
  if (mode !== "qwen" || !isQwenConfigured()) return null;

  try {
    return await new QwenClient().draftPlanningCouncilJson({ mission, analysis, planningResearch });
  } catch {
    return null;
  }
}

function fallbackPlanningResearchRequest(mission: string, analysis: SimulationState["analysis"], error?: string): QwenPlanningResearchRequest {
  const projectType = analysis.projectType || "software project";
  return {
    summary: "Fallback planning research request generated because Qwen research scout was unavailable.",
    queries: [
      `${mission} best practices architecture`,
      `${projectType} runtime build deployment checklist`,
      `${mission} UX and acceptance criteria examples`
    ].map((query) => query.slice(0, 220)),
    fetchUrls: [],
    rationale: error
      ? `Qwen research scout failed (${error}), so Orvix is still doing targeted search before MasterMind planning.`
      : "Orvix should search before final planning so the first MasterMind plan is grounded in current implementation context."
  };
}

async function executePlanningResearch(request: QwenPlanningResearchRequest, fallback?: boolean, error?: string): Promise<PlanningResearchResult> {
  const queries = Array.from(new Set((request.queries ?? []).map((query) => String(query).trim()).filter(Boolean))).slice(0, 5);
  const urls = Array.from(new Set((request.fetchUrls ?? []).map((url) => String(url).trim()).filter(Boolean))).slice(0, 3);
  const queryResults: unknown[] = [];
  const fetchedUrls: unknown[] = [];

  for (const query of queries) {
    queryResults.push(await researchWeb(query));
  }
  for (const url of urls) {
    fetchedUrls.push(await fetchUrlForAgent(url));
  }

  return {
    request: { ...request, queries, fetchUrls: urls },
    queryResults,
    fetchedUrls,
    fallback,
    error
  };
}

async function draftInitialPlanningResearch(
  mission: string,
  mode: "mock" | "qwen",
  analysis: SimulationState["analysis"]
): Promise<PlanningResearchResult | null> {
  if (mode !== "qwen" || !isQwenConfigured()) return null;

  const client = new QwenClient();
  try {
    const request = await client.draftPlanningResearchJson({ mission, analysis });
    return executePlanningResearch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Qwen error";
    const request = fallbackPlanningResearchRequest(mission, analysis, message);
    return executePlanningResearch(request, true, message);
  }
}

function normalizeScaffoldType(value: unknown): ProjectScaffoldType | undefined {
  const allowed: ProjectScaffoldType[] = ["nextjs", "react-vite", "express-api", "node-cli", "python", "generic"];
  return allowed.includes(value as ProjectScaffoldType) ? value as ProjectScaffoldType : undefined;
}

async function createRun(mission: string, mode: "mock" | "qwen") {
  const initial = createInitialSimulation(mission);
  const planningResearch = await draftInitialPlanningResearch(mission, mode, initial.analysis);
  const planningCouncil = await draftInitialPlanningCouncil(mission, mode, initial.analysis, planningResearch);
  const scaffoldDecision = await chooseInitialScaffold(mission, mode, initial.analysis, planningCouncil, planningResearch);
  const scaffoldType = normalizeScaffoldType(scaffoldDecision?.scaffoldType);
  const store = createRunStore(initial.analysis.id, projectRoot);
  const workspace = createMissionWorkspace({
    missionId: initial.analysis.id,
    mission,
    mode,
    root: workspaceRoot,
    scaffoldType
  });
  const run: MissionRun = {
    id: initial.analysis.id,
    mission,
    mode,
    state: initial,
    stepIndex: 0,
    reasoningArtifacts: [],
    store,
    workspace,
    subscribers: new Set(),
    progressTimer: setInterval(() => {
      if (run.state.isComplete) {
        clearInterval(run.progressTimer);
        return;
      }

      run.state = nudgeActiveProgress(run.state);
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
    }, 750)
  };

  writeRunManifest(store, {
    missionId: run.id,
    mission,
    mode,
    createdAt: new Date().toISOString()
  });
  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    message: `Mission accepted: ${mission}`,
    scope: "mission",
    visibility: "global",
    topics: ["mission", "scope", "delivery"],
    status: "final",
    priority: "normal"
  });
  if (planningResearch) {
    addReasoningArtifact(run, {
      kind: "mission_analysis",
      status: "completed",
      content: JSON.stringify({
        planningResearch,
        source: "qwen_planning_research"
      })
    });
    postBookEntry(run, {
      type: planningResearch.fallback ? "assumption" : "decision",
      fromAgentId: "planning-research-scout",
      message: [
        `Planning research completed before MasterMind analysis: ${planningResearch.request.summary}`,
        `Queries: ${planningResearch.request.queries.join("; ")}.`,
        planningResearch.fallback ? `Fallback reason: ${planningResearch.error ?? "Qwen scout unavailable"}.` : "",
        `Rationale: ${planningResearch.request.rationale}`
      ].filter(Boolean).join(" "),
      scope: "mission",
      visibility: "global",
      topics: ["planning", "research", "search", "mastermind"],
      priority: "high",
      status: "final"
    });
    for (const result of planningResearch.queryResults.slice(0, 3)) {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const searchResults = Array.isArray(record.results) ? record.results : [];
      const first = searchResults[0] && typeof searchResults[0] === "object" ? searchResults[0] as Record<string, unknown> : null;
      postBookEntry(run, {
        type: "note",
        fromAgentId: "planning-research-scout",
        message: first
          ? `Search result for "${String(record.query ?? "planning query")}": ${String(first.title ?? "result")} (${String(first.url ?? "no url")}).`
          : `Search completed for "${String(record.query ?? "planning query")}" with no parsed top result.`,
        scope: "mission",
        visibility: "global",
        topics: ["planning", "research", "search"],
        priority: "normal",
        status: "resolved"
      });
    }
    appendEvent(run, planningResearch.fallback
      ? "Planning Research Scout used fallback queries and completed search-first planning research"
      : "Planning Research Scout completed search-first planning research",
    planningResearch.fallback ? "warning" : "success");
  }
  if (planningCouncil) {
    addReasoningArtifact(run, {
      kind: "mission_analysis",
      status: "completed",
      content: JSON.stringify({
        planningCouncil,
        source: "qwen_planning_council"
      })
    });
    for (const entry of planningCouncil.entries.slice(0, 8)) {
      postBookEntry(run, {
        type: normalizeBookEntryType(entry.type),
        fromAgentId: entry.fromAgentId || "mastermind-agent",
        message: entry.message,
        scope: "mission",
        visibility: "global",
        topics: entry.topics?.length ? entry.topics : ["planning", "mission"],
        priority: normalizeBookPriority(entry.priority),
        status: entry.type === "proposal" ? "open" : "final"
      });
    }
    appendEvent(run, "Planning council posted kickoff decisions to Orvix Book", "success");
  }
  recordProjectBootstrap(run, scaffoldDecision);
  writeStateSnapshot(store, run.state, run.reasoningArtifacts);
  runs.set(run.id, run);
  if (mode === "qwen") {
    void bootstrapQwenReasoning(run);
  } else {
    scheduleNextStep(run);
  }
  return run;
}

function runSummary(run: MissionRun) {
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

function scaffoldLabel(type: ProjectScaffoldType | undefined) {
  if (type === "nextjs") return "Next.js App Router";
  if (type === "react-vite") return "Vite React App";
  if (type === "express-api") return "Express API";
  if (type === "node-cli") return "Node TypeScript CLI";
  if (type === "python") return "Python Project";
  return "Generic Project";
}

function scaffoldCommands(type: ProjectScaffoldType | undefined, decision?: QwenProjectScaffoldDecision | null) {
  if (decision?.commands?.length) return decision.commands;
  if (type === "nextjs" || type === "react-vite" || type === "express-api") {
    return ["npm install", "npm run dev", "npm run build"];
  }
  if (type === "node-cli") return ["npm install", "npm run build", "node dist/index.js"];
  if (type === "python") return ["python src/main.py"];
  return ["npm test"];
}

function recordProjectBootstrap(run: MissionRun, decision?: QwenProjectScaffoldDecision | null) {
  const filesResult = listWorkspaceFiles(run.workspace, { depth: 3 });
  const files = filesResult.ok && filesResult.tool === "list_files"
    ? filesResult.files.map((file) => file.path).sort()
    : [];
  const label = decision?.label || scaffoldLabel(run.workspace.projectType);
  const commands = scaffoldCommands(run.workspace.projectType, decision);
  const rationale = decision?.rationale || `MasterMind selected ${label} using Orvix's local project detection because the user did not provide a more specific stack decision.`;

  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    message: `Project bootstrap complete: ${label}. Decision rationale: ${rationale} Specialist agents must build inside this runnable scaffold instead of inventing a new root layout. Suggested verification commands: ${commands.join(" → ")}.`,
    scope: "mission",
    visibility: "global",
    topics: ["bootstrap", "scaffold", run.workspace.projectType ?? "generic"],
    status: "final",
    priority: "high"
  });
  appendEvent(run, `MasterMind initialized ${label} scaffold`, "success");
  addReasoningArtifact(run, {
    kind: "agent_execution",
    status: "completed",
    content: JSON.stringify({
      agent: {
        id: "mastermind-agent",
        name: "MasterMind Agent",
        role: "Project bootstrap and scaffolding"
      },
      task: {
        id: "task-bootstrap-000",
        title: `Bootstrap runnable ${label}`,
        branch: "main",
        acceptanceCriteria: [
          "Workspace contains runnable starter files",
          "Specialist agents have a stable project layout",
          "Verification commands are documented"
        ]
      },
      plan: {
        summary: `Initialized ${label} before specialist execution.`,
        transcript: [
          {
            type: "decision",
            text: `The mission needs a concrete project root first. MasterMind selected ${label}: ${rationale}`,
            beforeToolIndex: 0
          },
          {
            type: "handoff",
            text: `Bootstrap is complete. Frontend, backend, QA, and release agents should now modify the scaffolded files and verify with: ${commands.join(", ")}.`
          }
        ],
        toolCalls: []
      },
      scaffold: {
        type: run.workspace.projectType ?? "generic",
        label,
        rationale,
        files,
        commands
      },
      results: []
    })
  });
}

function stopScriptedTimers(run: MissionRun) {
  if (run.stepTimer) {
    clearTimeout(run.stepTimer);
    run.stepTimer = undefined;
  }

  if (run.orchestratorTimer) {
    clearTimeout(run.orchestratorTimer);
    run.orchestratorTimer = undefined;
  }
}

function executeGitTool(
  run: MissionRun,
  body: {
    tool?: "git_status" | "create_branch" | "checkout_branch" | "commit_changes" | "get_diff" | "merge_branch";
    branch?: string;
    message?: string;
    baseBranch?: string;
    targetBranch?: string;
  }
) {
  switch (body.tool) {
    case "git_status":
      return getGitStatus(run.workspace);
    case "create_branch":
      return createGitBranch(run.workspace, body.branch ?? "", body.baseBranch ?? "main");
    case "checkout_branch":
      return checkoutGitBranch(run.workspace, body.branch ?? "");
    case "commit_changes":
      return commitWorkspaceChanges(run.workspace, body.message ?? "chore: agent workspace update");
    case "get_diff":
      return getWorkspaceDiff(run.workspace, body.baseBranch ?? "main");
    case "merge_branch":
      return mergeWorkspaceBranch(run.workspace, body.branch ?? "", body.targetBranch ?? "main");
    default:
      return {
        ok: false as const,
        tool: body.tool ?? "unknown",
        error: "Unsupported Git workspace tool"
      };
  }
}

type ExecuteAgentTaskOptions = {
  taskId?: string;
  revision?: boolean;
};

async function executeAgentTask(run: MissionRun, agentId: string, options: ExecuteAgentTaskOptions = {}) {
  stopScriptedTimers(run);
  const agent = run.state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return {
      ok: false,
      error: "agent_not_found"
    };
  }

  const executedTaskIds = getExecutedTaskIds(run);
  const task = options.taskId
    ? run.state.tasks.find((candidate) => candidate.ownerAgentId === agent.id && candidate.id === options.taskId)
    : run.state.tasks.find((candidate) =>
      candidate.ownerAgentId === agent.id && !executedTaskIds.has(candidate.id)
    );
  if (!task) {
    return {
      ok: false,
      error: "task_not_found"
    };
  }

  if (!options.revision && executedTaskIds.has(task.id)) {
    return {
      ok: false,
      error: "task_already_executed"
    };
  }

  const allowedTools = allowedToolsForAgent(agent);
  const taskWorkspace = agentTaskWorkspace(run, agent, task);
  if ("ok" in taskWorkspace && !taskWorkspace.ok) {
    updateAgentTaskState(run, agent.id, task.id, "blocked", "Could not create agent worktree");
    appendEvent(run, `${agent.name} could not create worktree for ${task.branch}: ${taskWorkspace.error}`, "warning");
    return {
      ok: false,
      agent,
      task,
      error: taskWorkspace.error
    };
  }

  const workspace = taskWorkspace as Workspace;
  if (options.revision) {
    const sync = syncWorkspaceBranch(workspace, task.branch, "main");
    if (sync.ok) {
      appendEvent(run, `MasterMind synced ${task.branch} with main before revision`, "success");
    } else {
      appendEvent(run, `MasterMind could not pre-sync ${task.branch} before revision: ${sync.error}`, "warning");
    }
  }

  const workspaceFiles = listWorkspaceFiles(workspace);
  postSpeculativeDependencyNotes(run, agent, task);
  const bookContext = getBookContext(run, agent.id, task.id);
  const reviewFeedback = reviewFeedbackForTask(run, task);
  let rawPlan = createMockAgentPlan(agent, task);
  let qwenPlanContent: string | undefined;
  let qwenReasoningContent: string | undefined;
  if (run.mode === "qwen" && isQwenConfigured()) {
    try {
      const qwen = new QwenClient();
      const detailedPlan = await qwen.planAgentExecutionDetailedJson({
        mission: run.mission,
        agent,
        task,
        allowedTools,
        workspaceFiles,
        bookContext,
        organization: run.state.organization,
        agents: run.state.agents,
        tasks: run.state.tasks,
        pullRequests: run.state.pullRequests,
        reviewFeedback,
        orvixMap: orvixMapContext(run),
        mapWorkPacket: mapWorkPacketForAgent(run, agent.id, task.id)
      });
      rawPlan = detailedPlan.plan;
      qwenPlanContent = detailedPlan.content;
      qwenReasoningContent = detailedPlan.reasoningContent;

      if (!hasImplementationToolCall(rawPlan)) {
        appendEvent(run, `MasterMind asked ${agent.name} to revise a coordination-only plan into concrete workspace tool calls`, "info");
        const repairedPlan = await qwen.planAgentExecutionDetailedJson({
          mission: run.mission,
          agent,
          task,
          allowedTools,
          workspaceFiles,
          bookContext,
          organization: run.state.organization,
          agents: run.state.agents,
          tasks: run.state.tasks,
          pullRequests: run.state.pullRequests,
          reviewFeedback,
          orvixMap: orvixMapContext(run),
          mapWorkPacket: mapWorkPacketForAgent(run, agent.id, task.id),
          planRepair: {
            reason: "The previous plan contained no write_file or delete_file tool calls, so it could not produce reviewable workspace evidence.",
            instruction: "Return a corrected plan for the same task. Keep useful coordination calls only if they directly support implementation, but include concrete write_file or delete_file calls before commit/open_pr."
          }
        });
        rawPlan = repairedPlan.plan;
        qwenPlanContent = repairedPlan.content;
        qwenReasoningContent = repairedPlan.reasoningContent;
      }
    } catch (error) {
      if (run.mode === "qwen") {
        const message = `${agent.name} Qwen plan failed; no deterministic implementation fallback was applied: ${error instanceof Error ? error.message : "Unknown error"}`;
        updateAgentTaskState(run, agent.id, task.id, "blocked", "Qwen planning failed");
        appendEvent(run, message, "warning");
        writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
        broadcast(run, "state", run.state);
        return {
          ok: false,
          agent,
          task,
          error: "qwen_plan_failed"
        };
      }
      appendEvent(
        run,
        `${agent.name} Qwen plan failed; using deterministic ${options.revision ? "revision" : "execution"} plan: ${error instanceof Error ? error.message : "Unknown error"}`,
        "warning"
      );
    }
  }
  const revisionNumber = getExecutedTaskRevisionCount(run, task.id) + (options.revision ? 1 : 0);
  if (run.mode === "qwen" && !hasImplementationToolCall(rawPlan)) {
    const retryCount = getNoImplementationRetryCount(run, task.id);
    if (retryCount < 1) {
      const message = `${agent.name} returned no write_file or delete_file tool calls after MasterMind repair; MasterMind is requeuing one concrete implementation retry with an explicit Orvix Map contract.`;
      postBookEntry(run, {
        type: "contract",
        fromAgentId: "mastermind-agent",
        toAgentIds: [agent.id],
        taskId: task.id,
        scope: "task",
        visibility: "mentioned",
        topics: ["no-implementation-tools", "orvix-map", "implementation", task.id],
        priority: "urgent",
        status: "final",
        message: [
          `Your previous plan for ${task.title} did not include write_file or delete_file after repair.`,
          "Retry this task once with concrete source/config/test changes.",
          "Use the Orvix Map and your mapWorkPacket as the build contract.",
          "Do not submit only markdown, planning notes, or Orvix Book coordination unless the task is explicitly review-only."
        ].join(" ")
      });
      updateAgentTaskState(run, agent.id, task.id, "queued", "Requeued for concrete implementation retry");
      appendEvent(run, message, "warning");
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      return {
        ok: false,
        agent,
        task,
        recoverable: true,
        error: "no_agent_implementation_tools_requeued"
      };
    }

    const message = `${agent.name} returned no write_file or delete_file tool calls after MasterMind repair and retry; Orvix will not synthesize implementation fallback in Qwen mode.`;
    updateAgentTaskState(run, agent.id, task.id, "blocked", "No reviewable agent-authored implementation");
    appendEvent(run, message, "warning");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: false,
      agent,
      task,
      error: "no_agent_implementation_tools"
    };
  }

  const plan = normalizeAgentExecutionPlan(rawPlan, agent, task, {
    revision: Boolean(options.revision),
    revisionNumber,
    allowFallbackEvidence: run.mode !== "qwen"
  });

  const results = [];
  appendEvent(
    run,
    `${agent.name} started ${options.revision ? "revision" : "real workspace execution"} for ${task.title}`,
    "info"
  );
  updateAgentTaskState(run, agent.id, task.id, "active", options.revision ? "Applying reviewer changes" : "Executing workspace tools");

  const executableToolCalls = plan.toolCalls.slice(0, agentExecutionToolCallLimit);
  if (plan.toolCalls.length > executableToolCalls.length) {
    appendEvent(
      run,
      `${agent.name} execution plan was capped at ${agentExecutionToolCallLimit} tool calls; remaining calls were skipped`,
      "warning"
    );
  }

  for (const toolCall of executableToolCalls) {
    let result = await executeAgentToolCall(run, agent, task, toolCall, allowedTools, workspace);
    if (isToolAccessDenied(result) && handleMasterMindToolAccessIntervention(run, agent, task, toolCall, allowedTools)) {
      result = await executeAgentToolCall(run, agent, task, toolCall, allowedTools, workspace);
    }
    results.push({ toolCall, result });
    const failureReason = !result.ok && "error" in result ? `: ${result.error}` : "";
    appendEvent(
      run,
      `${agent.name} ${result.ok ? "completed" : "failed"} tool ${toolCall.tool}${failureReason}`,
      result.ok ? "success" : "warning"
    );

    if (!result.ok) {
      updateAgentTaskState(run, agent.id, task.id, "blocked", `Blocked on ${toolCall.tool}`);
      break;
    }
  }

  const failed = results.some((entry) => !entry.result.ok);
  const evidence = hasReviewableBranchEvidence(run, task.branch);
  if (!failed && evidence.ok && evidence.reviewable) {
    updateAgentTaskState(run, agent.id, task.id, "completed", "Workspace execution complete");
    updatePullRequestFromTask(run, task, "In progress", "Reviewing");
    const changedPaths = results
      .map((entry) => entry.toolCall.path)
      .filter((path): path is string => Boolean(path))
      .slice(0, 4);
    appendEvent(
      run,
      `${agent.name} produced workspace changes for review${changedPaths.length ? `: ${changedPaths.join(", ")}` : ""}`,
      "success"
    );
  } else if (!failed) {
    updateAgentTaskState(run, agent.id, task.id, "blocked", `Missing branch evidence for review: ${evidence.reason}`);
    appendEvent(run, `${agent.name} finished without reviewable branch evidence: ${evidence.reason}`, "warning");
  }

  addReasoningArtifact(run, {
    kind: "agent_execution",
    status: failed || !evidence.ok || !evidence.reviewable ? "failed" : "completed",
    content: JSON.stringify({
      agent,
      task,
      revision: Boolean(options.revision),
      revisionNumber,
      allowedTools,
      bookContext,
      qwen: {
        content: qwenPlanContent,
        reasoningContent: qwenReasoningContent
      },
      plan,
      results
    }),
    reasoningContent: qwenReasoningContent
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);

  return {
    ok: !failed && evidence.ok && evidence.reviewable,
    agent,
    task,
    allowedTools,
    plan,
    results,
    workspace,
    git: getGitStatus(workspace)
  };
}

async function executeNextAgentTask(run: MissionRun) {
  const executedTaskIds = getCompletedTaskIds(run);
  const nextTask = getExecutableTasks(run, executedTaskIds, 1)[0] ??
    run.state.tasks.find((task) => !executedTaskIds.has(task.id));

  if (!nextTask) {
    return {
      ok: false,
      error: "no_unexecuted_tasks"
    };
  }

  return executeAgentTask(run, nextTask.ownerAgentId);
}

function getExecutableTasks(run: MissionRun, executedTaskIds = getCompletedTaskIds(run), limit = 4) {
  const busyOwners = new Set(
    run.state.pullRequests
      .filter((pr) => pr.status === "In progress" || pr.status === "Changes requested")
      .map((pr) => pr.ownerAgentId)
  );
  const selectedOwners = new Set<string>();

  return run.state.tasks
    .filter((task) => {
      if (executedTaskIds.has(task.id)) return false;
      if (busyOwners.has(task.ownerAgentId)) return false;
      if (task.status === "blocked") return false;
      return true;
    })
    .filter((task) => {
      if (selectedOwners.has(task.ownerAgentId)) return false;
      selectedOwners.add(task.ownerAgentId);
      return true;
    })
    .slice(0, limit);
}

function postSpeculativeDependencyNotes(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number]
) {
  const completedTaskIds = getCompletedTaskIds(run);
  const missingDependencies = task.dependencies.filter((dependency) => !completedTaskIds.has(dependency));
  if (missingDependencies.length === 0) return;

  const alreadyPosted = run.state.bookEntries.some((entry) =>
    entry.fromAgentId === agent.id &&
    entry.taskId === task.id &&
    entry.type === "question" &&
    entry.topics.includes("dependency")
  );
  if (alreadyPosted) return;

  const dependencyOwners = missingDependencies
    .map((dependency) => run.state.tasks.find((candidate) => candidate.id === dependency)?.ownerAgentId)
    .filter((ownerId): ownerId is string => Boolean(ownerId && ownerId !== agent.id));

  postBookEntry(run, {
    type: "question",
    fromAgentId: agent.id,
    toAgentIds: dependencyOwners,
    taskId: task.id,
    scope: "task",
    visibility: dependencyOwners.length > 0 ? "mentioned" : "team",
    topics: ["dependency", "contract", ...missingDependencies],
    priority: "high",
    message: `${agent.name} is starting ${task.title} speculatively while waiting for ${missingDependencies.join(", ")}. Please publish interface contracts or constraints in Orvix Book; I will proceed with explicit assumptions meanwhile.`
  });

  postBookEntry(run, {
    type: "assumption",
    fromAgentId: agent.id,
    taskId: task.id,
    scope: "task",
    visibility: "global",
    topics: ["speculative-execution", "dependency", ...missingDependencies],
    priority: "normal",
    message: `${agent.name} will not block on dependencies for ${task.title}; branch work continues with assumptions until dependent agents answer.`
  });
}

function normalizeAgentExecutionPlan(
  plan: AgentExecutionPlan,
  agent: Agent,
  task: SimulationState["tasks"][number],
  options: { revision?: boolean; revisionNumber?: number; allowFallbackEvidence?: boolean } = {}
): AgentExecutionPlan {
  const coordinationCalls = plan.toolCalls.filter((call) =>
    call.tool === "post_book_entry" ||
    call.tool === "read_book" ||
    call.tool === "answer_book_entry" ||
    call.tool === "read_signals" ||
    call.tool === "mark_signal_read" ||
    call.tool === "research_web" ||
    call.tool === "fetch_url"
  );
  const writeCalls: AgentToolCall[] = plan.toolCalls
    .filter((call) => call.tool === "write_file")
    .map((call) => ({ ...call, branch: undefined }));
  const deleteCalls: AgentToolCall[] = plan.toolCalls
    .filter((call) => call.tool === "delete_file")
    .map((call) => ({ ...call, branch: undefined }));
  const allowFallbackEvidence = options.allowFallbackEvidence ?? true;
  const implementationCalls = allowFallbackEvidence ? createImplementationEvidenceCalls(agent, task, options) : [];
  const hasImplementationEvidence = writeCalls.some((call) => isImplementationEvidencePath(call.path));
  if (allowFallbackEvidence && !hasImplementationEvidence && !options.revision) {
    writeCalls.push(...implementationCalls);
  }

  if (allowFallbackEvidence && writeCalls.length === 0 && !options.revision) {
    const safeAgentName = agent.name.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent";
    writeCalls.push({
      tool: "write_file",
      path: `docs/${task.id}.md`,
      content: [
        `# ${task.title}`,
        "",
        `Owner: ${safeAgentName}`,
        `Branch: ${task.branch}`,
        "",
        "## Acceptance Criteria",
        "",
        ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        "",
        "## Delivery Evidence",
        "",
        "This delivery note was added by Orvix because the agent turn did not create file evidence before review.",
        ""
      ].join("\n")
    });
  }

  const toolCalls: AgentToolCall[] = [
    ...coordinationCalls,
    options.revision ? { tool: "checkout_branch", branch: task.branch } : { tool: "create_branch", branch: task.branch, baseBranch: "main" },
    ...deleteCalls,
    ...writeCalls,
    { tool: "commit_changes", message: `${options.revision ? "fix" : "feat"}: ${task.title}` },
    {
      tool: "open_pr",
      title: task.title,
      summary: `${agent.name} ${options.revision ? "revised" : "completed"} the workspace packet for ${task.title}.`
    }
  ];

  const existingTranscript = Array.isArray(plan.transcript) ? plan.transcript : [];
  const transcript = existingTranscript.length > 0
    ? existingTranscript
    : createDefaultTranscript(agent, task, toolCalls, options);

  return {
    ...plan,
    summary: plan.summary || `${agent.name} generated a normalized Orvix execution plan.`,
    transcript,
    toolCalls
  };
}

function createDefaultTranscript(
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCalls: AgentToolCall[],
  options: { revision?: boolean; revisionNumber?: number } = {}
): NonNullable<AgentExecutionPlan["transcript"]> {
  const writeIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "write_file"));
  const commitIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "commit_changes"));
  const prIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "open_pr"));

  return [
    {
      type: "observation",
      text: `${agent.name} has a focused ownership slice: ${task.title}. The branch can move forward with explicit assumptions while sibling agents publish their contracts.`,
      beforeToolIndex: 0
    },
    {
      type: "decision",
      text: options.revision
        ? `This is revision ${options.revisionNumber ?? 1}, so the safest move is to update the existing branch evidence instead of opening a separate workstream.`
        : "Before writing files, the agent records the coordination assumption in Orvix Book so other agents can reconcile against it later.",
      beforeToolIndex: 0
    },
    {
      type: "tool_intent",
      tool: "write_file",
      path: toolCalls[writeIndex]?.path,
      text: "The implementation packet needs concrete evidence now. A small source artifact is better than a broad plan because Critic Council can review an actual diff.",
      beforeToolIndex: writeIndex
    },
    {
      type: "tool_intent",
      tool: "commit_changes",
      text: "The changed files are ready to become branch evidence, so the next step is committing them with the task scope in the message.",
      beforeToolIndex: commitIndex
    },
    {
      type: "tool_intent",
      tool: "open_pr",
      text: "With the branch committed, the agent can hand the packet to Critic Council for review instead of continuing to expand scope.",
      beforeToolIndex: prIndex
    }
  ];
}

function isImplementationEvidencePath(path?: string) {
  if (!path) return false;
  if (/^docs\//i.test(path) || /^work\//i.test(path)) return false;
  return /\.(ts|tsx|js|jsx|sql|json|yaml|yml|test\.ts|spec\.ts|mdx)$/i.test(path);
}

function hasImplementationToolCall(plan: AgentExecutionPlan) {
  return plan.toolCalls.some((call) => call.tool === "write_file" || call.tool === "delete_file");
}

function createImplementationEvidenceCalls(
  agent: Agent,
  task: SimulationState["tasks"][number],
  options: { revision?: boolean; revisionNumber?: number } = {}
): AgentToolCall[] {
  const text = `${agent.name} ${agent.role} ${task.title} ${task.acceptanceCriteria.join(" ")} ${task.filesLikelyAffected.join(" ")}`.toLowerCase();
  const revisionSuffix = options.revision ? `\n// Revision ${options.revisionNumber ?? 1}: responds to reviewer feedback with concrete implementation evidence.\n` : "";

  if (/auth|oauth|sso|credential|password|session|token|argon2|rbac|security/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/auth/tenantAuth.ts",
        content: [
          "export type AuthProvider = \"password\" | \"okta\" | \"auth0\" | \"google\" | \"microsoft\";",
          "",
          "export type TenantSession = {",
          "  userId: string;",
          "  tenantId: string;",
          "  roles: string[];",
          "  provider: AuthProvider;",
          "  issuedAt: string;",
          "  expiresAt: string;",
          "};",
          "",
          "export function assertTenantBoundary(session: TenantSession, tenantId: string) {",
          "  if (!session.tenantId || session.tenantId !== tenantId) {",
          "    throw new Error(\"tenant_boundary_violation\");",
          "  }",
          "}",
          "",
          "export function createPasswordHashPolicy(tenantPepperId: string) {",
          "  if (!tenantPepperId.trim()) throw new Error(\"tenant_pepper_required\");",
          "  return { algorithm: \"argon2id\", memoryKiB: 19456, iterations: 2, parallelism: 1, tenantPepperId };",
          "}",
          "",
          "export function createPasswordResetPolicy(now = new Date()) {",
          "  return {",
          "    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),",
          "    singleUse: true,",
          "    tokenEntropyBits: 256",
          "  };",
          "}",
          "",
          "export const oauth21Requirements = {",
          "  pkceRequired: true,",
          "  implicitFlowAllowed: false,",
          "  redirectUriExactMatch: true,",
          "  supportedProviders: [\"okta\", \"auth0\"] satisfies AuthProvider[]",
          "};",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/auth/sso.ts",
        content: [
          "import { oauth21Requirements, type AuthProvider } from \"./tenantAuth\";",
          "",
          "export type SsoCallback = { provider: AuthProvider; code: string; state: string; tenantId: string };",
          "",
          "export function validateSsoCallback(callback: SsoCallback) {",
          "  if (!oauth21Requirements.supportedProviders.includes(callback.provider)) throw new Error(\"unsupported_provider\");",
          "  if (!callback.code || !callback.state) throw new Error(\"invalid_oauth_callback\");",
          "  if (!callback.tenantId) throw new Error(\"tenant_required\");",
          "  return {",
          "    provider: callback.provider,",
          "    tenantId: callback.tenantId,",
          "    tokenExchange: \"authorization_code_with_pkce\"",
          "  };",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "db/policies/tenant_rls.sql",
        content: [
          "create table if not exists tenants (",
          "  id uuid primary key,",
          "  name text not null",
          ");",
          "",
          "create table if not exists users (",
          "  id uuid primary key,",
          "  tenant_id uuid not null references tenants(id),",
          "  email text not null,",
          "  password_hash text,",
          "  roles text[] not null default '{}',",
          "  unique (tenant_id, email)",
          ");",
          "",
          "alter table users enable row level security;",
          "",
          "create policy tenant_isolation_users on users",
          "  using (tenant_id::text = current_setting('app.tenant_id', true))",
          "  with check (tenant_id::text = current_setting('app.tenant_id', true));",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/auth-tenancy.spec.ts",
        content: [
          "import { assertTenantBoundary, createPasswordHashPolicy, createPasswordResetPolicy, oauth21Requirements } from \"../src/auth/tenantAuth\";",
          "import { validateSsoCallback } from \"../src/auth/sso\";",
          "",
          "const session = {",
          "  userId: \"user_1\",",
          "  tenantId: \"tenant_a\",",
          "  roles: [\"admin\"],",
          "  provider: \"password\" as const,",
          "  issuedAt: new Date(0).toISOString(),",
          "  expiresAt: new Date(3600000).toISOString()",
          "};",
          "",
          "assertTenantBoundary(session, \"tenant_a\");",
          "const hashPolicy = createPasswordHashPolicy(\"pepper_tenant_a_v1\");",
          "if (hashPolicy.algorithm !== \"argon2id\") throw new Error(\"argon2id_required\");",
          "const reset = createPasswordResetPolicy(new Date(0));",
          "if (!reset.singleUse || reset.tokenEntropyBits < 256) throw new Error(\"weak_reset_policy\");",
          "if (!oauth21Requirements.pkceRequired || oauth21Requirements.implicitFlowAllowed) throw new Error(\"oauth21_policy_failed\");",
          "validateSsoCallback({ provider: \"okta\", code: \"code\", state: \"state\", tenantId: \"tenant_a\" });",
          ""
        ].join("\n")
      }
    ];
  }

  if (/tenant|isolation|branding|onboarding|segregation|purge/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/tenancy/tenantIsolation.ts",
        content: [
          "export type TenantContext = { tenantId: string; userId: string; roles: string[] };",
          "export type TenantResource = { tenantId: string; id: string };",
          "",
          "export function requireTenantAccess(context: TenantContext, resource: TenantResource) {",
          "  if (!context.tenantId || context.tenantId !== resource.tenantId) {",
          "    throw new Error(\"cross_tenant_access_denied\");",
          "  }",
          "  return true;",
          "}",
          "",
          "export function tenantRoute(path: string, tenantId: string) {",
          "  if (!tenantId.trim()) throw new Error(\"tenant_required\");",
          "  return `/t/${tenantId}${path.startsWith(\"/\") ? path : `/${path}`}`;",
          "}",
          "",
          "export function tenantDeletionPlan(tenantId: string) {",
          "  return [\"notes\", \"contacts\", \"users\", \"branding\", \"tenants\"].map((table) => ({ table, tenantId, hardDelete: true, auditRetained: true }));",
          "}",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/tenancy/branding.ts",
        content: [
          "export type TenantBranding = { tenantId: string; logoUrl: string; theme: \"light\" | \"dark\" | \"system\" };",
          "",
          "export function injectTenantBranding(branding: TenantBranding) {",
          "  if (!branding.logoUrl.startsWith(\"/\")) throw new Error(\"unsafe_logo_url\");",
          "  return {",
          "    cacheKey: `tenant-branding:${branding.tenantId}`,",
          "    maxRenderLatencyMs: 5000,",
          "    variables: { logo: branding.logoUrl, theme: branding.theme }",
          "  };",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/tenant-isolation.spec.ts",
        content: [
          "import { requireTenantAccess, tenantDeletionPlan, tenantRoute } from \"../src/tenancy/tenantIsolation\";",
          "import { injectTenantBranding } from \"../src/tenancy/branding\";",
          "",
          "requireTenantAccess({ tenantId: \"tenant_a\", userId: \"u1\", roles: [\"admin\"] }, { tenantId: \"tenant_a\", id: \"contact_1\" });",
          "",
          "try {",
          "  requireTenantAccess({ tenantId: \"tenant_a\", userId: \"u1\", roles: [] }, { tenantId: \"tenant_b\", id: \"contact_2\" });",
          "  throw new Error(\"expected_cross_tenant_denial\");",
          "} catch (error) {",
          "  if (!(error instanceof Error) || error.message !== \"cross_tenant_access_denied\") throw error;",
          "}",
          "",
          "if (!tenantRoute(\"/dashboard\", \"tenant_a\").startsWith(\"/t/tenant_a\")) throw new Error(\"tenant_route_failed\");",
          "if (tenantDeletionPlan(\"tenant_a\").some((step) => !step.hardDelete || !step.auditRetained)) throw new Error(\"purge_plan_failed\");",
          "if (injectTenantBranding({ tenantId: \"tenant_a\", logoUrl: \"/logo.svg\", theme: \"dark\" }).maxRenderLatencyMs > 5000) throw new Error(\"branding_latency_failed\");",
          ""
        ].join("\n")
      }
    ];
  }

  if (/database|schema|migration|rls|model/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "db/schema.sql",
        content: [
          "create table if not exists contacts (",
          "  id uuid primary key,",
          "  tenant_id uuid not null,",
          "  owner_user_id uuid not null,",
          "  name text not null,",
          "  email text,",
          "  created_at timestamptz not null default now()",
          ");",
          "",
          "create table if not exists notes (",
          "  id uuid primary key,",
          "  tenant_id uuid not null,",
          "  contact_id uuid not null references contacts(id),",
          "  body text not null,",
          "  created_at timestamptz not null default now()",
          ");",
          "",
          "alter table contacts enable row level security;",
          "alter table notes enable row level security;",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/schema-contract.spec.ts",
        content: "export const requiredTables = [\"contacts\", \"notes\", \"users\", \"tenants\"];\n"
      }
    ];
  }

  if (/api|route|endpoint|contacts|notes|crud/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/api/contacts.ts",
        content: [
          "export type ContactInput = { tenantId: string; ownerUserId: string; name: string; email?: string };",
          "",
          "export function validateContactInput(input: ContactInput) {",
          "  if (!input.tenantId) throw new Error(\"tenant_required\");",
          "  if (!input.ownerUserId) throw new Error(\"owner_required\");",
          "  if (!input.name.trim()) throw new Error(\"name_required\");",
          "  return input;",
          "}",
          "",
          "export const contactRoutes = {",
          "  list: \"GET /api/contacts\",",
          "  create: \"POST /api/contacts\",",
          "  update: \"PATCH /api/contacts/:id\",",
          "  remove: \"DELETE /api/contacts/:id\"",
          "};",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/contacts-api.spec.ts",
        content: "import { contactRoutes } from \"../src/api/contacts\";\nif (!contactRoutes.create.includes(\"POST\")) throw new Error(\"missing_create_route\");\n"
      }
    ];
  }

  if (/dashboard|ui|frontend|component|page|responsive/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "app/page.tsx",
        content: [
          "const contacts = [",
          "  { name: \"Alice Smith\", company: \"Acme Inc.\", stage: \"Qualified\", notes: 4 },",
          "  { name: \"Bob Jones\", company: \"Northstar Labs\", stage: \"Proposal\", notes: 2 },",
          "  { name: \"Mina Patel\", company: \"Vertex Studio\", stage: \"Onboarding\", notes: 7 }",
          "];",
          "",
          "export default function Home() {",
          "  return (",
          "    <main className=\"product-shell\">",
          "      <aside className=\"sidebar\">",
          "        <strong>Orvix CRM</strong>",
          "        <nav>",
          "          <a href=\"/dashboard\">Dashboard</a>",
          "          <a href=\"/contacts\">Contacts</a>",
          "          <a href=\"/notes\">Notes</a>",
          "          <a href=\"/login\">Login</a>",
          "        </nav>",
          "      </aside>",
          "      <section className=\"workspace\">",
          "        <p className=\"eyebrow\">Production CRM MVP</p>",
          "        <h1>Customer operations dashboard</h1>",
          "        <p className=\"lede\">Authentication, dashboard metrics, contacts, and notes are organized into one reviewable operator workflow.</p>",
          "        <div className=\"metric-grid\">",
          "          <article><span>Contacts</span><strong>248</strong><small>42 need follow-up</small></article>",
          "          <article><span>Notes</span><strong>1,284</strong><small>Synced to customer records</small></article>",
          "          <article><span>Pipeline</span><strong>$186K</strong><small>Open opportunities</small></article>",
          "        </div>",
          "        <section className=\"table-card\">",
          "          <h2>Priority contacts</h2>",
          "          {contacts.map((contact) => <div className=\"row\" key={contact.name}><span>{contact.name}</span><span>{contact.company}</span><span>{contact.stage}</span><span>{contact.notes} notes</span></div>)}",
          "        </section>",
          "      </section>",
          "    </main>",
          "  );",
          "}",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "app/dashboard/page.tsx",
        content: "export default function DashboardPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Dashboard</p><h1>CRM Dashboard</h1><p className=\"lede\">Revenue, contact health, notes, and team workload in one command view.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/contacts/page.tsx",
        content: "export default function ContactsPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Contacts</p><h1>Contacts</h1><p className=\"lede\">Search, segment, and manage tenant-scoped customer records.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/notes/page.tsx",
        content: "export default function NotesPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Notes</p><h1>Notes</h1><p className=\"lede\">Capture relationship context, follow-ups, and account history.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/globals.css",
        content: [
          ":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #14110d; color: #f5efe4; }",
          "* { box-sizing: border-box; }",
          "body { margin: 0; min-height: 100vh; background: #14110d; }",
          "a { color: inherit; text-decoration: none; }",
          ".product-shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; background: linear-gradient(135deg, #17130f 0%, #20170e 54%, #11100e 100%); }",
          ".sidebar { border-right: 1px solid rgba(245,239,228,.12); padding: 28px 22px; background: rgba(255,255,255,.035); }",
          ".sidebar strong { display: block; margin-bottom: 28px; color: #f7c873; font-size: 1.05rem; }",
          ".sidebar nav { display: grid; gap: 8px; }",
          ".sidebar a { border-radius: 8px; padding: 10px 12px; color: #d8cbbb; }",
          ".workspace, .route-shell { width: min(1180px, 100%); padding: 56px; }",
          ".eyebrow { margin: 0 0 12px; color: #f7c873; text-transform: uppercase; letter-spacing: .08em; font-size: .78rem; font-weight: 700; }",
          "h1 { margin: 0; font-size: clamp(2.2rem, 6vw, 4.8rem); line-height: 1; letter-spacing: 0; }",
          ".lede { color: #d8cbbb; font-size: clamp(1rem, 2vw, 1.25rem); max-width: 760px; line-height: 1.6; }",
          ".metric-grid, .module-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-top: 28px; }",
          "article, .table-card { border: 1px solid rgba(245,239,228,.12); border-radius: 8px; padding: 18px; background: rgba(255,255,255,.055); }",
          "article span { display: block; color: #f7c873; font-size: .82rem; font-weight: 700; }",
          "article strong { display: block; margin-top: 10px; font-size: 2rem; }",
          "article small, article p { color: #c7b8a4; line-height: 1.5; }",
          ".table-card { margin-top: 18px; }",
          ".row { display: grid; grid-template-columns: 1.2fr 1fr 1fr auto; gap: 12px; padding: 12px 0; border-top: 1px solid rgba(245,239,228,.1); color: #d8cbbb; }",
          "@media (max-width: 760px) { .product-shell { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid rgba(245,239,228,.12); } .workspace, .route-shell { padding: 28px; } .row { grid-template-columns: 1fr; } }",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/ui/dashboardShell.tsx",
        content: [
          "type DashboardShellProps = { userName: string; contactCount: number; noteCount: number };",
          "",
          "export function DashboardShell(props: DashboardShellProps) {",
          "  return (",
          "    <main aria-label=\"CRM dashboard\">",
          "      <header>Welcome {props.userName}</header>",
          "      <section aria-label=\"Pipeline summary\">",
          "        <span>Contacts: {props.contactCount}</span>",
          "        <span>Notes: {props.noteCount}</span>",
          "      </section>",
          "    </main>",
          "  );",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/dashboard-shell.spec.ts",
        content: "export const dashboardA11yContract = { landmarks: [\"main\", \"header\"], responsive: true };\n"
      }
    ];
  }

  return [
    {
      tool: "write_file",
      path: `src/delivery/${task.id}.ts`,
      content: [
        `export const deliveryPacket = ${JSON.stringify({
          taskId: task.id,
          owner: agent.name,
          acceptanceCriteria: task.acceptanceCriteria,
          revision: options.revision ? options.revisionNumber ?? 1 : 0
        }, null, 2)} as const;`,
        ""
      ].join("\n")
    }
  ];
}

function hasReviewableBranchEvidence(run: MissionRun, branch: string) {
  const exists = branchExists(run.workspace, branch);
  if (!exists.ok) {
    return {
      ok: false,
      reviewable: false,
      reason: exists.error
    };
  }

  if (exists.tool !== "branch_exists" || !exists.exists) {
    return {
      ok: true,
      reviewable: false,
      reason: "branch_missing"
    };
  }

  const diff = getBranchDiff(run.workspace, branch, "main");
  if (!diff.ok || diff.tool !== "get_diff") {
    return {
      ok: false,
      reviewable: false,
      reason: diff.ok ? "unexpected_diff_result" : diff.error
    };
  }

  return {
    ok: true,
    reviewable: diff.output.trim().length > 0,
    reason: diff.output.trim().length > 0 ? "ready" : "empty_diff"
  };
}

function agentTaskWorkspace(run: MissionRun, agent: Agent, task: SimulationState["tasks"][number]) {
  const worktree = ensureAgentWorktree(run.workspace, agent.id, task.branch, "main");
  if ("ok" in worktree && !worktree.ok) {
    return worktree;
  }

  return worktree as Workspace;
}

function changedFilesFromDiff(diff: string) {
  return Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)).map((match) => match[2]).filter(Boolean);
}

function implementationTaskRequiresSource(task?: SimulationState["tasks"][number]) {
  if (!task) return true;
  const text = `${task.title} ${task.filesLikelyAffected.join(" ")} ${task.acceptanceCriteria.join(" ")}`.toLowerCase();
  return /src\/|app\/|component|ui|game|loop|state|style|css|test|config|package|route|api|implementation|playable|canvas/.test(text);
}

function createStaticPrReviewDecision(
  run: MissionRun,
  pr: PullRequest,
  diff: string,
  task?: SimulationState["tasks"][number]
): PullRequestReviewDecision | null {
  const changedFiles = changedFilesFromDiff(diff);
  if (changedFiles.length === 0) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} has an empty diff.`,
      comments: ["The branch has no reviewable source/config/test/style changes. Re-run the task and write the files from the Orvix Map packet."],
      risks: ["Empty PRs cannot advance the generated product."]
    };
  }

  const sourceLike = changedFiles.filter((file) =>
    /^(src|app|components|lib|tests|test|styles|public)\//.test(file) ||
    /(^|\/)(package\.json|vite\.config\.[tj]s|tsconfig\.json|tailwind\.config\.[tj]s|next\.config\.[tj]s)$/.test(file)
  );
  const markdownOnly = changedFiles.every((file) => /\.(md|mdx|txt)$/i.test(file) || /^(docs|work)\//.test(file));
  if (!isNonBlockingReviewerPr(run, pr) && implementationTaskRequiresSource(task) && markdownOnly && sourceLike.length === 0) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} only changes documentation/work notes, not implementation files.`,
      comments: [
        "Implementation packets must modify source, style, config, test, or route files.",
        "Use write_file/delete_file on the concrete files listed in the Orvix Map work packet before opening the PR."
      ],
      risks: ["Markdown-only work can look complete while leaving the runnable project unchanged."]
    };
  }

  if (run.workspace.projectType === "react-vite") {
    const packagePath = resolve(run.workspace.repoDir, "package.json");
    const packageJson = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
    const buildUsesTsc = /"build"\s*:\s*"[^"]*\btsc\b/.test(packageJson);
    const jsSourceFiles = changedFiles.filter((file) => /^src\/.+\.jsx?$/.test(file));
    const tsConfigExists = existsSync(resolve(run.workspace.repoDir, "tsconfig.json"));
    if (buildUsesTsc && jsSourceFiles.length > 0 && !changedFiles.includes("package.json") && !tsConfigExists) {
      return {
        decision: "request_changes",
        summary: `PR #${pr.id} writes JavaScript files into a TypeScript Vite scaffold without aligning the build config.`,
        comments: [
          `Changed JS files: ${jsSourceFiles.join(", ")}.`,
          "Either use .ts/.tsx files that match the scaffold, restore/provide tsconfig.json, or update package.json build scripts coherently in the same PR."
        ],
        risks: ["The generated app can look playable in source but fail npm run build."]
      };
    }
  }

  return null;
}

async function reviewPullRequest(run: MissionRun, prId: number) {
  const pr = run.state.pullRequests.find((candidate) => candidate.id === prId);
  if (!pr) {
    return {
      ok: false,
      error: "pr_not_found"
    };
  }

  if (pr.status !== "In progress") {
    return {
      ok: false,
      error: `pr_not_reviewable:${pr.status}`
    };
  }

  const attemptCount = getReviewAttemptCount(run, pr.id);
  if (attemptCount >= reviewAttemptLimit) {
    const result = escalatePullRequestReview(run, pr, attemptCount);
    return {
      ok: false,
      pr,
      decision: result.decision,
      error: "review_attempt_limit_reached"
    };
  }

  const exists = branchExists(run.workspace, pr.branch);
  if (!exists.ok || exists.tool !== "branch_exists" || !exists.exists) {
    const decision: PullRequestReviewDecision = {
      decision: "request_changes",
      summary: `PR #${pr.id} cannot be reviewed because branch ${pr.branch} does not exist.`,
      comments: ["Owner must create the task branch and commit reviewable evidence before requesting review."],
      risks: ["Review cannot inspect missing branch work."]
    };
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", decision);
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: missing branch ${pr.branch}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "failed",
      content: JSON.stringify({
        pr,
        decision
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: false,
      pr,
      decision,
      error: "branch_missing"
    };
  }

  const diff = getBranchDiff(run.workspace, pr.branch, "main");
  if (!diff.ok) {
    appendEvent(run, `Critic Council could not diff ${pr.branch}: ${diff.error}`, "warning");
    return diff;
  }
  if (diff.tool !== "get_diff") {
    return {
      ok: false,
      error: "unexpected_diff_result"
    };
  }

  const ownerAgent = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
  const ownerTask = run.state.tasks.find((task) => task.branch === pr.branch && task.ownerAgentId === pr.ownerAgentId);
  const reviewWorkspace = ownerAgent && ownerTask ? agentTaskWorkspace(run, ownerAgent, ownerTask) : run.workspace;
  const files = "ok" in reviewWorkspace && !reviewWorkspace.ok ? listWorkspaceFiles(run.workspace) : listWorkspaceFiles(reviewWorkspace as Workspace);
  const staticDecision = createStaticPrReviewDecision(run, pr, diff.output, ownerTask);
  if (staticDecision) {
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", staticDecision);
    run.state = {
      ...run.state,
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Addressing deterministic review gate", progress: Math.max(agent.progress, 70) }
        : agent)
    };
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: ${staticDecision.summary}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "completed",
      content: JSON.stringify({
        pr,
        diff: diff.output,
        decision: staticDecision,
        deterministic: true
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: true,
      pr,
      decision: staticDecision,
      approved: false,
      git: getGitStatus(run.workspace)
    };
  }
  const decision = run.mode === "qwen" && isQwenConfigured()
    ? await new QwenClient().reviewWorkspacePullRequestJson({
      mission: run.mission,
      pr,
      diff: diff.output,
      files,
      reviewAttempt: attemptCount + 1,
      reviewAttemptLimit,
      organization: run.state.organization,
      agents: run.state.agents,
      tasks: run.state.tasks,
      pullRequests: run.state.pullRequests,
      orvixMap: orvixMapContext(run),
      orvixBook: {
        entries: run.state.bookEntries.slice(-40),
        signals: run.state.agentSignals.slice(-40),
        ownershipIndex: run.state.ownershipIndex
      }
    })
    : createMockReviewDecision(pr, diff.output);

  const approved = decision.decision === "approve";
  if (approved) {
    const merge = mergeWorkspaceBranch(run.workspace, pr.branch, "main");
    if (!merge.ok) {
      const conflictDecision: PullRequestReviewDecision = {
        decision: "request_changes",
        summary: `PR #${pr.id} was approved but could not merge cleanly.`,
        comments: [
          `Git merge failed for ${pr.branch}: ${merge.error}`,
          "Resolve conflicting files on the branch, preserve both useful changes, and reopen the PR for review."
        ],
        risks: ["A failed merge can leave the generated project inconsistent if it is not routed through revision."]
      };
      updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", conflictDecision);
      routeMergeFailureToMasterMind(run, pr, merge.error);
      addReasoningArtifact(run, {
        kind: "pr_review",
        status: "failed",
        content: JSON.stringify({
          pr,
          decision: conflictDecision,
          merge
        })
      });
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      return {
        ok: false,
        pr,
        decision: conflictDecision,
        error: "merge_failed"
      };
    }

    updateReviewedPullRequest(run, pr, "Approved", "Approved", decision);
    appendEvent(run, `Critic Council approved and merged PR #${pr.id}: ${decision.summary}`, "success");
    syncOpenBranchesAfterMerge(run, pr);
  } else {
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", decision);
    run.state = {
      ...run.state,
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Addressing reviewer comments", progress: Math.max(agent.progress, 70) }
        : agent)
    };
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: ${decision.summary}`, "warning");
  }

  addReasoningArtifact(run, {
    kind: "pr_review",
    status: "completed",
    content: JSON.stringify({
      pr,
      diff: diff.output,
      decision
    })
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);

  return {
    ok: true,
    pr,
    decision,
    approved,
    git: getGitStatus(run.workspace)
  };
}

async function reviewNextPullRequest(run: MissionRun) {
  const nextPr = run.state.pullRequests.find((pr) => pr.status === "In progress" && getReviewAttemptCount(run, pr.id) < reviewAttemptLimit);

  if (!nextPr) {
    return {
      ok: false,
      error: "no_reviewable_pr"
    };
  }

  return reviewPullRequest(run, nextPr.id);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += Math.max(1, concurrency)) {
    const batch = items.slice(index, index + Math.max(1, concurrency));
    results.push(...await Promise.all(batch.map((item) => worker(item))));
  }
  return results;
}

async function runSchedulerTurn(run: MissionRun) {
  stopScriptedTimers(run);
  const executedBranches = getExecutedBranches(run);
  const combinedResults: unknown[] = [];
  const combinedKinds: string[] = [];
  const shouldRunAcceptance = shouldRunRuntimeAcceptance(run);
  if (shouldRunAcceptance && !run.state.isComplete) {
    const acceptance = await runRuntimeAcceptanceGate(run);
    if (!acceptance.ok) {
      return {
        ok: true,
        kind: "runtime_acceptance_failed",
        result: acceptance
      };
    }

    run.state = {
      ...run.state,
      phase: "final",
      isComplete: true,
      agents: run.state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 }))
    };
    appendEvent(run, "Scheduler completed mission: required implementation PRs approved and runtime acceptance passed", "success");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "complete", {
      missionId: run.id,
      status: "completed_scheduler"
    });
    return {
      ok: true,
      kind: "complete",
      result: { missionId: run.id }
    };
  }

  const revisionPrs = run.state.pullRequests
    .filter((pr) => pr.status === "Changes requested" && !isNonBlockingReviewerPr(run, pr) && getReviewAttemptCount(run, pr.id) < reviewAttemptLimit)
    .slice(0, 8);
  if (revisionPrs.length > 0) {
    const concurrency = schedulerConcurrency(run, "revision");
    appendEvent(run, `Parallel revision wave (${concurrency}x): ${revisionPrs.map((pr) => `PR #${pr.id}`).join(", ")}`, "info");
    const results = await mapWithConcurrency(revisionPrs, concurrency, async (revisionPr) => {
      const task = run.state.tasks.find((candidate) => candidate.branch === revisionPr.branch && candidate.ownerAgentId === revisionPr.ownerAgentId);
      if (!task) {
        return {
          ok: false,
          error: "revision_task_not_found",
          pr: revisionPr
        };
      }

      appendEvent(run, `MasterMind routed PR #${revisionPr.id} back to ${revisionPr.ownerName} for revision`, "info");
      return executeAgentTask(run, revisionPr.ownerAgentId, {
        taskId: task.id,
        revision: true
      });
    });
    combinedResults.push(...results);
    combinedKinds.push("revision");
  }

  const signals = combinedResults.length > 0 ? [] : run.state.agentSignals.filter((candidate) => candidate.status === "unread").slice(0, 6);
  if (signals.length > 0) {
    appendEvent(run, `Parallel signal wave: ${signals.length} Orvix Book signal${signals.length === 1 ? "" : "s"}`, "info");
    const handled = await Promise.all(signals.map((signal) => handleAgentSignal(run, signal)));
    return {
      ok: true,
      kind: "signal_wave",
      result: handled
    };
  }

  const exhaustedPrs = run.state.pullRequests.filter((pr) =>
    pr.status === "Changes requested" && getReviewAttemptCount(run, pr.id) >= reviewAttemptLimit
  );
  if (exhaustedPrs.length > 0) {
    for (const exhaustedPr of exhaustedPrs) {
      escalatePullRequestReview(run, exhaustedPr, getReviewAttemptCount(run, exhaustedPr.id));
    }
  }

  const reviewablePrs = combinedResults.length > 0 ? [] : run.state.pullRequests
    .filter((pr) =>
      pr.status === "In progress" &&
      executedBranches.has(pr.branch) &&
      getReviewAttemptCount(run, pr.id) < reviewAttemptLimit
    )
    .slice(0, 8);
  if (reviewablePrs.length > 0) {
    const concurrency = schedulerConcurrency(run, "review");
    appendEvent(run, `Parallel review wave (${concurrency}x): ${reviewablePrs.map((pr) => `PR #${pr.id}`).join(", ")}`, "info");
    const results = await mapWithConcurrency(reviewablePrs, concurrency, (pr) => reviewPullRequest(run, pr.id));
    return {
      ok: results.every((result) => Boolean(result.ok)) || results.some(isRecoverableReviewFailure),
      kind: "review_wave",
      result: results
    };
  }

  const executedTaskIds = getCompletedTaskIds(run);
  const executableTasks = getExecutableTasks(run, executedTaskIds, 8);
  if (executableTasks.length > 0) {
    const concurrency = schedulerConcurrency(run, "execution");
    appendEvent(run, `Parallel execution wave (${concurrency}x): ${executableTasks.map((task) => agentName(run, task.ownerAgentId)).join(", ")}`, "info");
    const results = await mapWithConcurrency(executableTasks, concurrency, (task) => executeAgentTask(run, task.ownerAgentId, { taskId: task.id }));
    combinedResults.push(...results);
    combinedKinds.push("execution");
  }

  if (combinedResults.length > 0) {
    return {
      ok: combinedResults.every((result) => Boolean((result as { ok?: boolean }).ok)),
      kind: `${combinedKinds.join("_")}_wave`,
      result: combinedResults
    };
  }

  const hasUnexecutedTask = run.state.tasks.some((task) => !executedTaskIds.has(task.id));
  if (hasUnexecutedTask) {
    return {
      ok: true,
      kind: "blocked_waiting_dependencies",
      result: { reason: "Remaining tasks are waiting on dependencies or blocked PRs" }
    };
  }

  const allPrsApproved = run.state.pullRequests.length > 0 && run.state.pullRequests.every((pr) => pr.status === "Approved");
  if (allPrsApproved && !run.state.isComplete) {
    const acceptance = await runRuntimeAcceptanceGate(run);
    if (!acceptance.ok) {
      return {
        ok: true,
        kind: "runtime_acceptance_failed",
        result: acceptance
      };
    }

    run.state = {
      ...run.state,
      phase: "final",
      isComplete: true,
      agents: run.state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 }))
    };
    appendEvent(run, "Scheduler completed mission: all executable work approved", "success");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "complete", {
      missionId: run.id,
      status: "completed_scheduler"
    });
    return {
      ok: true,
      kind: "complete",
      result: { missionId: run.id }
    };
  }

  return {
    ok: true,
    kind: "idle",
    result: { reason: "No pending signals, reviews, or executable tasks" }
  };
}

function isRecoverableReviewFailure(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return record.error === "merge_failed";
}

function isNonBlockingReviewerPr(run: MissionRun, pr: PullRequest) {
  const agent = run.state.agents.find((candidate) => candidate.id === pr.ownerAgentId);
  const text = `${agent?.name ?? ""} ${agent?.role ?? ""} ${pr.ownerName} ${pr.title}`.toLowerCase();
  return /runtime qa|qa reviewer|quality|critic|reviewer|validator|test reviewer/.test(text);
}

function shouldRunRuntimeAcceptance(run: MissionRun) {
  if (hasRuntimeGatePassed(run) || run.state.isComplete) return false;
  const requiredPrs = run.state.pullRequests.filter((pr) => !isNonBlockingReviewerPr(run, pr));
  if (requiredPrs.length === 0) return false;
  return requiredPrs.every((pr) => pr.status === "Approved");
}

type RuntimeAcceptanceResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; output: string }>;
  findings: string[];
};

async function runRuntimeAcceptanceGate(run: MissionRun): Promise<RuntimeAcceptanceResult> {
  if (hasRuntimeGatePassed(run)) {
    return { ok: true, checks: [], findings: [] };
  }

  appendEvent(run, "Runtime QA started mission acceptance checks", "info");
  const checks: RuntimeAcceptanceResult["checks"] = [];
  const findings: string[] = [];
  const projectType = run.workspace.projectType ?? "generic";
  const repoDir = run.workspace.repoDir;

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

function runCommandCheck(cwd: string, name: string, args: string[], command = "npm") {
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

function scanMissionPlaceholders(run: MissionRun) {
  const findings: string[] = [];
  const files = collectFiles(run.workspace.repoDir, ["app", "src"], /\.(tsx|ts|jsx|js|css)$/);
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
      findings.push(`${relativePath(run.workspace.repoDir, file)} still contains scaffold placeholder content.`);
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

function scanMissionSpecificSourceIssues(run: MissionRun, files: string[]) {
  const findings: string[] = [];
  const mission = run.mission.toLowerCase();
  const projectType = run.workspace.projectType ?? "generic";
  const sourceByRelativePath = new Map(files.map((file) => [relativePath(run.workspace.repoDir, file), readFileSync(file, "utf8")]));
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

function missionAcceptanceTerms(mission: string) {
  const text = mission.toLowerCase();
  return ["crm", "auth", "dashboard", "contacts", "notes"]
    .filter((term) => text.includes(term));
}

async function runWebPageSmokeChecks(run: MissionRun) {
  const checks: RuntimeAcceptanceResult["checks"] = [];
  const findings: string[] = [];
  const port = await findFreePort(3100);
  const isNext = run.workspace.projectType === "nextjs";
  const args = isNext ? ["run", "dev", "--", "-p", String(port)] : ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)];
  const child = spawn("npm", args, {
    cwd: run.workspace.repoDir,
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

function runtimeRoutesForMission(mission: string) {
  const text = mission.toLowerCase();
  const routes = ["/"];
  if (text.includes("dashboard")) routes.push("/dashboard");
  if (text.includes("contacts")) routes.push("/dashboard/contacts", "/contacts");
  if (text.includes("notes")) routes.push("/notes");
  if (text.includes("auth") || text.includes("login")) routes.push("/login");
  return Array.from(new Set(routes)).slice(0, 6);
}

async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fetchText(url);
    if (result.ok) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  }
  return false;
}

async function fetchText(url: string) {
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

async function findFreePort(start: number) {
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

function collectFiles(root: string, directories: string[], pattern: RegExp) {
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

function relativePath(root: string, file: string) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

function routeRuntimeFindingsForRevision(run: MissionRun, findings: string[]) {
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

function findRuntimeFixOwner(run: MissionRun) {
  return run.state.agents.find((agent) => /frontend|ui|dashboard|page|interface|experience/i.test(`${agent.name} ${agent.role}`)) ??
    run.state.agents.find((agent) => /qa|test|runtime|quality|validator/i.test(`${agent.name} ${agent.role}`)) ??
    run.state.agents.find((agent) => agent.id !== "mastermind-agent");
}

function hasRuntimeGatePassed(run: MissionRun) {
  return run.state.bookEntries.some((entry) =>
    entry.fromAgentId === "mastermind-agent" &&
    entry.type === "decision" &&
    entry.topics.includes("runtime") &&
    entry.topics.includes("acceptance") &&
    entry.message.includes("Runtime acceptance passed")
  );
}

function startAutomaticAutopilot(run: MissionRun) {
  if (run.autoAutopilotStarted) return;
  run.autoAutopilotStarted = true;
  setTimeout(() => {
    void runAutopilot(run, 300, "automatic").catch((error) => {
      appendEvent(run, `Automatic autopilot failed: ${error instanceof Error ? error.message : "Unknown error"}`, "warning");
    });
  }, 250);
}

async function runAutopilot(run: MissionRun, cycles = 300, source: "manual" | "automatic" = "manual") {
  if (run.mode === "qwen" && !run.qwenPlanningComplete) {
    return {
      ok: true,
      cycles: 0,
      turns: [],
      message: "Qwen planning is still running; automatic autopilot will start after planning completes.",
      summary: runSummary(run)
    };
  }

  if (run.autopilotActive) {
    return {
      ok: true,
      cycles: 0,
      turns: [],
      message: "Autopilot is already running",
      summary: runSummary(run)
    };
  }

  run.autopilotActive = true;
  appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot scheduler started`, "info");
  const turns = [];
  try {
    for (let index = 0; index < cycles; index += 1) {
      const turn = await runSchedulerTurn(run);
      turns.push(turn);
      if (turn.kind === "idle" || turn.kind === "complete" || turn.kind === "blocked_waiting_dependencies") {
        break;
      }
    }

    appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot completed ${turns.length} scheduler wave${turns.length === 1 ? "" : "s"}`, "success");
    return {
      ok: true,
      cycles: turns.length,
      turns,
      summary: runSummary(run)
    };
  } finally {
    run.autopilotActive = false;
  }
}

function isRecoverableSchedulerTurn(turn: { kind?: string; result?: unknown }) {
  if (turn.kind?.includes("execution") || turn.kind?.includes("revision")) return true;
  if (turn.kind !== "review_wave") return false;
  const results = Array.isArray(turn.result) ? turn.result : [];
  return results.some(isRecoverableReviewFailure);
}

async function handleAgentSignal(run: MissionRun, signal: AgentSignal) {
  const entry = run.state.bookEntries.find((candidate) => candidate.id === signal.bookEntryId);
  if (!entry) {
    markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
    appendEvent(run, `${agentName(run, signal.toAgentId)} ignored stale signal ${signal.id}`, "warning");
    return {
      ok: false,
      signal,
      error: "book_entry_not_found"
    };
  }

  if (entry.type === "question") {
    const answer = createSignalAnswer(run, signal.toAgentId, entry);
    markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
    appendEvent(run, `${agentName(run, signal.toAgentId)} answered ${agentName(run, entry.fromAgentId)} in Orvix Book`, "success");
    return {
      ok: true,
      signal,
      answer
    };
  }

  markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
  appendEvent(run, `${agentName(run, signal.toAgentId)} acknowledged ${entry.type} from Orvix Book`, "info");
  return {
    ok: true,
    signal,
    acknowledged: entry
  };
}

function createSignalAnswer(run: MissionRun, agentId: string, question: OrvixBookEntry) {
  const agent = run.state.agents.find((candidate) => candidate.id === agentId);
  const topicText = question.topics.join(", ") || "the requested contract";
  const ownedTask = run.state.tasks.find((task) => task.ownerAgentId === agentId);
  const criteria = ownedTask?.acceptanceCriteria.slice(0, 3).join("; ") || "my acceptance contract";
  const message = [
    `${agent?.name ?? agentId} answer for ${topicText}: proceed with your current assumption.`,
    `My owned workstream is ${ownedTask?.title ?? "my assigned task"}.`,
    `Contract I will publish/maintain: ${criteria}.`,
    "If your branch depends on my output, code against this contract now and I will reconcile details in my PR."
  ].join(" ");
  return postBookEntry(run, {
    type: "answer",
    fromAgentId: agentId,
    toAgentIds: [question.fromAgentId],
    message,
    scope: question.scope,
    visibility: "mentioned",
    taskId: question.taskId,
    prId: question.prId,
    replyTo: question.id,
    topics: question.topics,
    priority: question.priority,
    status: "answered"
  });
}

function createMockReviewDecision(pr: PullRequest, diff: string): PullRequestReviewDecision {
  if (!diff.trim()) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} has no diff against main.`,
      comments: ["No workspace changes were found for review."],
      risks: ["Empty PR cannot satisfy acceptance criteria."]
    };
  }

  return {
    decision: "approve",
    summary: `PR #${pr.id} satisfies the current acceptance packet.`,
    comments: ["Diff contains committed workspace evidence.", "Acceptance criteria are represented in the delivery note."],
    risks: []
  };
}

function updateReviewedPullRequest(
  run: MissionRun,
  pr: PullRequest,
  status: PullRequest["status"],
  reviewerStatus: PullRequest["reviewerStatus"],
  decision: PullRequestReviewDecision
) {
  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
      ? {
        ...candidate,
        status,
        reviewerStatus,
        comments: [...candidate.comments, decision.summary, ...decision.comments].slice(-6)
      }
      : candidate),
    tasks: run.state.tasks.map((task) => task.branch === pr.branch && status === "Approved"
      ? { ...task, status: "completed" }
      : task),
    agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId && status === "Approved"
      ? { ...agent, status: "completed", currentActivity: "PR approved and merged", progress: 100, confidence: Math.max(agent.confidence, 0.88) }
      : agent)
  };
}

function routeMergeFailureToMasterMind(run: MissionRun, pr: PullRequest, error: string) {
  const owner = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
  const entry = postBookEntry(run, {
    type: "conflict",
    fromAgentId: "mastermind-agent",
    toAgentIds: owner ? [owner.id] : [],
    prId: pr.id,
    scope: "pr",
    visibility: owner ? "mentioned" : "global",
    topics: ["merge-conflict", "git", pr.branch],
    priority: "urgent",
    status: "open",
    message: [
      `Merge conflict detected on PR #${pr.id} (${pr.branch}).`,
      `Git reported: ${error}`,
      "MasterMind aborted the failed merge to keep main clean.",
      "Owner must revise the branch by reconciling conflicting files, especially shared config such as package.json, then request review again."
    ].join("\n")
  });

  if (owner) {
    createAgentSignal(run, {
      toAgentId: owner.id,
      fromAgentId: "mastermind-agent",
      bookEntryId: entry.id,
      type: "conflict",
      message: `Wake up: PR #${pr.id} has a merge conflict that must be resolved before final approval.`
    });
  }

  run.state = {
    ...run.state,
    tasks: run.state.tasks.map((task) => task.branch === pr.branch
      ? { ...task, status: "blocked" }
      : task),
    agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
      ? { ...agent, status: "blocked", currentActivity: "Resolving merge conflict", progress: Math.max(agent.progress, 82) }
      : agent.id === "mastermind-agent"
        ? { ...agent, status: "active", currentActivity: "Routing merge conflict", progress: Math.max(agent.progress, 88) }
        : agent)
  };

  appendEvent(run, `MasterMind routed merge conflict on PR #${pr.id} to ${pr.ownerName}`, "warning");
}

function syncOpenBranchesAfterMerge(run: MissionRun, mergedPr: PullRequest) {
  const openPrs = run.state.pullRequests.filter((pr) =>
    pr.id !== mergedPr.id &&
    pr.status !== "Approved" &&
    pr.branch !== mergedPr.branch
  );
  if (openPrs.length === 0) return;

  let synced = 0;
  for (const pr of openPrs) {
    const owner = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
    const task = run.state.tasks.find((candidate) => candidate.branch === pr.branch && candidate.ownerAgentId === pr.ownerAgentId);
    if (!owner || !task) continue;

    const workspace = agentTaskWorkspace(run, owner, task);
    if ("ok" in workspace && !workspace.ok) {
      continue;
    }

    const sync = syncWorkspaceBranch(workspace as Workspace, pr.branch, "main");
    if (sync.ok) {
      synced += 1;
      postBookEntry(run, {
        type: "contract",
        fromAgentId: "mastermind-agent",
        toAgentIds: [owner.id],
        prId: pr.id,
        scope: "pr",
        visibility: "mentioned",
        topics: ["branch-sync", "main", pr.branch],
        priority: "normal",
        status: "final",
        message: `Main changed after PR #${mergedPr.id} merged. MasterMind synced ${pr.branch} with main so ${owner.name} can continue from the latest baseline.`
      });
      continue;
    }

    const entry = postBookEntry(run, {
      type: "conflict",
      fromAgentId: "mastermind-agent",
      toAgentIds: [owner.id],
      prId: pr.id,
      scope: "pr",
      visibility: "mentioned",
      topics: ["branch-sync", "main", "conflict", pr.branch],
      priority: "urgent",
      status: "open",
      message: [
        `Main changed after PR #${mergedPr.id} merged, but ${pr.branch} could not sync cleanly.`,
        `Git reported: ${sync.error}`,
        "Continue from the current branch, resolve conflicts against main, and reopen review when clean."
      ].join("\n")
    });
    createAgentSignal(run, {
      toAgentId: owner.id,
      fromAgentId: "mastermind-agent",
      bookEntryId: entry.id,
      type: "conflict",
      message: `Wake up: ${pr.branch} needs sync conflict resolution after main changed.`
    });
    run.state = {
      ...run.state,
      pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
        ? {
            ...candidate,
            status: "Changes requested",
            reviewerStatus: "Requested changes",
            comments: [...candidate.comments, "Branch sync conflict after main changed."].slice(-6)
          }
        : candidate),
      tasks: run.state.tasks.map((candidate) => candidate.branch === pr.branch ? { ...candidate, status: "blocked" } : candidate),
      agents: run.state.agents.map((candidate) => candidate.id === owner.id
        ? { ...candidate, status: "blocked", currentActivity: "Resolving branch sync conflict", progress: Math.max(candidate.progress, 78) }
        : candidate)
    };
  }

  if (synced > 0) {
    appendEvent(run, `MasterMind synced ${synced} open branch${synced === 1 ? "" : "es"} after PR #${mergedPr.id} updated main`, "success");
  }
}

function escalatePullRequestReview(run: MissionRun, pr: PullRequest, attemptCount: number) {
  const alreadyEscalated = pr.comments.some((comment) => comment.includes("MasterMind escalation"));
  const decision: PullRequestReviewDecision = {
    decision: "request_changes",
    summary: `MasterMind escalation: PR #${pr.id} reached ${attemptCount} review attempts without approval.`,
    comments: [
      "The reviewer has coached this PR many times; MasterMind should now revise scope, split the task, or approve remaining gaps as follow-up work.",
      "A human or MasterMind conflict-resolution turn should decide whether to reduce scope, reassign ownership, or convert unresolved items into new tasks."
    ],
    risks: ["Continuing automatic review without a changed strategy can hide a real delivery issue."]
  };

  if (!alreadyEscalated) {
    run.state = {
      ...run.state,
      pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
        ? {
          ...candidate,
          status: "Changes requested",
          reviewerStatus: "Requested changes",
          comments: [...candidate.comments, decision.summary, ...decision.comments].slice(-6)
        }
        : candidate),
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Escalated to MasterMind", progress: Math.max(agent.progress, 76) }
        : agent)
    };
    appendEvent(run, `MasterMind escalated PR #${pr.id} after ${attemptCount} review attempts: ${decision.comments[0]}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "failed",
      content: JSON.stringify({
        pr,
        decision,
        escalated: true
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
  }

  return {
    ok: false,
    pr,
    decision,
    error: "review_attempt_limit_reached"
  };
}

function getExecutedTaskIds(run: MissionRun) {
  const taskIds = new Set<string>();
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { id?: string } };
      if (parsed.task?.id) {
        taskIds.add(parsed.task.id);
      }
    } catch {
      continue;
    }
  }

  return taskIds;
}

function getCompletedTaskIds(run: MissionRun) {
  const taskIds = getExecutedTaskIds(run);
  for (const task of run.state.tasks) {
    if (task.status === "completed") {
      taskIds.add(task.id);
    }
  }

  return taskIds;
}

function getExecutedTaskRevisionCount(run: MissionRun, taskId: string) {
  let count = 0;
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { id?: string }; revision?: boolean };
      if (parsed.task?.id === taskId && parsed.revision) {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

function getNoImplementationRetryCount(run: MissionRun, taskId: string) {
  return run.state.bookEntries.filter((entry) =>
    entry.taskId === taskId &&
    entry.topics.includes("no-implementation-tools") &&
    entry.fromAgentId === "mastermind-agent"
  ).length;
}

function getReviewAttemptCount(run: MissionRun, prId: number) {
  let count = 0;
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "pr_review" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { pr?: { id?: number } };
      if (parsed.pr?.id === prId) {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

function reviewFeedbackForTask(run: MissionRun, task: SimulationState["tasks"][number]) {
  const pr = run.state.pullRequests.find((candidate) =>
    candidate.branch === task.branch && candidate.ownerAgentId === task.ownerAgentId
  );
  if (!pr || pr.comments.length === 0) {
    return null;
  }

  return {
    prId: pr.id,
    status: pr.status,
    reviewerStatus: pr.reviewerStatus,
    comments: pr.comments.slice(-8)
  };
}

function getExecutedBranches(run: MissionRun) {
  const branches = new Set<string>();
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { branch?: string } };
      if (parsed.task?.branch) {
        branches.add(parsed.task.branch);
      }
    } catch {
      continue;
    }
  }

  return branches;
}

async function executeAgentToolCall(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCall: AgentToolCall,
  allowedTools: AgentToolName[],
  workspace: Workspace = run.workspace
) {
  if (!allowedTools.includes(toolCall.tool)) {
    return {
      ok: false,
      tool: toolCall.tool,
      code: "tool_not_allowed",
      error: `${agent.name} is not allowed to use ${toolCall.tool}`
    };
  }

  switch (toolCall.tool) {
    case "list_files":
      return listWorkspaceFiles(workspace);
    case "read_file":
      return readWorkspaceFile(workspace, toolCall.path ?? "");
    case "write_file":
      return writeWorkspaceFile(workspace, toolCall.path ?? "", toolCall.content ?? "");
    case "delete_file":
      return deleteWorkspacePath(workspace, toolCall.path ?? "");
    case "create_branch": {
      const status = getGitStatus(workspace);
      return status.ok && status.tool === "git_status"
        ? { ok: true as const, tool: "create_branch", branch: status.branch, output: status.output }
        : status;
    }
    case "checkout_branch": {
      const status = getGitStatus(workspace);
      return status.ok && status.tool === "git_status"
        ? { ok: true as const, tool: "checkout_branch", branch: status.branch, output: status.output }
        : status;
    }
    case "commit_changes":
      return commitWorkspaceChanges(workspace, toolCall.message ?? `feat: ${task.title}`);
    case "get_diff":
      return getWorkspaceDiff(workspace, toolCall.baseBranch ?? "main");
    case "research_web":
      return researchWeb(toolCall.query ?? toolCall.content ?? toolCall.summary ?? "");
    case "fetch_url":
      return fetchUrlForAgent(toolCall.url ?? toolCall.content ?? "");
    case "open_pr":
      updatePullRequestFromTask(run, task, "In progress", "Reviewing", {
        title: toolCall.title,
        summary: toolCall.summary
      });
      return {
        ok: true,
        tool: "open_pr",
        branch: task.branch,
        output: `Opened simulated PR for ${task.branch}`
      };
    case "complete_task":
      return {
        ok: true,
        tool: "complete_task",
        branch: task.branch,
        output: "Task marked ready for review"
      };
    case "post_book_entry": {
      const entry = postBookEntry(run, {
        type: normalizeBookEntryType(toolCall.entryType),
        fromAgentId: agent.id,
        message: toolCall.content ?? toolCall.summary ?? toolCall.message ?? "",
        toAgentIds: toolCall.toAgentIds,
        scope: toolCall.scope ?? "task",
        visibility: toolCall.visibility,
        taskId: task.id,
        topics: toolCall.topics,
        priority: toolCall.priority
      });
      return {
        ok: true,
        tool: "post_book_entry",
        entryId: entry.id,
        output: entry.message
      };
    }
    case "read_book":
      return {
        ok: true,
        tool: "read_book",
        output: JSON.stringify(getBookContext(run, agent.id, task.id))
      };
    case "answer_book_entry": {
      const target = run.state.bookEntries.find((entry) => entry.id === toolCall.entryId);
      const entry = postBookEntry(run, {
        type: "answer",
        fromAgentId: agent.id,
        message: toolCall.content ?? toolCall.summary ?? "",
        toAgentIds: target ? [target.fromAgentId] : toolCall.toAgentIds,
        scope: target?.scope ?? "task",
        visibility: "mentioned",
        taskId: target?.taskId ?? task.id,
        replyTo: toolCall.entryId,
        topics: target?.topics ?? toolCall.topics,
        priority: toolCall.priority ?? "normal",
        status: "answered"
      });
      return {
        ok: true,
        tool: "answer_book_entry",
        entryId: entry.id,
        output: entry.message
      };
    }
    case "read_signals":
      return {
        ok: true,
        tool: "read_signals",
        output: JSON.stringify(run.state.agentSignals.filter((signal) => signal.toAgentId === agent.id && signal.status === "unread"))
      };
    case "mark_signal_read":
      const marked = markSignalRead(run, { signalId: toolCall.signalId, entryId: toolCall.entryId }, agent.id);
      return {
        ok: true,
        tool: "mark_signal_read",
        output: marked > 0
          ? `Marked ${marked} signal${marked === 1 ? "" : "s"} read`
          : "No unread matching signals"
      };
  }
}

function isToolAccessDenied(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return record.ok === false && record.code === "tool_not_allowed";
}

async function researchWeb(query: string) {
  const trimmed = query.trim().slice(0, 240);
  if (!trimmed) {
    return { ok: false, tool: "research_web", error: "query_required" };
  }

  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Orvix/0.1 research tool"
      }
    });
    const html = await response.text();
    const results = parseSearchResults(html).slice(0, 5);
    return {
      ok: response.ok,
      tool: "research_web",
      query: trimmed,
      results,
      output: results.map((result, index) => `${index + 1}. ${result.title} ${result.url}\n${result.snippet}`).join("\n\n")
    };
  } catch (error) {
    return { ok: false, tool: "research_web", error: error instanceof Error ? error.message : "research_failed" };
  }
}

async function fetchUrlForAgent(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, tool: "fetch_url", error: "http_url_required" };
  }

  try {
    const response = await fetch(trimmed, {
      headers: {
        "User-Agent": "Orvix/0.1 fetch_url tool"
      }
    });
    const text = await response.text();
    return {
      ok: response.ok,
      tool: "fetch_url",
      url: trimmed,
      status: response.status,
      output: stripHtml(text).slice(0, 6000)
    };
  } catch (error) {
    return { ok: false, tool: "fetch_url", error: error instanceof Error ? error.message : "fetch_failed" };
  }
}

function parseSearchResults(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/result__body/gi).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch) continue;
    const url = decodeHtml(titleMatch[1]).replace(/^\/l\/\?kh=-1&uddg=/, "");
    results.push({
      title: stripHtml(titleMatch[2]).slice(0, 160),
      url: decodeURIComponentSafe(url),
      snippet: stripHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "").slice(0, 260)
    });
  }
  return results;
}

function stripHtml(input: string) {
  return decodeHtml(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeURIComponentSafe(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function handleMasterMindToolAccessIntervention(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCall: AgentToolCall,
  allowedTools: AgentToolName[]
) {
  if (allowedTools.includes(toolCall.tool)) return false;
  if (!canMasterMindGrantTool(toolCall.tool)) return false;

  allowedTools.push(toolCall.tool);
  run.state = {
    ...run.state,
    agents: run.state.agents.map((candidate) =>
      candidate.id === "mastermind-agent"
        ? {
            ...candidate,
            status: "active",
            currentActivity: `Granted ${toolCall.tool} to ${agent.name}`,
            progress: Math.max(candidate.progress, 82)
          }
        : candidate.id === agent.id
          ? {
              ...candidate,
              status: "active",
              currentActivity: `Retrying ${toolCall.tool} after MasterMind grant`
            }
          : candidate
    )
  };

  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    toAgentIds: [agent.id],
    taskId: task.id,
    scope: "task",
    visibility: "mentioned",
    topics: ["tool-access", toolCall.tool, task.id],
    priority: "high",
    status: "final",
    message: `MasterMind detected that ${agent.name} requested ${toolCall.tool} for "${task.title}" without current access. The tool is safe for this owned task, so access is granted for this execution turn. Retry the tool now and continue the branch packet.`
  });
  appendEvent(run, `MasterMind granted ${toolCall.tool} to ${agent.name} and retried the blocked tool`, "success");
  return true;
}

function canMasterMindGrantTool(tool: AgentToolName) {
  return [
    "list_files",
    "read_file",
    "write_file",
    "delete_file",
    "create_branch",
    "checkout_branch",
    "commit_changes",
    "get_diff",
    "research_web",
    "fetch_url",
    "open_pr",
    "complete_task",
    "post_book_entry",
    "read_book",
    "answer_book_entry",
    "read_signals",
    "mark_signal_read"
  ].includes(tool);
}

function allowedToolsForAgent(agent: Agent): AgentToolName[] {
  return [
    "list_files",
    "read_file",
    "write_file",
    "delete_file",
    "create_branch",
    "checkout_branch",
    "commit_changes",
    "get_diff",
    "research_web",
    "fetch_url",
    "open_pr",
    "complete_task",
    "post_book_entry",
    "read_book",
    "answer_book_entry",
    "read_signals",
    "mark_signal_read"
  ];
}

function createMockAgentPlan(agent: Agent, task: SimulationState["tasks"][number]): AgentExecutionPlan {
  const branch = task.branch || `feat/${agent.id}`;
  const safeAgentName = agent.name.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent";
  const docPath = `docs/${task.id}.md`;

	  return {
	    summary: `${safeAgentName} will coordinate through Orvix Book, continue in parallel with explicit assumptions, create branch evidence, and open a PR-style review packet.`,
	    transcript: [
	      {
	        type: "observation",
	        text: `${safeAgentName} is taking ownership of ${task.title}. The work can start now because unresolved contracts can be recorded in Orvix Book instead of blocking the branch.`,
	        beforeToolIndex: 0
	      },
	      {
	        type: "decision",
	        text: "The coordination note goes first, so sibling agents can see the assumption while this agent continues with implementation evidence.",
	        beforeToolIndex: 0
	      },
	      {
	        type: "tool_intent",
	        tool: "create_branch",
	        text: `Next the agent isolates the packet on ${branch}, matching the PR-style workflow.`,
	        beforeToolIndex: 1
	      },
	      {
	        type: "tool_intent",
	        tool: "write_file",
	        path: docPath,
	        text: "The smallest reviewable artifact is a delivery note with acceptance criteria and coordination context.",
	        beforeToolIndex: 2
	      },
	      {
	        type: "tool_intent",
	        tool: "open_pr",
	        text: "After commit, the agent hands the branch to review rather than continuing to grow the scope.",
	        beforeToolIndex: 4
	      }
	    ],
	    toolCalls: [
      {
        tool: "post_book_entry",
        entryType: task.title.toLowerCase().includes("database") || task.title.toLowerCase().includes("schema") ? "contract" : "assumption",
        scope: "task",
        visibility: "mentioned",
        topics: inferTopics(`${task.title} ${task.filesLikelyAffected.join(" ")}`),
        content: `${safeAgentName} is proceeding on ${task.title} in parallel with the rest of the Orvix organization. Any missing dependency is treated as an explicit assumption until another agent answers in Orvix Book. Branch evidence will be published for review.`
      },
      { tool: "create_branch", branch },
      {
        tool: "write_file",
        path: docPath,
        content: [
          `# ${task.title}`,
          "",
          `Owner: ${safeAgentName}`,
          `Branch: ${branch}`,
          "",
          "## Acceptance Criteria",
          "",
          ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
          "",
          "## Delivery Notes",
          "",
          "This file was generated by an Orvix-controlled agent execution loop.",
          "The agent is working in parallel and coordinating unresolved contracts through Orvix Book.",
          ""
        ].join("\n")
      },
      { tool: "commit_changes", message: `feat: ${task.title}` },
      {
        tool: "open_pr",
        title: task.title,
        summary: `${safeAgentName} completed the workspace packet for ${task.title}.`
      }
    ]
  };
}

function updateAgentTaskState(
  run: MissionRun,
  agentId: string,
  taskId: string,
  status: SimulationState["tasks"][number]["status"],
  activity: string
) {
  run.state = {
    ...run.state,
    phase: "executing",
    tasks: run.state.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
    agents: run.state.agents.map((agent) => agent.id === agentId
      ? {
        ...agent,
        status,
        currentActivity: activity,
        progress: status === "completed" ? 100 : Math.max(agent.progress, status === "blocked" ? 64 : 48),
        confidence: Math.max(agent.confidence, status === "completed" ? 0.86 : 0.72)
      }
      : agent)
  };
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
}

function updatePullRequestFromTask(
  run: MissionRun,
  task: SimulationState["tasks"][number],
  status: SimulationState["pullRequests"][number]["status"],
  reviewerStatus: SimulationState["pullRequests"][number]["reviewerStatus"],
  patch: Partial<Pick<SimulationState["pullRequests"][number], "title" | "summary">> = {}
) {
  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((pr) => pr.ownerAgentId === task.ownerAgentId && pr.branch === task.branch
      ? {
        ...pr,
        status,
        reviewerStatus,
        title: patch.title ?? pr.title,
        summary: patch.summary ?? pr.summary
      }
      : pr)
  };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const qwenConfig = createQwenConfig();
      sendJson(response, 200, {
        service: "orvix-api",
        status: "ok",
        provider: "Alibaba Cloud ready",
        runtime: "Node.js",
        qwen: isQwenConfigured(qwenConfig) ? "configured" : "missing_api_key",
        qwenBaseUrl: qwenConfig.baseUrl,
        qwenModel: qwenConfig.model
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/missions") {
      const body = await readJson<{ mission?: string; mode?: "mock" | "qwen" }>(request);
      if (!body.mission?.trim()) {
        sendJson(response, 400, { error: "mission_required" });
        return;
      }

      const mode = body.mode === "qwen" ? "qwen" : "mock";
      const run = await createRun(body.mission.trim(), mode);
      sendJson(response, 201, {
        missionId: run.id,
        eventsUrl: `/missions/${run.id}/events`,
        stateUrl: `/missions/${run.id}`,
        summary: runSummary(run)
      });
      return;
    }

    const missionMatch = url.pathname.match(/^\/missions\/([^/]+)$/);
    if (request.method === "GET" && missionMatch) {
      const run = runs.get(missionMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        summary: runSummary(run),
        state: run.state,
        reasoningArtifacts: run.reasoningArtifacts,
        artifactsDir: run.store.artifactsDir,
        workspace: run.workspace
      });
      return;
    }

    const workspaceMatch = url.pathname.match(/^\/missions\/([^/]+)\/workspace$/);
    if (request.method === "GET" && workspaceMatch) {
      const run = runs.get(workspaceMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        workspace: run.workspace,
        files: listWorkspaceFiles(run.workspace),
        git: getGitStatus(run.workspace)
      });
      return;
    }

    const bookMatch = url.pathname.match(/^\/missions\/([^/]+)\/book$/);
    if (request.method === "GET" && bookMatch) {
      const run = runs.get(bookMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const agentId = url.searchParams.get("agentId");
      const taskId = url.searchParams.get("taskId") ?? undefined;
      sendJson(response, 200, {
        missionId: run.id,
        book: agentId ? getBookContext(run, agentId, taskId) : {
          entries: run.state.bookEntries,
          signals: run.state.agentSignals,
          ownershipIndex: run.state.ownershipIndex
        }
      });
      return;
    }

    if (request.method === "POST" && bookMatch) {
      const run = runs.get(bookMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const body = await readJson<{
        type?: OrvixBookEntryType;
        fromAgentId?: string;
        message?: string;
        toAgentIds?: string[];
        scope?: OrvixBookScope;
        visibility?: OrvixBookVisibility;
        taskId?: string;
        prId?: number;
        replyTo?: string;
        topics?: string[];
        priority?: OrvixBookPriority;
      }>(request);
      if (!body.message?.trim()) {
        sendJson(response, 400, { error: "message_required" });
        return;
      }

      const entry = postBookEntry(run, {
        type: body.type ?? "note",
        fromAgentId: body.fromAgentId ?? "mastermind-agent",
        message: body.message.trim(),
        toAgentIds: body.toAgentIds,
        scope: body.scope,
        visibility: body.visibility,
        taskId: body.taskId,
        prId: body.prId,
        replyTo: body.replyTo,
        topics: body.topics,
        priority: body.priority
      });
      appendEvent(run, `${agentName(run, entry.fromAgentId)} posted ${entry.type} to Orvix Book`, "info");
      sendJson(response, 201, { entry });
      return;
    }

    const signalsMatch = url.pathname.match(/^\/missions\/([^/]+)\/agents\/([^/]+)\/signals$/);
    if (request.method === "GET" && signalsMatch) {
      const run = runs.get(signalsMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        agentId: signalsMatch[2],
        signals: run.state.agentSignals.filter((signal) => signal.toAgentId === signalsMatch[2])
      });
      return;
    }

    const gitToolMatch = url.pathname.match(/^\/missions\/([^/]+)\/workspace\/git$/);
    if (request.method === "POST" && gitToolMatch) {
      const run = runs.get(gitToolMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const body = await readJson<{
        tool?: "git_status" | "create_branch" | "checkout_branch" | "commit_changes" | "get_diff" | "merge_branch";
        branch?: string;
        message?: string;
        baseBranch?: string;
        targetBranch?: string;
      }>(request);

      const result = executeGitTool(run, body);
      if (result.ok) {
        appendEvent(run, `Workspace Git tool ${result.tool} completed on ${result.branch}`, "success");
      } else {
        appendEvent(run, `Workspace Git tool ${result.tool} failed: ${result.error}`, "warning");
      }

      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const agentExecuteMatch = url.pathname.match(/^\/missions\/([^/]+)\/agents\/([^/]+)\/execute$/);
    if (request.method === "POST" && agentExecuteMatch) {
      const run = runs.get(agentExecuteMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const result = await executeAgentTask(run, agentExecuteMatch[2]);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const executeNextMatch = url.pathname.match(/^\/missions\/([^/]+)\/execute-next$/);
    if (request.method === "POST" && executeNextMatch) {
      const run = runs.get(executeNextMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const result = await executeNextAgentTask(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const reviewNextMatch = url.pathname.match(/^\/missions\/([^/]+)\/review-next$/);
    if (request.method === "POST" && reviewNextMatch) {
      const run = runs.get(reviewNextMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const result = await reviewNextPullRequest(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const prReviewMatch = url.pathname.match(/^\/missions\/([^/]+)\/prs\/(\d+)\/review$/);
    if (request.method === "POST" && prReviewMatch) {
      const run = runs.get(prReviewMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const result = await reviewPullRequest(run, Number(prReviewMatch[2]));
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const schedulerTickMatch = url.pathname.match(/^\/missions\/([^/]+)\/scheduler\/tick$/);
    if (request.method === "POST" && schedulerTickMatch) {
      const run = runs.get(schedulerTickMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const result = await runSchedulerTurn(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const autopilotMatch = url.pathname.match(/^\/missions\/([^/]+)\/autopilot$/);
    if (request.method === "POST" && autopilotMatch) {
      const run = runs.get(autopilotMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const body = await readJson<{ cycles?: number }>(request);
      const result = await runAutopilot(run, Math.min(Math.max(body.cycles ?? 300, 1), 300));
      sendJson(response, 200, result);
      return;
    }

    const reasoningMatch = url.pathname.match(/^\/missions\/([^/]+)\/reasoning$/);
    if (request.method === "GET" && reasoningMatch) {
      const run = runs.get(reasoningMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        mode: run.mode,
        runDir: run.store.runDir,
        artifactsDir: run.store.artifactsDir,
        artifacts: run.reasoningArtifacts
      });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/missions\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const run = runs.get(eventsMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream"
      });

      run.subscribers.add(response);
      writeSse(response, "state", run.state);

      request.on("close", () => {
        run.subscribers.delete(response);
      });
      return;
    }

    notFound(response);
  } catch (error) {
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(port, () => {
  console.log(`orvix-api listening on http://localhost:${port}`);
});
