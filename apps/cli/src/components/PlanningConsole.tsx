import React from "react";
import { Box, Text, useStdout } from "ink";
import { progressBar } from "../lib/progress.js";
import { theme, glyphs } from "../lib/theme.js";
import type { PlanningStageEvent, PlanningStageId, ReasoningArtifact, SimulationState } from "../types.js";

type PlanningConsoleProps = {
  state: SimulationState;
  mission: string;
  mode: "mock" | "cloud";
  apiUrl: string;
  reasoningArtifacts: ReasoningArtifact[];
  planningStages: PlanningStageEvent[];
};

const planningStageOrder: PlanningStageId[] = ["research", "council", "scaffold", "analysis", "orvix_map", "organization", "rubric"];

const planningStageLabels: Record<PlanningStageId, string> = {
  research: "Planning research",
  council: "Planning council",
  scaffold: "Scaffold selection",
  analysis: "MasterMind analysis",
  orvix_map: "Orvix Map",
  organization: "Strategy org design",
  rubric: "Critic review rubric"
};

function latestStage(stages: PlanningStageEvent[], stage: PlanningStageId) {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].stage === stage) return stages[index];
  }
  return undefined;
}

function stageGlyph(status?: PlanningStageEvent["status"]) {
  if (status === "completed") return glyphs.done;
  if (status === "degraded") return glyphs.degraded;
  if (status === "failed") return glyphs.blocked;
  if (status === "started") return glyphs.active;
  return glyphs.queued;
}

function stageGlyphColor(status?: PlanningStageEvent["status"]) {
  if (status === "completed") return theme.success;
  if (status === "degraded" || status === "failed") return theme.warning;
  if (status === "started") return theme.accent;
  return theme.muted;
}

function formatElapsed(elapsedMs?: number) {
  if (typeof elapsedMs !== "number") return "";
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

const fit = (value: string, width: number) => {
  if (value.length <= width) return value.padEnd(width, " ");
  return `${value.slice(0, Math.max(0, width - 1))}…`;
};

const wrapText = (value: string, width: number) => {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
};

function WrappedText({ value, width, color }: { value: string; width: number; color?: string }) {
  return (
    <Box flexDirection="column">
      {wrapText(value, width).map((line, index) => (
        <Text key={`${line}-${index}`} color={color}>{line}</Text>
      ))}
    </Box>
  );
}

const artifactOrder: Array<ReasoningArtifact["kind"]> = [
  "mission_analysis",
  "orvix_map",
  "organization_design",
  "review_rubric",
  "final_report"
];

const artifactLabels: Record<ReasoningArtifact["kind"], string> = {
  mission_analysis: "MasterMind analysis",
  orvix_map: "Orvix Map",
  organization_design: "Strategy org design",
  review_rubric: "Critic review rubric",
  final_report: "Release report draft",
  agent_execution: "Agent execution trace",
  pr_review: "PR review trace"
};

function artifactStatus(kind: ReasoningArtifact["kind"], artifacts: ReasoningArtifact[]) {
  return artifacts.find((artifact) => artifact.kind === kind)?.status ?? "waiting";
}

function statusGlyph(status: "completed" | "failed" | "waiting") {
  if (status === "completed") return glyphs.done;
  if (status === "failed") return glyphs.degraded;
  return glyphs.queued;
}

function statusColor(status: "completed" | "failed" | "waiting") {
  if (status === "completed") return theme.success;
  if (status === "failed") return theme.warning;
  return theme.muted;
}

function handoffLabel(index: number) {
  if (index === 0) return "User → MasterMind";
  if (index === 1) return "MasterMind → Strategy";
  if (index === 2) return "Strategy → Critic";
  return "Critic → Release";
}

function latestArtifact(artifacts: ReasoningArtifact[]) {
  return artifacts[artifacts.length - 1];
}

function artifactByKind(artifacts: ReasoningArtifact[], kind: ReasoningArtifact["kind"]) {
  return [...artifacts].reverse().find((artifact) => artifact.kind === kind);
}

function parseArtifact(artifact?: ReasoningArtifact): Record<string, unknown> | null {
  if (!artifact?.content) return null;
  try {
    return JSON.parse(artifact.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function objectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function bootstrapPayload(artifacts: ReasoningArtifact[]) {
  for (const artifact of artifacts) {
    if (artifact.kind !== "agent_execution") continue;
    const parsed = parseArtifact(artifact);
    const scaffold = parsed?.scaffold;
    if (scaffold && typeof scaffold === "object" && !Array.isArray(scaffold)) {
      return scaffold as Record<string, unknown>;
    }
  }
  return null;
}

function researchEvents(artifacts: ReasoningArtifact[]) {
  const events: string[] = [];
  for (const artifact of artifacts) {
    const parsed = parseArtifact(artifact);
    if (artifact.kind === "mission_analysis" && parsed?.source === "qwen_planning_research") {
      const planningResearch = parsed.planningResearch && typeof parsed.planningResearch === "object"
        ? parsed.planningResearch as Record<string, unknown>
        : {};
      const request = planningResearch.request && typeof planningResearch.request === "object"
        ? planningResearch.request as Record<string, unknown>
        : {};
      for (const query of stringArray(request.queries).slice(0, 4)) {
        events.push(`planning_search: ${query}`);
      }
      continue;
    }

    if (artifact.kind !== "agent_execution") continue;
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    for (const result of results) {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const call = record.toolCall && typeof record.toolCall === "object" ? record.toolCall as Record<string, unknown> : {};
      const output = record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : {};
      if (call.tool === "research_web") events.push(`research_web: ${String(call.query ?? output.query ?? "query")}`);
      if (call.tool === "fetch_url") events.push(`fetch_url: ${String(call.url ?? output.url ?? "url")}`);
    }
  }
  return events.slice(-4);
}

function summarizeArtifact(artifact?: ReasoningArtifact) {
  if (!artifact) return "Waiting for Qwen to return the first structured reasoning artifact.";
  if (artifact.error) return artifact.error;
  if (!artifact.content) return "Artifact returned without content.";

  try {
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
    if (artifact.kind === "mission_analysis" && parsed.source === "qwen_planning_research") {
      const planningResearch = parsed.planningResearch && typeof parsed.planningResearch === "object"
        ? parsed.planningResearch as Record<string, unknown>
        : {};
      const request = planningResearch.request && typeof planningResearch.request === "object"
        ? planningResearch.request as Record<string, unknown>
        : {};
      return `Planning research ready: ${String(request.summary ?? "search-first context prepared")}`;
    }
    if (artifact.kind === "mission_analysis" && parsed.source === "qwen_planning_council") {
      const planningCouncil = parsed.planningCouncil && typeof parsed.planningCouncil === "object"
        ? parsed.planningCouncil as Record<string, unknown>
        : {};
      return `Planning council ready: ${String(planningCouncil.summary ?? "kickoff entries posted")}`;
    }
    if (artifact.kind === "orvix_map") {
      const surfaces = Array.isArray(parsed.surfaces) ? parsed.surfaces.length : 0;
      const packets = Array.isArray(parsed.agentWorkPackets) ? parsed.agentWorkPackets.length : 0;
      return `Orvix Map locked: ${String(parsed.mapSummary ?? "shared build contract")} · ${surfaces} surfaces · ${packets} packets`;
    }
    if (parsed.fallback) {
      return `${String(parsed.stage ?? artifact.kind)} used fallback: ${String(parsed.error ?? "Qwen output unavailable")}`;
    }
    if (artifact.kind === "mission_analysis") {
      return `Mission classified: ${String(parsed.projectType ?? "software project")} · ${String(parsed.complexity ?? "unknown")} complexity`;
    }
    if (artifact.kind === "organization_design") {
      const agents = Array.isArray(parsed.agents) ? parsed.agents.length : "?";
      return `Organization designed: ${String(parsed.organizationName ?? "dynamic org")} · ${agents} agents created`;
    }
    if (artifact.kind === "review_rubric") {
      return `Review rubric ready: ${String(parsed.decision ?? parsed.status ?? "review prepared")}`;
    }
    return `Final report drafted: ${String(parsed.releaseRecommendation ?? parsed.missionStatus ?? "release recommendation ready")}`;
  } catch {
    return artifact.content.replace(/\s+/g, " ").trim();
  }
}

function planningBookEntries(state: SimulationState) {
  return state.bookEntries
    .filter((entry) =>
      entry.scope === "mission" &&
      (/planner|mastermind|strategy|architecture|runtime|delivery|bootstrap/i.test(entry.fromAgentId) ||
        entry.topics.some((topic) => /planning|mission|stack|acceptance|bootstrap|scaffold|research|search/i.test(topic)))
    )
    .slice(-6);
}

function plannerTraceLines(artifacts: ReasoningArtifact[], events: SimulationState["events"]) {
  const lines: string[] = [];
  for (const artifact of artifacts.slice(-6)) {
    const summary = summarizeArtifact(artifact);
    lines.push(`${artifact.kind}: ${summary}`);
    if (artifact.reasoningContent) {
      lines.push(`reasoning: ${artifact.reasoningContent.replace(/\s+/g, " ").slice(0, 180)}`);
    }
  }

  if (lines.length === 0) {
    lines.push(...events.slice(-4).map((event) => event.message));
  }

  return lines.slice(-6);
}

type BroadcastEntry = {
  id: string;
  agent: string;
  message: string;
  color: string;
};

function shortAgentName(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b(agent|planner|specialist|lead)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || value;
}

function broadcastEntries(state: SimulationState, artifacts: ReasoningArtifact[]): BroadcastEntry[] {
  const entries: BroadcastEntry[] = [];
  for (const artifact of artifacts) {
    const parsed = parseArtifact(artifact);
    if (artifact.kind === "mission_analysis" && parsed?.source === "qwen_planning_research") {
      const planningResearch = parsed.planningResearch && typeof parsed.planningResearch === "object"
        ? parsed.planningResearch as Record<string, unknown>
        : {};
      const request = planningResearch.request && typeof planningResearch.request === "object"
        ? planningResearch.request as Record<string, unknown>
        : {};
      entries.push({
        id: `${artifact.id}-research`,
        agent: "Research Scout",
        message: String(request.summary ?? "Planning search context prepared."),
        color: theme.success
      });
    } else if (artifact.kind === "mission_analysis" && parsed?.source === "qwen_planning_council") {
      const planningCouncil = parsed.planningCouncil && typeof parsed.planningCouncil === "object"
        ? parsed.planningCouncil as Record<string, unknown>
        : {};
      entries.push({
        id: `${artifact.id}-council`,
        agent: "Planning Council",
        message: String(planningCouncil.summary ?? "Kickoff planning entries posted."),
        color: theme.accent
      });
    } else if (artifact.kind === "orvix_map") {
      entries.push({
        id: `${artifact.id}-map`,
        agent: artifact.status === "failed" ? "Blueprint Forge" : "Orvix Map",
        message: artifact.error ?? summarizeArtifact(artifact),
        color: artifact.status === "failed" ? theme.warning : theme.accent
      });
    } else if (artifact.reasoningContent) {
      entries.push({
        id: `${artifact.id}-reasoning`,
        agent: artifactLabels[artifact.kind] ?? artifact.kind,
        message: artifact.reasoningContent.replace(/\s+/g, " ").slice(0, 220),
        color: theme.warning
      });
    }
  }

  for (const entry of state.bookEntries.filter((candidate) => candidate.scope === "mission").slice(-12)) {
    entries.push({
      id: entry.id,
      agent: shortAgentName(entry.fromAgentId),
      message: entry.message,
      color: entry.priority === "urgent" || entry.priority === "high" ? theme.warning : theme.muted
    });
  }

  for (const event of state.events.slice(-10)) {
    entries.push({
      id: event.id,
      agent: event.message.includes("Blueprint") || event.message.includes("Orvix Map")
        ? "Blueprint Forge"
        : event.message.includes("Strategy")
          ? "Strategy"
          : event.message.includes("MasterMind")
            ? "MasterMind"
            : event.message.includes("Qwen")
              ? "Qwen"
              : "Orvix",
      message: event.message,
      color: event.severity === "warning" ? theme.warning : event.severity === "success" ? theme.success : theme.muted
    });
  }

  for (const agent of state.agents.filter((candidate) => candidate.status === "active" || candidate.status === "blocked").slice(-8)) {
    entries.push({
      id: `${agent.id}-${agent.progress}`,
      agent: agent.name,
      message: agent.currentActivity,
      color: agent.status === "blocked" ? theme.warning : theme.accent
    });
  }

  return entries.slice(-18);
}

function AgentBadge({ label, color }: { label: string; color: string }) {
  return (
    <Text color={color} bold>
      {fit(`[${shortAgentName(label)}]`, 18)}
    </Text>
  );
}

function PromptPreview({ agent, width }: { agent: Record<string, unknown> | undefined; width: number }) {
  const name = String(agent?.name ?? "Specialist Agent");
  const goal = String(agent?.goal ?? "Own the assigned delivery packet.");
  const tools = stringArray(agent?.tools).slice(0, 5);
  const acceptance = stringArray(agent?.acceptanceCriteria).slice(0, 2);
  const contract = [
    `You are ${name}.`,
    `Goal: ${goal}`,
    `Tools: ${tools.length ? tools.join(", ") : "workspace tools assigned by MasterMind"}.`,
    `Acceptance: ${acceptance.length ? acceptance.join("; ") : "produce reviewable code and PR evidence"}.`,
    "Coordinate through Orvix Book, continue with explicit assumptions, update visible product surfaces, then open a PR."
  ].join(" ");

  return <WrappedText value={contract} width={width} color={theme.muted} />;
}

export function PlanningConsole({
  state,
  mission,
  mode,
  apiUrl,
  reasoningArtifacts,
  planningStages
}: PlanningConsoleProps) {
  const { stdout } = useStdout();
  const width = Math.max(72, stdout.columns ?? 80);
  const leftWidth = Math.floor(width * 0.52);
  const rightWidth = width - leftWidth;
  const latestEvent = state.events[state.events.length - 1];
  const missionAnalysis = parseArtifact(artifactByKind(reasoningArtifacts, "mission_analysis"));
  const organizationDesign = parseArtifact(artifactByKind(reasoningArtifacts, "organization_design"));
  const bootstrap = bootstrapPayload(reasoningArtifacts);
  const designedAgents = objectArray(organizationDesign?.agents);
  const featuredAgent = designedAgents.find((agent) => !String(agent.name ?? "").toLowerCase().includes("mastermind")) ?? designedAgents[0];
  const research = researchEvents(reasoningArtifacts);
  const planningEvents = state.events.filter((event) =>
    /planning|qwen|mastermind|strategy|critic|release|scaffold|autopilot/i.test(event.message)
  );
  const completedStages = planningStageOrder.filter((stage) => {
    const status = latestStage(planningStages, stage)?.status;
    return status === "completed" || status === "degraded";
  }).length;
  const progress = mode === "cloud"
    ? planningStages.length > 0
      ? Math.round((completedStages / planningStageOrder.length) * 100)
      : Math.min(96, reasoningArtifacts.length * 22 + planningEvents.length * 8 + (latestEvent ? 8 : 0))
    : 18;
  const latest = latestArtifact(reasoningArtifacts);
  const rows = stdout.rows ?? 34;
  const compact = rows < 30;
  const missionPanelWidth = Math.floor(width * 0.38);
  const orgPanelWidth = Math.floor(width * 0.34);
  const railWidth = width - missionPanelWidth - orgPanelWidth;
  const innerMissionWidth = Math.max(24, missionPanelWidth - 4);
  const innerOrgWidth = Math.max(24, orgPanelWidth - 4);
  const innerRailWidth = Math.max(20, railWidth - 4);
  const featureList = stringArray(missionAnalysis?.features ?? state.analysis.features).slice(0, compact ? 3 : 5);
  const riskList = stringArray(missionAnalysis?.risks ?? state.analysis.risks).slice(0, compact ? 2 : 3);
  const visibleAgents: Record<string, unknown>[] = designedAgents.length > 0
    ? designedAgents.slice(0, compact ? 4 : 6)
    : state.agents.slice(0, compact ? 4 : 6).map((agent) => ({ name: agent.name, role: agent.role, goal: agent.currentActivity }));
  const visibleTasks = state.tasks.slice(0, compact ? 4 : 6);
  const bookEntries = planningBookEntries(state);
  const plannerTrace = plannerTraceLines(reasoningArtifacts, state.events);
  const broadcasts = broadcastEntries(state, reasoningArtifacts);

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} justifyContent="space-between">
        <Box>
          <Text color={theme.accent} bold>{glyphs.ring} ORVIX</Text>
          <Text color={theme.muted}>  planning console  </Text>
          <Text color={theme.text}>{fit(state.analysis.id, 16)}</Text>
        </Box>
        <Text color={mode === "cloud" ? theme.cloud : theme.warning} bold>
          {fit(mode === "cloud" ? `${glyphs.done} Qwen Cloud` : `${glyphs.degraded} Mock demo`, 16)}
        </Text>
      </Box>
      {mode === "cloud" ? (
        <Box paddingX={1}>
          <Text color={theme.faint}>{fit(apiUrl, width - 4)}</Text>
        </Box>
      ) : null}

      <Box width={width} marginTop={1}>
        <Box width={missionPanelWidth} flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={1}>
          <Text color={theme.accent} bold>MasterMind Brief</Text>
          <Box marginTop={1}>
            <Text color={theme.muted}>{progressBar(progress, 16)} </Text>
            <Text>{progress}%</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Request</Text>
            <WrappedText value={mission} width={innerMissionWidth} />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Classification</Text>
            <Text>{fit(`${String(missionAnalysis?.projectType ?? state.analysis.projectType)} · ${String(missionAnalysis?.complexity ?? state.analysis.complexity)}`, innerMissionWidth)}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Features</Text>
            {featureList.map((feature, index) => (
              <Text key={`feature-${index}`} color={theme.success}>✓ {fit(feature, Math.max(12, innerMissionWidth - 2))}</Text>
            ))}
          </Box>
          {!compact ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>Risks MasterMind is watching</Text>
              {riskList.map((risk, index) => (
                <WrappedText key={`risk-${index}`} value={`! ${risk}`} width={innerMissionWidth} color={theme.warning} />
              ))}
            </Box>
          ) : null}
        </Box>

        <Box width={orgPanelWidth} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1}>
          <Text color={theme.accent} bold>Organization Forge</Text>
          <Box marginTop={1} flexDirection="column">
            <Box justifyContent="space-between">
              <Text color={theme.muted}>Planner Broadcast</Text>
              <Text color={theme.muted}>{broadcasts.length} live</Text>
            </Box>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {(broadcasts.length > 0 ? broadcasts.slice(-(compact ? 7 : 11)) : [{
              id: "waiting",
              agent: "MasterMind",
              message: "Waiting for planner agents to publish analysis, Orvix Map, and organization signals.",
              color: theme.muted
            }]).map((entry) => {
              const messageWidth = Math.max(12, innerOrgWidth - 19);
              return (
                <Box key={entry.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <AgentBadge label={entry.agent} color={entry.color} />
                    <WrappedText value={entry.message} width={messageWidth} color={entry.color === theme.accent ? theme.text : entry.color} />
                  </Box>
                </Box>
              );
            })}
          </Box>
          {!compact ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>Company shape</Text>
              <WrappedText
                value={String(organizationDesign?.organizationName ?? "Blueprint Forge, Strategy Weaver, and MasterMind are forming the project-specific agent company.")}
                width={innerOrgWidth}
              />
            </Box>
          ) : null}
        </Box>

        <Box width={railWidth} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1}>
          <Text color={theme.accent} bold>Launch Rail</Text>
          <Box marginTop={1} flexDirection="column">
            {mode === "cloud" && planningStages.length > 0
              ? planningStageOrder.map((stage) => {
                const event = latestStage(planningStages, stage);
                const degraded = event?.status === "degraded" || event?.status === "failed";
                const detailText = degraded
                  ? `degraded: ${event?.detail ?? "unknown reason"}`
                  : event?.status === "started"
                    ? "running…"
                    : event?.status === "completed"
                      ? formatElapsed(event.elapsedMs) || "done"
                      : "waiting";
                return (
                  <Box key={stage} flexDirection="column" marginBottom={1}>
                    <Text>
                      <Text color={stageGlyphColor(event?.status)}>{stageGlyph(event?.status)} </Text>
                      <Text>{fit(planningStageLabels[stage], innerRailWidth)}</Text>
                    </Text>
                    <Text color={degraded ? theme.warning : theme.muted}>  {fit(detailText, innerRailWidth)}</Text>
                  </Box>
                );
              })
              : artifactOrder.map((kind, index) => {
                const status = artifactStatus(kind, reasoningArtifacts);
                return (
                  <Box key={kind} flexDirection="column" marginBottom={1}>
                    <Text>
                      <Text color={statusColor(status)}>{statusGlyph(status)} </Text>
                      <Text>{fit(artifactLabels[kind], innerRailWidth)}</Text>
                    </Text>
                    <Text color={theme.muted}>  {fit(handoffLabel(index), innerRailWidth)}</Text>
                  </Box>
                );
              })}
          </Box>
          {!compact ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>Task graph preview</Text>
              {visibleTasks.map((task, index) => (
                <Text key={task.id}>{fit(`${index + 1}. ${task.ownerAgentId} -> ${task.branch}`, innerRailWidth)}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      </Box>

      <Box width={width} marginTop={1}>
        <Box width={leftWidth} borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1} flexDirection="column">
          <Box justifyContent="space-between">
            <Text color={theme.accent} bold>Planner Book & Scaffold</Text>
            <Text color={theme.muted}>{reasoningArtifacts.length} artifacts · {bookEntries.length} book</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Project bootstrap</Text>
            <WrappedText
              value={bootstrap
                ? `${String(bootstrap.label ?? bootstrap.type ?? "Project scaffold")} · ${String(bootstrap.rationale ?? "selected by MasterMind")}`
                : "Waiting for MasterMind to select and document the runnable project scaffold."}
              width={Math.max(24, leftWidth - 4)}
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Orvix Book kickoff</Text>
            {(bookEntries.length > 0 ? bookEntries : []).map((entry) => (
              <WrappedText
                key={entry.id}
                value={`${entry.fromAgentId}: ${entry.message}`}
                width={Math.max(24, leftWidth - 4)}
                color={entry.priority === "urgent" || entry.priority === "high" ? theme.warning : theme.muted}
              />
            ))}
            {bookEntries.length === 0 ? (
              <WrappedText value="Waiting for planning agents to publish mission, stack, and acceptance notes into Orvix Book." width={Math.max(24, leftWidth - 4)} color={theme.muted} />
            ) : null}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Research lane</Text>
            {(research.length > 0 ? research : ["research_web and fetch_url are armed for agents when docs, current practices, or inspiration are needed."]).map((item, index) => (
              <WrappedText key={`research-${index}`} value={item} width={Math.max(24, leftWidth - 4)} color={research.length > 0 ? theme.success : theme.muted} />
            ))}
          </Box>
        </Box>

        <Box width={rightWidth} borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1} flexDirection="column">
          <Text color={theme.accent} bold>Planner Trace & Prompt</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>What planners are doing</Text>
            {plannerTrace.map((line, index) => (
              <WrappedText key={`planner-trace-${index}`} value={line} width={Math.max(24, rightWidth - 4)} color={line.startsWith("reasoning:") ? theme.warning : theme.muted} />
            ))}
          </Box>
          <Box marginTop={1}>
            <PromptPreview agent={featuredAgent} width={Math.max(24, rightWidth - 4)} />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>Latest signal</Text>
            <WrappedText value={latestEvent?.message ?? summarizeArtifact(latest)} width={Math.max(24, rightWidth - 4)} color={latest?.status === "failed" ? theme.warning : theme.muted} />
          </Box>
        </Box>
      </Box>

      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>› </Text>
        <Text color={theme.muted}>
          {fit(
            mode === "cloud"
              ? "autopilot starts automatically · planner broadcast auto-scrolls latest · Tab/scroll in mission cockpit · q quit"
              : "q quit · MasterMind briefing · Strategy forge · task graph · prompt contracts · research lane",
            Math.max(24, width - 4)
          )}
        </Text>
      </Box>
    </Box>
  );
}
