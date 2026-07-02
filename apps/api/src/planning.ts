import {
  applyMissionAnalysis,
  applyOrganizationDesign,
  createInitialSimulation,
  createRunStore,
  nudgeActiveProgress,
  writeRunManifest,
  writeStateSnapshot,
  writeTaskGraphArtifact,
  type OrganizationDesign,
  type SimulationState
} from "@orvix/core";
import {
  isQwenConfigured,
  QwenClient,
  type OrvixMap,
  type QwenPlanningCouncilDraft,
  type QwenPlanningResearchRequest,
  type QwenProjectScaffoldDecision
} from "@orvix/qwen";
import { createMissionWorkspace, listWorkspaceFiles, type ProjectScaffoldType } from "@orvix/workspace";
import { projectRoot, workspaceRoot } from "./envConfig.js";
import {
  addReasoningArtifact,
  appendEvent,
  broadcast,
  orvixMapContext,
  recordPlanningStage,
  runs,
  scheduleNextStep,
  scheduleOrchestratorStep,
  workspaceOf,
  type MissionRun,
  type PlanningResearchResult
} from "./run.js";
import { normalizeBookEntryType, normalizeBookPriority, planningBookContext, postBookEntry } from "./book.js";
import { fetchUrlForAgent, researchWeb } from "./research.js";
import { startAutomaticAutopilot } from "./scheduler.js";

export function planningResearchContext(run: MissionRun) {
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

export function scaffoldContext(run: MissionRun) {
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
    type: run.workspace?.projectType ?? "generic",
    files: []
  };
}

export function createEmergencyOrvixMap(run: MissionRun, reason: string): OrvixMap {
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

export async function bootstrapQwenReasoning(run: MissionRun) {
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

  let stageStartedAt = Date.now();
  recordPlanningStage(run, "analysis", "started");
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
    recordPlanningStage(run, "analysis", "completed", undefined, Date.now() - stageStartedAt);
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
    recordPlanningStage(run, "analysis", "degraded", error instanceof Error ? error.message : "Unknown Qwen error", Date.now() - stageStartedAt);
  }

  stageStartedAt = Date.now();
  recordPlanningStage(run, "orvix_map", "started");
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
    recordPlanningStage(run, "orvix_map", "completed", `Locked v${lockedOrvixMap.version}: ${lockedOrvixMap.surfaces.length} surfaces, ${lockedOrvixMap.agentWorkPackets.length} work packets`, Date.now() - stageStartedAt);
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
    recordPlanningStage(run, "orvix_map", "degraded", `Emergency map locked: ${message}`, Date.now() - stageStartedAt);
  }

  stageStartedAt = Date.now();
  recordPlanningStage(run, "organization", "started");
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
    recordPlanningStage(run, "organization", "completed", `${organizationDesign.agents.length} agents designed`, Date.now() - stageStartedAt);
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
    recordPlanningStage(run, "organization", "degraded", error instanceof Error ? error.message : "Unknown Qwen error", Date.now() - stageStartedAt);
  }

  stageStartedAt = Date.now();
  recordPlanningStage(run, "rubric", "started");
  try {
    appendEvent(run, "Critic Council rubric drafting started with Qwen", "info");
    const reviewRubric = await client.reviewPullRequestJson(run.state.pullRequests[1] ?? run.state.pullRequests[0]);
    addReasoningArtifact(run, {
      kind: "review_rubric",
      status: "completed",
      content: JSON.stringify(reviewRubric)
    });
    appendEvent(run, "Qwen Critic Council prepared PR review rubric", "success");
    recordPlanningStage(run, "rubric", "completed", undefined, Date.now() - stageStartedAt);
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
    recordPlanningStage(run, "rubric", "degraded", error instanceof Error ? error.message : "Unknown Qwen error", Date.now() - stageStartedAt);
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

export async function chooseInitialScaffold(
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

export async function draftInitialPlanningCouncil(
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

export function fallbackPlanningResearchRequest(mission: string, analysis: SimulationState["analysis"], error?: string): QwenPlanningResearchRequest {
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

export async function executePlanningResearch(request: QwenPlanningResearchRequest, fallback?: boolean, error?: string): Promise<PlanningResearchResult> {
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

export async function draftInitialPlanningResearch(
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

export function normalizeScaffoldType(value: unknown): ProjectScaffoldType | undefined {
  const allowed: ProjectScaffoldType[] = ["nextjs", "react-vite", "express-api", "node-cli", "python", "generic"];
  return allowed.includes(value as ProjectScaffoldType) ? value as ProjectScaffoldType : undefined;
}

export function createRun(mission: string, mode: "mock" | "qwen") {
  const initial = createInitialSimulation(mission);
  const store = createRunStore(initial.analysis.id, projectRoot);
  const run: MissionRun = {
    id: initial.analysis.id,
    mission,
    mode,
    state: initial,
    stepIndex: 0,
    reasoningArtifacts: [],
    store,
    workspace: undefined,
    planningStages: [],
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
  writeStateSnapshot(store, run.state, run.reasoningArtifacts);
  runs.set(run.id, run);

  if (mode === "qwen" && isQwenConfigured()) {
    void runPlanningPipeline(run).catch((error) => {
      appendEvent(run, `Planning pipeline crashed: ${error instanceof Error ? error.message : "Unknown error"}`, "warning");
    });
    return run;
  }

  run.workspace = createMissionWorkspace({
    missionId: run.id,
    mission,
    mode,
    root: workspaceRoot
  });
  recordProjectBootstrap(run, null);
  if (mode === "qwen") {
    appendEvent(run, "Qwen reasoning skipped: DASHSCOPE_API_KEY is missing", "warning");
    scheduleOrchestratorStep(run);
  } else {
    scheduleNextStep(run);
  }
  return run;
}

/**
 * Background planning pipeline: research → council → scaffold/workspace →
 * analysis → Orvix Map → organization → review rubric. POST /missions returns
 * before this starts; every stage broadcasts an honest planning SSE event.
 */
async function runPlanningPipeline(run: MissionRun) {
  appendEvent(run, "Mission accepted; Qwen planning pipeline is running in the background", "info");

  let stageStartedAt = Date.now();
  recordPlanningStage(run, "research", "started");
  const planningResearch = await draftInitialPlanningResearch(run.mission, run.mode, run.state.analysis);
  recordPlanningStage(
    run,
    "research",
    planningResearch?.fallback ? "degraded" : "completed",
    planningResearch?.fallback ? planningResearch.error ?? "Qwen research scout unavailable; fallback queries used" : undefined,
    Date.now() - stageStartedAt
  );
  recordPlanningResearch(run, planningResearch);

  stageStartedAt = Date.now();
  recordPlanningStage(run, "council", "started");
  const planningCouncil = await draftInitialPlanningCouncil(run.mission, run.mode, run.state.analysis, planningResearch);
  recordPlanningStage(
    run,
    "council",
    planningCouncil ? "completed" : "degraded",
    planningCouncil ? undefined : "Qwen planning council unavailable; continuing without kickoff entries",
    Date.now() - stageStartedAt
  );
  recordPlanningCouncil(run, planningCouncil);

  stageStartedAt = Date.now();
  recordPlanningStage(run, "scaffold", "started");
  const scaffoldDecision = await chooseInitialScaffold(run.mission, run.mode, run.state.analysis, planningCouncil, planningResearch);
  run.workspace = createMissionWorkspace({
    missionId: run.id,
    mission: run.mission,
    mode: run.mode,
    root: workspaceRoot,
    scaffoldType: normalizeScaffoldType(scaffoldDecision?.scaffoldType)
  });
  recordProjectBootstrap(run, scaffoldDecision);
  recordPlanningStage(
    run,
    "scaffold",
    scaffoldDecision ? "completed" : "degraded",
    scaffoldDecision
      ? `${scaffoldDecision.label}: ${scaffoldDecision.rationale}`.slice(0, 300)
      : "Qwen scaffold decision unavailable; MasterMind used local project detection",
    Date.now() - stageStartedAt
  );

  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  await bootstrapQwenReasoning(run);
}

function recordPlanningResearch(run: MissionRun, planningResearch: PlanningResearchResult | null) {
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
}

function recordPlanningCouncil(run: MissionRun, planningCouncil: QwenPlanningCouncilDraft | null) {
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
}

export function scaffoldLabel(type: ProjectScaffoldType | undefined) {
  if (type === "nextjs") return "Next.js App Router";
  if (type === "react-vite") return "Vite React App";
  if (type === "express-api") return "Express API";
  if (type === "node-cli") return "Node TypeScript CLI";
  if (type === "python") return "Python Project";
  return "Generic Project";
}

export function scaffoldCommands(type: ProjectScaffoldType | undefined, decision?: QwenProjectScaffoldDecision | null) {
  if (decision?.commands?.length) return decision.commands;
  if (type === "nextjs" || type === "react-vite" || type === "express-api") {
    return ["npm install", "npm run dev", "npm run build"];
  }
  if (type === "node-cli") return ["npm install", "npm run build", "node dist/index.js"];
  if (type === "python") return ["python src/main.py"];
  return ["npm test"];
}

export function recordProjectBootstrap(run: MissionRun, decision?: QwenProjectScaffoldDecision | null) {
  const workspace = workspaceOf(run);
  const filesResult = listWorkspaceFiles(workspace, { depth: 3 });
  const files = filesResult.ok && filesResult.tool === "list_files"
    ? filesResult.files.map((file) => file.path).sort()
    : [];
  const label = decision?.label || scaffoldLabel(workspace.projectType);
  const commands = scaffoldCommands(workspace.projectType, decision);
  const rationale = decision?.rationale || `MasterMind selected ${label} using Orvix's local project detection because the user did not provide a more specific stack decision.`;

  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    message: `Project bootstrap complete: ${label}. Decision rationale: ${rationale} Specialist agents must build inside this runnable scaffold instead of inventing a new root layout. Suggested verification commands: ${commands.join(" → ")}.`,
    scope: "mission",
    visibility: "global",
    topics: ["bootstrap", "scaffold", workspace.projectType ?? "generic"],
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
        type: workspace.projectType ?? "generic",
        label,
        rationale,
        files,
        commands
      },
      results: []
    })
  });
}

