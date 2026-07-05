import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { progressBar } from "../lib/progress.js";
import { theme, glyphs } from "../lib/theme.js";
import { bottomWindow, scrollbarGlyph, hitTestRegions, parseMouseEvents, type Rect } from "../lib/scroll.js";
import type { PlanningStageEvent, PlanningStageId, ReasoningArtifact, SimulationState } from "../types.js";
import { cliConfig } from "../lib/config.js";

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

type Line = { id: string; node: React.ReactNode };

function wrappedLines(id: string, value: string, width: number, color?: string): Line[] {
  return wrapText(value, width).map((line, index) => ({
    id: `${id}-${index}`,
    node: <Text color={color}>{line}</Text>
  }));
}

function labeledWrappedLines(id: string, label: string, value: string, width: number, labelColor: string = theme.muted, textColor?: string): Line[] {
  const wrapped = wrapText(value, Math.max(8, width - label.length));
  return wrapped.map((line, index) => ({
    id: `${id}-${index}`,
    node: (
      <Text>
        {index === 0 ? <Text color={labelColor}>{label}</Text> : <Text>{" ".repeat(label.length)}</Text>}
        <Text color={textColor}>{line}</Text>
      </Text>
    )
  }));
}

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
  mission_brief: "MasterMind debrief",
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
      for (const query of stringArray(request.queries)) {
        events.push(`research: ${query}`);
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
  return events;
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
  return state.bookEntries.filter((entry) =>
    entry.scope === "mission" &&
    (/planner|mastermind|strategy|architecture|runtime|delivery|bootstrap/i.test(entry.fromAgentId) ||
      entry.topics.some((topic) => /planning|mission|stack|acceptance|bootstrap|scaffold|research|search/i.test(topic)))
  );
}

function shortAgentName(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b(agent|planner|specialist|lead)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || value;
}

type BroadcastEntry = {
  id: string;
  agent: string;
  message: string;
  color: string;
};

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

  for (const entry of state.bookEntries.filter((candidate) => candidate.scope === "mission")) {
    entries.push({
      id: entry.id,
      agent: shortAgentName(entry.fromAgentId),
      message: entry.message,
      color: entry.priority === "urgent" || entry.priority === "high" ? theme.warning : theme.muted
    });
  }

  for (const event of state.events) {
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

  for (const agent of state.agents.filter((candidate) => candidate.status === "active" || candidate.status === "blocked")) {
    entries.push({
      id: `${agent.id}-${agent.progress}`,
      agent: agent.name,
      message: agent.currentActivity,
      color: agent.status === "blocked" ? theme.warning : theme.accent
    });
  }

  return entries;
}

function AgentBadge({ label, color, width }: { label: string; color: string; width: number }) {
  return (
    <Text color={color} bold>
      {fit(`${glyphs.dot} ${shortAgentName(label)}`, width)}
    </Text>
  );
}

function broadcastLines(entries: BroadcastEntry[], width: number): Line[] {
  if (entries.length === 0) {
    return [{
      id: "broadcast-empty",
      node: <Text color={theme.muted}>Waiting for planner agents to publish analysis, Orvix Map, and organization signals.</Text>
    }];
  }

  return entries.flatMap((entry) => {
    const badgeWidth = Math.min(20, Math.floor(width * 0.3));
    const messageWidth = Math.max(16, width - badgeWidth - 1);
    const wrapped = wrapText(entry.message, messageWidth);
    return wrapped.map((line, index) => ({
      id: `${entry.id}-${index}`,
      node: (
        <Text>
          {index === 0 ? <AgentBadge label={entry.agent} color={entry.color} width={badgeWidth} /> : <Text>{" ".repeat(badgeWidth)}</Text>}
          <Text> </Text>
          <Text color={entry.color === theme.accent ? theme.text : entry.color}>{line}</Text>
        </Text>
      )
    }));
  });
}

type BookLine = { id: string; kind: string; from: string; message: string; color: string };

function bookAndResearchLines(state: SimulationState, artifacts: ReasoningArtifact[]): BookLine[] {
  const lines: BookLine[] = planningBookEntries(state).map((entry) => ({
    id: entry.id,
    kind: entry.type,
    from: shortAgentName(entry.fromAgentId),
    message: entry.message,
    color: entry.type === "question" ? theme.warning : entry.type === "contract" || entry.type === "decision" ? theme.success : theme.cloud
  }));

  for (const [index, item] of researchEvents(artifacts).entries()) {
    const [kind, ...rest] = item.split(": ");
    lines.push({
      id: `research-${index}`,
      kind: kind ?? "research",
      from: "Research Scout",
      message: rest.join(": "),
      color: theme.success
    });
  }

  return lines;
}

function bookLines(entries: BookLine[], width: number): Line[] {
  if (entries.length === 0) {
    return [{
      id: "book-empty",
      node: <Text color={theme.muted}>Waiting for planning agents to publish mission, stack, and acceptance notes into Orvix Book.</Text>
    }];
  }

  return entries.flatMap((entry) =>
    labeledWrappedLines(entry.id, `${fit(entry.kind, 10)}`, `${entry.from}: ${entry.message}`, width, entry.color, entry.color === theme.muted ? undefined : theme.text)
  );
}

function traceEntries(artifacts: ReasoningArtifact[]) {
  const entries: Array<{ id: string; label: string; body: string; color: string }> = [];
  for (const artifact of artifacts) {
    entries.push({
      id: artifact.id,
      label: artifactLabels[artifact.kind] ?? artifact.kind,
      body: summarizeArtifact(artifact),
      color: artifact.status === "failed" ? theme.warning : theme.cloud
    });
    if (artifact.reasoningContent) {
      entries.push({
        id: `${artifact.id}-reasoning`,
        label: "reasoning",
        body: artifact.reasoningContent.replace(/\s+/g, " ").slice(0, 260),
        color: theme.warning
      });
    }
  }
  return entries;
}

function traceLines(entries: ReturnType<typeof traceEntries>, width: number): Line[] {
  if (entries.length === 0) {
    return [{ id: "trace-empty", node: <Text color={theme.muted}>Waiting for planner reasoning traces.</Text> }];
  }
  return entries.flatMap((entry) => labeledWrappedLines(entry.id, `${fit(entry.label, 20)} `, entry.body, width, theme.muted, entry.color));
}

function promptPreviewText(agent: Record<string, unknown> | undefined) {
  const name = String(agent?.name ?? "Specialist Agent");
  const goal = String(agent?.goal ?? "Own the assigned delivery packet.");
  const tools = stringArray(agent?.tools).slice(0, 5);
  const acceptance = stringArray(agent?.acceptanceCriteria).slice(0, 2);
  return [
    `You are ${name}.`,
    `Goal: ${goal}`,
    `Tools: ${tools.length ? tools.join(", ") : "workspace tools assigned by MasterMind"}.`,
    `Acceptance: ${acceptance.length ? acceptance.join("; ") : "produce reviewable code and PR evidence"}.`,
    "Coordinate through Orvix Book, continue with explicit assumptions, update visible product surfaces, then open a PR."
  ].join(" ");
}

type PanelId = "broadcast" | "book" | "trace";
const panelIds: PanelId[] = ["broadcast", "book", "trace"];
const panelTitles: Record<PanelId, string> = {
  broadcast: "Planner Broadcast",
  book: "Orvix Book & Research",
  trace: "Planner Trace & Prompt"
};

/** Fixed-row-count scrollable feed: exactly `rows` slots every frame (never grows/shrinks the box), bottom-anchored, with a scrollbar when content overflows. */
function ScrollFeed({
  lines,
  rows,
  scrollOffset,
  width,
  focused,
  interactive
}: {
  lines: Line[];
  rows: number;
  scrollOffset: number;
  width: number;
  focused: boolean;
  interactive: boolean;
}) {
  const windowed = bottomWindow(lines, rows, scrollOffset);
  const lineWidth = Math.max(10, width - (interactive ? 2 : 0));

  return (
    <Box flexDirection="column">
      {Array.from({ length: rows }).map((_, index) => {
        const line = windowed.visible[index];
        return (
          <Box key={line?.id ?? `empty-${index}`}>
            <Box width={lineWidth}>{line?.node ?? <Text> </Text>}</Box>
            {interactive ? (
              <Box width={1}>
                <Text color={focused ? theme.accent : theme.faint}>{scrollbarGlyph(index, rows, windowed.total, windowed.start)}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function PanelFrame({
  title,
  width,
  focused,
  hint,
  children
}: {
  title: string;
  width: number;
  focused: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  const innerWidth = Math.max(16, width - 4);
  const hintWidth = hint ? Math.min(hint.length, Math.floor(innerWidth * 0.4)) : 0;
  const titleWidth = Math.max(8, innerWidth - (hintWidth ? hintWidth + 1 : 0));

  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={focused ? theme.accent : theme.border} paddingX={1} paddingY={1}>
      <Box justifyContent="space-between">
        <Text color={focused ? theme.accent : theme.muted} bold>{fit(`${focused ? `${glyphs.ring} ` : ""}${title}`, titleWidth)}</Text>
        {hint ? <Text color={theme.faint}>{fit(hint, hintWidth)}</Text> : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
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
  const { stdin, isRawModeSupported } = useStdin();
  const width = Math.max(72, stdout.columns ?? 80);
  const termRows = stdout.rows ?? 34;

  const [scroll, setScroll] = useState<Record<PanelId, number>>({ broadcast: 0, book: 0, trace: 0 });
  const [focus, setFocus] = useState<PanelId>("broadcast");
  const regionsRef = useRef<Partial<Record<PanelId, Rect>>>({});

  // Both feed rows (plus header and borders) must fit the real terminal
  // height — the console previously used fixed heights and overflowed
  // smaller windows. Chrome = header (3-4 rows) + per-row borders/padding.
  // Slightly generous chrome estimate: underestimating clips the TOP of the
  // frame (ink anchors to the bottom of the terminal), which is much worse
  // than feeds being a row shorter than they could be.
  const chromeRows = (mode === "cloud" ? 4 : 3) + 14;
  const FEED_ROWS = Math.max(3, Math.min(14, Math.floor((termRows - chromeRows) / 2)));
  const compact = FEED_ROWS < 9;

  function scrollPanel(panel: PanelId, delta: number) {
    setScroll((current) => ({ ...current, [panel]: Math.max(0, (current[panel] ?? 0) + delta) }));
  }

  useInput((input, key) => {
    if (key.tab) {
      setFocus((current) => panelIds[(panelIds.indexOf(current) + 1) % panelIds.length]);
      return;
    }
    if (key.upArrow) scrollPanel(focus, 1);
    if (key.downArrow) scrollPanel(focus, -1);
    if (key.pageUp) scrollPanel(focus, FEED_ROWS);
    if (key.pageDown) scrollPanel(focus, -FEED_ROWS);
  });

  useEffect(() => {
    // Raw mode itself is already owned by the useInput() hook above (Ink
    // ref-counts it); this effect only toggles mouse reporting modes.
    // Disabled entirely via ~/.orvix/cli.json mouseTrack:false (slow SSH).
    if (!cliConfig.mouseTrack || !stdin || !isRawModeSupported) return;
    process.stdout.write("[?1000h[?1003h[?1006h");

    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const event of parseMouseEvents(text)) {
        const hit = hitTestRegions(event.x, event.y, regionsRef.current);
        if (!hit) continue;
        if (event.kind === "move") {
          setFocus((current) => (current === hit ? current : hit));
        } else {
          setFocus(hit);
          scrollPanel(hit, event.delta);
        }
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.stdout.write("[?1000l[?1003l[?1006l");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdin, isRawModeSupported]);

  const latestEvent = state.events[state.events.length - 1];
  const missionAnalysis = parseArtifact(artifactByKind(reasoningArtifacts, "mission_analysis"));
  const organizationDesign = parseArtifact(artifactByKind(reasoningArtifacts, "organization_design"));
  const bootstrap = bootstrapPayload(reasoningArtifacts);
  const designedAgents = objectArray(organizationDesign?.agents);
  const featuredAgent = designedAgents.find((agent) => !String(agent.name ?? "").toLowerCase().includes("mastermind")) ?? designedAgents[0];
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
  const missionPanelWidth = Math.floor(width * 0.38);
  const orgPanelWidth = Math.floor(width * 0.34);
  const railWidth = width - missionPanelWidth - orgPanelWidth;
  const innerMissionWidth = Math.max(24, missionPanelWidth - 4);
  const innerRailWidth = Math.max(20, railWidth - 4);
  const innerOrgWidth = Math.max(24, orgPanelWidth - 4);
  // The mission panel shares row space with the feeds: cap its lists so the
  // left column never grows taller than the adaptive feed boxes beside it.
  const featureList = stringArray(missionAnalysis?.features ?? state.analysis.features).slice(0, Math.max(2, Math.min(5, FEED_ROWS - 4)));
  const riskList = stringArray(missionAnalysis?.risks ?? state.analysis.risks).slice(0, compact ? 2 : 3);
  const visibleTasks = state.tasks.slice(0, Math.max(3, Math.min(6, FEED_ROWS - 3)));
  const leftWidth = Math.floor(width * 0.52);
  const rightWidth = width - leftWidth;

  const broadcasts = broadcastLines(broadcastEntries(state, reasoningArtifacts), innerOrgWidth);
  const bookFeed = bookLines(bookAndResearchLines(state, reasoningArtifacts), Math.max(24, leftWidth - 5));
  const traceFeed = traceLines(traceEntries(reasoningArtifacts), Math.max(24, rightWidth - 5));
  const promptText = promptPreviewText(featuredAgent);
  const traceAndPrompt: Line[] = [
    ...traceFeed,
    { id: "prompt-divider", node: <Text color={theme.faint}>{"─".repeat(Math.max(10, rightWidth - 6))}</Text> },
    { id: "prompt-title", node: <Text color={theme.accent} bold>{glyphs.dot} Sample agent system prompt</Text> },
    ...wrappedLines("prompt-body", promptText, Math.max(24, rightWidth - 5), theme.muted),
    { id: "signal-divider", node: <Text color={theme.faint}>{"─".repeat(Math.max(10, rightWidth - 6))}</Text> },
    ...labeledWrappedLines("latest-signal", "Latest: ", latestEvent?.message ?? "No planner signal yet.", Math.max(24, rightWidth - 5), theme.muted, theme.text)
  ];

  // Header + row heights are computed here (not just guessed at render time)
  // so the hover hit-test regions below stay exactly in sync with what's
  // actually drawn — alt-screen mode (enabled once at app start) guarantees
  // mouse (x, y) are absolute coordinates matching this same numbering.
  const headerContentLines = mode === "cloud" ? 2 : 1;
  const headerHeight = headerContentLines + 2;
  const row1Y0 = headerHeight + 2;
  const row1BoxRows = FEED_ROWS + 2;
  const row1Height = row1BoxRows + 4;
  const row1Y1 = row1Y0 + row1Height - 1;
  const row2Y0 = row1Y1 + 2;
  const row2BoxRows = FEED_ROWS + 2;
  const row2Height = row2BoxRows + 4;
  const row2Y1 = row2Y0 + row2Height - 1;

  regionsRef.current = {
    broadcast: { x0: missionPanelWidth + 1, y0: row1Y0, x1: missionPanelWidth + orgPanelWidth, y1: row1Y1 },
    book: { x0: 1, y0: row2Y0, x1: leftWidth, y1: row2Y1 },
    trace: { x0: leftWidth + 1, y0: row2Y0, x1: width, y1: row2Y1 }
  };

  // Compact "planning ticker" for short terminals (laptops, SSH panes):
  // the rich three-panel layout cannot fit, and ink anchors to the bottom —
  // so instead of clipping the top, collapse to a one-column view: header,
  // stage strip, live feed, latest signal. Everything essential, zero clip.
  if (termRows < 32) {
    const stageShortLabels: Record<PlanningStageId, string> = {
      research: "Research",
      council: "Council",
      scaffold: "Scaffold",
      analysis: "Analysis",
      orvix_map: "Map",
      organization: "Org",
      rubric: "Rubric"
    };
    const compactFeedRows = Math.max(4, Math.min(12, termRows - 13));
    const compactFeed = bookLines(bookAndResearchLines(state, reasoningArtifacts), Math.max(24, width - 7));

    return (
      <Box flexDirection="column" width={width}>
        <Box borderStyle="round" borderColor={theme.accentDim} paddingX={1} justifyContent="space-between">
          <Box>
            <Text color={theme.accentBright} bold>{glyphs.ring} ORVIX</Text>
            <Text color={theme.faint}>  planning  </Text>
            <Text color={theme.text}>{fit(state.analysis.id, 16)}</Text>
          </Box>
          <Text>
            <Text color={theme.muted}>{progressBar(progress, 10)} </Text>
            <Text color={theme.accentBright} bold>{progress}%</Text>
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text>
            {planningStageOrder.map((stage) => {
              const status = latestStage(planningStages, stage)?.status;
              const color = status === "completed" ? theme.success
                : status === "degraded" || status === "failed" ? theme.warning
                  : status === "started" ? theme.cloud : theme.faint;
              const glyph = status === "completed" ? glyphs.done
                : status === "degraded" || status === "failed" ? glyphs.degraded
                  : status === "started" ? glyphs.active : glyphs.queued;
              return (
                <Text key={stage}>
                  <Text color={color}>{glyph} {stageShortLabels[stage]}</Text>
                  <Text color={theme.faint}>{stage === "rubric" ? "" : "  "}</Text>
                </Text>
              );
            })}
          </Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={0}>
          <ScrollFeed lines={compactFeed} rows={compactFeedRows} scrollOffset={scroll.book} width={Math.max(24, width - 6)} focused interactive />
        </Box>
        <Box paddingX={1}>
          <Text color={theme.muted}>{fit(`${glyphs.arrow} ${latestEvent?.message ?? "Waiting for planner signal…"}`, Math.max(24, width - 4))}</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={theme.faint}>↑/↓ scroll · Ctrl+C exit · widen the terminal for the full planning console</Text>
        </Box>
      </Box>
    );
  }

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
              <Text key={`feature-${index}`} color={theme.success}>{glyphs.done} {fit(feature, Math.max(12, innerMissionWidth - 2))}</Text>
            ))}
          </Box>
          {!compact ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>Risks MasterMind is watching</Text>
              {riskList.map((risk, index) => (
                <WrappedText key={`risk-${index}`} value={`${glyphs.degraded} ${risk}`} width={innerMissionWidth} color={theme.warning} />
              ))}
            </Box>
          ) : null}
        </Box>

        <PanelFrame title={panelTitles.broadcast} width={orgPanelWidth} focused={focus === "broadcast"} hint={`${broadcasts.length} live`}>
          <ScrollFeed lines={broadcasts} rows={row1BoxRows} scrollOffset={scroll.broadcast} width={innerOrgWidth} focused={focus === "broadcast"} interactive />
        </PanelFrame>

        <Box width={railWidth} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1}>
          <Text color={theme.accent} bold>Launch Rail</Text>
          <Box marginTop={1} flexDirection="column">
            {planningStages.length > 0
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
        <PanelFrame title={panelTitles.book} width={leftWidth} focused={focus === "book"} hint={String(bootstrap ? bootstrap.label ?? bootstrap.type ?? "scaffold set" : "scaffold pending")}>
          <ScrollFeed lines={bookFeed} rows={row2BoxRows} scrollOffset={scroll.book} width={Math.max(24, leftWidth - 5)} focused={focus === "book"} interactive />
        </PanelFrame>

        <PanelFrame title={panelTitles.trace} width={rightWidth} focused={focus === "trace"} hint={`${reasoningArtifacts.length} artifacts`}>
          <ScrollFeed lines={traceAndPrompt} rows={row2BoxRows} scrollOffset={scroll.trace} width={Math.max(24, rightWidth - 5)} focused={focus === "trace"} interactive />
        </PanelFrame>
      </Box>

      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>{glyphs.chevron} </Text>
        <Text color={theme.muted}>
          {fit(
            `Tab focus panel · hover + wheel or ↑/↓ scroll · PageUp/PageDown jump · focused: ${panelTitles[focus]} · q quit`,
            Math.max(20, width - 6)
          )}
        </Text>
      </Box>
    </Box>
  );
}
