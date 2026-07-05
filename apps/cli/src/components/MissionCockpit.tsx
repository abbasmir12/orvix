import React from "react";
import { Box, Text, useStdout } from "ink";
import { progressBar, statusSymbol } from "../lib/progress.js";
import { theme, glyphs } from "../lib/theme.js";
import { bottomWindow, scrollbarGlyph } from "../lib/scroll.js";
import type { Agent, AgentCall, AgentCallStatus, AgentTurnEvent, PullRequest, ReasoningArtifact, RunMetricsSummary, SimulationState, TimelineEvent } from "../types.js";

export type CockpitPanel = "focus" | "agents" | "activity" | "input";
export type ActivityTab = "turns" | "signals" | "prs" | "decisions" | "reasoning" | "book";
export type InspectorTab = "overview" | "trace" | "files" | "book" | "review";

type MissionCockpitProps = {
  state: SimulationState;
  selectedAgentIndex: number;
  activePanel: CockpitPanel;
  activityTab: ActivityTab;
  activityScrollOffset: number;
  expandedPanel: CockpitPanel | null;
  reasoningArtifacts: ReasoningArtifact[];
  inspectedAgentIndex: number | null;
  inspectorTab: InspectorTab;
  inspectorScrollOffset: number;
  showMenu: boolean;
  mode: "mock" | "cloud";
  missionId: string | null;
  executionStatus: string;
  agentTurns: AgentTurnEvent[];
  metrics: RunMetricsSummary | null;
  commandDraft: string | null;
  mentionCandidates?: Agent[];
  mentionIndex?: number;
};

const fit = (value: string, width: number) => {
  if (value.length <= width) return value.padEnd(width, " ");
  return `${value.slice(0, Math.max(0, width - 1))}…`;
};

const wrapText = (value: string, width: number) => {
  const targetWidth = Math.max(8, width);
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) continue;
    if (word.length > targetWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += targetWidth) {
        lines.push(word.slice(index, index + targetWidth));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (next.length > targetWidth) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
};

const statusColor = (status: Agent["status"] | PullRequest["status"] | AgentCallStatus) => {
  if (status === "completed" || status === "Approved" || status === "returned") return theme.success;
  if (status === "blocked" || status === "Changes requested") return theme.warning;
  if (status === "active" || status === "In progress" || status === "calling" || status === "running") return theme.accent;
  return theme.muted;
};

const eventColor = (severity: TimelineEvent["severity"]) => {
  if (severity === "success") return theme.success;
  if (severity === "warning") return theme.warning;
  return theme.muted;
};

type ActivityLine = {
  id: string;
  node: React.ReactNode;
};

function textLine(id: string, text: string, width: number, color?: string): ActivityLine[] {
  return wrapText(text, width).map((line, index) => ({
    id: `${id}-${index}`,
    node: <Text color={color}>{index === 0 ? line : `  ${line}`}</Text>
  }));
}

function labeledLines(id: string, label: string, text: string, width: number, labelColor: string = theme.muted, textColor?: string): ActivityLine[] {
  const labelWidth = label.length;
  const wrapped = wrapText(text, Math.max(8, width - labelWidth));
  return wrapped.map((line, index) => ({
    id: `${id}-${index}`,
    node: (
      <Text>
        {index === 0 ? <Text color={labelColor}>{label}</Text> : <Text>{" ".repeat(labelWidth)}</Text>}
        <Text color={textColor}>{line}</Text>
      </Text>
    )
  }));
}

type ParsedExecution = {
  artifact: ReasoningArtifact;
  payload: Record<string, unknown>;
};

type ParsedReview = {
  artifact: ReasoningArtifact;
  payload: Record<string, unknown>;
};

const inspectorTabs: InspectorTab[] = ["overview", "trace", "files", "book", "review"];

type BootstrapArtifact = {
  artifact: ReasoningArtifact;
  payload: Record<string, unknown>;
  scaffold: Record<string, unknown>;
};


const callSymbol = (status: AgentCallStatus) => {
  if (status === "returned") return "✓";
  if (status === "blocked") return "!";
  if (status === "calling" || status === "running") return "•";
  return "○";
};

function PanelTitle({ title, active }: { title: string; active: boolean }) {
  return (
    <Box justifyContent="space-between">
      <Text color={active ? theme.accent : theme.muted} bold>
        {title}
      </Text>
      <Text color={theme.muted}>{active ? "selected" : ""}</Text>
    </Box>
  );
}

const phaseColor = (phase: SimulationState["phase"]) =>
  phase === "final" ? theme.success : phase === "executing" ? theme.cloud : theme.warning;

function TopStatus({ state, width, metrics }: { state: SimulationState; width: number; metrics?: RunMetricsSummary | null }) {
  const active = state.agents.filter((agent) => agent.status === "active").length;
  const blocked = state.agents.filter((agent) => agent.status === "blocked").length;
  const approved = state.pullRequests.filter((pr) => pr.status === "Approved").length;
  const tasksDone = state.tasks.filter((task) => task.status === "completed").length;
  const elapsed = metrics ? `${Math.floor(metrics.wallClockMs / 60000)}:${String(Math.floor((metrics.wallClockMs % 60000) / 1000)).padStart(2, "0")}` : "";
  const sep = <Text color={theme.faint}>  │  </Text>;

  return (
    <Box width={width} borderStyle="round" borderColor={theme.accentDim} paddingX={1} marginBottom={1} justifyContent="space-between">
      <Box>
        <Text color={theme.accentBright} bold>{glyphs.ring} ORVIX</Text>
        <Text color={theme.faint}>  {state.analysis.id}</Text>
        {sep}
        <Text color={phaseColor(state.phase)} bold>{state.phase.toUpperCase()}</Text>
        {sep}
        <Text color={theme.muted}>PRs </Text>
        <Text color={approved === state.pullRequests.length && approved > 0 ? theme.success : theme.text}>{approved}</Text>
        <Text color={theme.faint}>/{state.pullRequests.length}</Text>
        {sep}
        <Text color={theme.muted}>tasks </Text>
        <Text color={theme.text}>{tasksDone}</Text>
        <Text color={theme.faint}>/{state.tasks.length}</Text>
        {sep}
        <Text color={active > 0 ? theme.cloud : theme.muted}>{active}{glyphs.active}</Text>
        <Text color={theme.faint}> </Text>
        <Text color={blocked > 0 ? theme.danger : theme.faint}>{blocked}{glyphs.blocked}</Text>
      </Box>
      {metrics ? (
        <Text>
          <Text color={theme.accent}>{metrics.totalTokens >= 1000 ? `${Math.round(metrics.totalTokens / 1000)}k` : metrics.totalTokens} tok</Text>
          <Text color={theme.faint}> · </Text>
          <Text color={theme.success}>{metrics.filesWritten} files</Text>
          <Text color={theme.faint}> · </Text>
          <Text color={theme.muted}>{elapsed}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

const prStatusColor = (status: string) =>
  status === "Approved" ? theme.success : status === "Changes requested" ? theme.warning : status === "In progress" ? theme.cloud : theme.muted;

function contextMeterColor(percent: number) {
  return percent >= 80 ? theme.danger : percent >= 60 ? theme.warning : theme.success;
}

function FocusPanel({
  state,
  selectedAgent,
  active,
  width,
  agentTurns
}: {
  state: SimulationState;
  selectedAgent: Agent;
  active: boolean;
  width: number;
  agentTurns: AgentTurnEvent[];
}) {
  const relatedPr = state.pullRequests.find((pr) => pr.ownerAgentId === selectedAgent.id || pr.ownerName === selectedAgent.name);
  const ownedTask = state.tasks.find((task) => task.ownerAgentId === selectedAgent.id);
  const progress = Math.round(
    state.agents.reduce((sum, agent) => sum + agent.progress, 0) / Math.max(1, state.agents.length)
  );
  const agentEvents = agentTurns.filter((turn) => turn.agentId === selectedAgent.id);
  const lastTool = [...agentEvents].reverse().find((turn) => turn.kind === "tool");
  const lastContext = [...agentEvents].reverse().find((turn) => turn.context)?.context;

  const contentWidth = Math.max(20, width - 4);
  const nameWidth = Math.max(12, Math.min(24, contentWidth - 10));
  const textWidth = Math.max(14, contentWidth - 1);
  const barWidth = Math.max(10, Math.min(24, contentWidth - 12));

  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={active ? theme.accent : theme.border} paddingX={1} paddingY={1}>
      <PanelTitle title="Focus" active={active} />
      <Box marginTop={1}>
        <Text color={statusColor(selectedAgent.status)}>{statusSymbol(selectedAgent.status)} </Text>
        <Text bold color={theme.text}>{fit(selectedAgent.name, nameWidth)}</Text>
        <Text color={statusColor(selectedAgent.status)}>{selectedAgent.status}</Text>
      </Box>
      <Text color={theme.muted}>{fit(selectedAgent.role, textWidth)}</Text>
      {ownedTask ? (
        <Box marginTop={1}>
          <Text color={theme.faint}>task </Text>
          <Text color={theme.text}>{fit(ownedTask.title, Math.max(12, contentWidth - 6))}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color={theme.faint}>now  </Text>
        <Text color={theme.muted}>{fit(selectedAgent.currentActivity, Math.max(12, contentWidth - 6))}</Text>
      </Box>
      {lastTool ? (
        <Box>
          <Text color={theme.faint}>last </Text>
          <Text color={lastTool.ok === false ? theme.danger : theme.cloud}>{lastTool.tool}</Text>
          <Text color={theme.muted}> {fit(lastTool.path ?? lastTool.detail ?? "", Math.max(8, contentWidth - 7 - (lastTool.tool?.length ?? 0)))}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.faint}>work </Text>
        <Text color={theme.muted}>{progressBar(selectedAgent.progress, barWidth)} </Text>
        <Text color={theme.text}>{selectedAgent.progress}%</Text>
      </Box>
      {lastContext ? (
        <Box>
          <Text color={theme.faint}>ctx  </Text>
          <Text color={contextMeterColor(lastContext.percent)}>{progressBar(Math.min(100, lastContext.percent), barWidth)} </Text>
          <Text color={contextMeterColor(lastContext.percent)}>{lastContext.percent}%</Text>
          <Text color={theme.faint}> of {Math.round(lastContext.windowTokens / 1024)}k</Text>
        </Box>
      ) : null}
      <Box>
        <Text color={theme.faint}>org  </Text>
        <Text color={theme.muted}>{progressBar(progress, barWidth)} </Text>
        <Text color={theme.text}>{progress}%</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.faint}>PR   </Text>
        {relatedPr ? (
          <Text>
            <Text color={theme.text}>#{relatedPr.id} </Text>
            <Text color={prStatusColor(relatedPr.status)}>{relatedPr.status}</Text>
            <Text color={theme.faint}> {fit(relatedPr.branch, Math.max(6, contentWidth - 10 - relatedPr.status.length))}</Text>
          </Text>
        ) : (
          <Text color={theme.faint}>none opened yet</Text>
        )}
      </Box>
    </Box>
  );
}

function AgentsPanel({
  agents,
  selectedAgentIndex,
  active,
  width
}: {
  agents: Agent[];
  selectedAgentIndex: number;
  active: boolean;
  width: number;
}) {
  const contentWidth = Math.max(20, width - 4);
  const nameWidth = Math.max(12, Math.floor(contentWidth * 0.42));
  const activityWidth = Math.max(10, contentWidth - nameWidth - 5);

  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={active ? theme.accent : theme.border} paddingX={1} paddingY={1}>
      <PanelTitle title="Agent Network" active={active} />
      <Box marginTop={1} flexDirection="column">
        {agents.map((agent, index) => (
          <Box key={agent.id}>
            <Box width={2}>
              <Text color={index === selectedAgentIndex ? theme.accent : theme.muted}>{index === selectedAgentIndex ? "›" : " "}</Text>
            </Box>
            <Box width={2}>
              <Text color={statusColor(agent.status)}>{statusSymbol(agent.status)}</Text>
            </Box>
            <Box width={nameWidth}>
              <Text>{fit(agent.name, Math.max(1, nameWidth - 1))}</Text>
            </Box>
            <Text color={theme.muted}>{fit(agent.currentActivity, activityWidth)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ActivityPanel({
  state,
  activityTab,
  scrollOffset,
  active,
  width,
  contentRows,
  reasoningArtifacts,
  agentTurns
}: {
  state: SimulationState;
  activityTab: ActivityTab;
  scrollOffset: number;
  active: boolean;
  width: number;
  contentRows: number;
  reasoningArtifacts: ReasoningArtifact[];
  agentTurns: AgentTurnEvent[];
}) {
  const tabs: ActivityTab[] = ["turns", "signals", "prs", "decisions", "reasoning", "book"];
  const rows = Math.max(3, contentRows);
  const contentWidth = Math.max(20, width - 4);
  const result =
    activityTab === "turns"
      ? agentTurnLines(agentTurns, contentWidth)
      : activityTab === "signals"
      ? signalsLines(state.events, contentWidth)
      : activityTab === "prs"
        ? pullRequestLines(state.pullRequests, contentWidth)
        : activityTab === "decisions"
          ? decisionLines(state, contentWidth)
          : activityTab === "reasoning"
            ? reasoningLines(reasoningArtifacts, contentWidth)
            : orvixBookLines(state, contentWidth);
  const windowed = bottomWindow(result, rows, scrollOffset);
  const position = windowed.total === 0
    ? "0/0"
    : `${windowed.start + 1}-${Math.min(windowed.start + rows, windowed.total)}/${windowed.total}`;
  const lineWidth = Math.max(18, contentWidth - 2);

  return (
    <Box width={width} flexDirection="column" borderStyle="round" borderColor={active ? theme.accent : theme.border} paddingX={1} paddingY={1} marginTop={1}>
	      <Box justifyContent="space-between">
	        <Box>
          {tabs.map((tab, index) => (
            <Box key={tab} marginRight={index < tabs.length - 1 ? 1 : 0}>
              <Text
                backgroundColor={tab === activityTab ? theme.accent : undefined}
                color={tab === activityTab ? "black" : theme.muted}
                bold={tab === activityTab}
              >
                {` ${tab} `}
              </Text>
            </Box>
          ))}
	        </Box>
	        <Text color={theme.muted}>{active ? "↑/↓ scroll" : ""}</Text>
	      </Box>
	      <Box marginTop={1} flexDirection="column" minHeight={rows}>
	        {Array.from({ length: rows }).map((_, index) => {
	          const line = windowed.visible[index];
	          return (
	            <Box key={line?.id ?? `empty-${index}`}>
	              <Box width={lineWidth}>
	                {line?.node ?? <Text> </Text>}
	              </Box>
	              <Box width={1}>
	                <Text color={active ? theme.accent : theme.muted}>{scrollbarGlyph(index, rows, windowed.total, windowed.start)}</Text>
	              </Box>
	            </Box>
	          );
	        })}
	      </Box>
      <Box justifyContent="space-between">
        <Text color={theme.muted}>{fit(position, 18)}</Text>
        <Text color={theme.muted}>{windowed.maxOffset > 0 ? "PageUp/PageDown" : ""}</Text>
      </Box>
    </Box>
  );
}

function agentTurnLines(turns: AgentTurnEvent[], width: number): ActivityLine[] {
  if (turns.length === 0) {
    return [{
      id: "turns-empty",
      node: <Text color={theme.muted}>Waiting for agents to start working — live tool calls will stream here as they happen.</Text>
    }];
  }

  return turns.flatMap((turn) => {
    const time = turn.at.slice(11, 19);
    const label = `${time} ${turn.agentName} `;
    const color = turn.ok === false ? theme.warning : turn.kind === "harness" ? theme.muted : theme.accent;
    const detail = turn.tool
      ? `${turn.tool}${turn.path ? ` ${turn.path}` : ""}${turn.detail ? ` — ${turn.detail}` : ""}`
      : turn.detail ?? (turn.kind === "note" ? "…thinking" : turn.kind);
    return labeledLines(
      `${turn.agentId}-${turn.turn}-${turn.tool ?? turn.kind}-${turn.at}`,
      label,
      detail,
      width,
      color,
      turn.ok === false ? theme.warning : undefined
    );
  });
}

function signalsLines(events: TimelineEvent[], width: number): ActivityLine[] {
  if (events.length === 0) {
    return [{
      id: "signals-empty",
      node: <Text color={theme.muted}>00:00  Waiting for MasterMind delegation.</Text>
    }];
  }

  return events.flatMap((event) =>
    labeledLines(event.id, `${event.time}  `, event.message, width, theme.muted, eventColor(event.severity))
  );
}

function pullRequestLines(pullRequests: PullRequest[], width: number): ActivityLine[] {
  const branchWidth = Math.max(14, Math.floor(width * 0.34));
  const ownerWidth = Math.max(12, Math.floor(width * 0.25));
  const focused = pullRequests.find((pr) => pr.status === "Changes requested") ??
    pullRequests.find((pr) => pr.status === "In progress") ??
    pullRequests.find((pr) => pr.status === "Queued") ??
    pullRequests[0];

  const lines: ActivityLine[] = pullRequests.map((pr) => ({
    id: `pr-${pr.id}`,
    node: (
      <Text>
          <Text color={statusColor(pr.status)}>{statusSymbol(pr.status)} </Text>
          <Text>{fit(`#${pr.id}`, 4)}</Text>
          <Text color={theme.muted}>{fit(pr.branch, branchWidth)}</Text>
          <Text>{fit(pr.ownerName, ownerWidth)}</Text>
          <Text color={statusColor(pr.status)}>{pr.status}</Text>
      </Text>
    )
  }));

  if (focused) {
    lines.push({
      id: `pr-${focused.id}-divider`,
      node: <Text color={theme.muted}>{fit("─".repeat(Math.max(8, width)), width)}</Text>
    });
    lines.push(...labeledLines(`pr-${focused.id}-selected`, "Selected PR: ", `#${focused.id} ${focused.title}`, width));
    lines.push(...labeledLines(`pr-${focused.id}-review`, "Review: ", `${focused.reviewerStatus} · ${focused.status}`, width, theme.muted, statusColor(focused.status)));
    focused.comments.forEach((comment, index) => {
      lines.push(...labeledLines(`pr-${focused.id}-comment-${index}`, "! ", comment, width, theme.warning));
    });
  }

  return lines.length > 0 ? lines : [{ id: "prs-empty", node: <Text color={theme.muted}>No PRs opened yet.</Text> }];
}

function decisionLines(state: SimulationState, width: number): ActivityLine[] {
  const blocked = state.agentCalls.find((call) => call.status === "blocked");
  const review = state.pullRequests.find((pr) => pr.status === "Changes requested");
  const latest = state.events[state.events.length - 1];
  const lines: ActivityLine[] = [
    ...labeledLines("decision-goal", "Mission goal: ", state.analysis.primaryGoal, width),
    ...labeledLines("decision-gate", "Current gate: ", review ? `PR #${review.id} requires changes` : blocked ? blocked.signal : state.isComplete ? "Release approved" : "Execution in progress", width)
  ];

  if (review?.comments.length) {
    lines.push(...labeledLines("decision-why", "Why: ", review.comments[review.comments.length - 1] ?? "", width));
  }

  lines.push(...labeledLines("decision-mastermind", "MasterMind signal: ", latest?.message ?? "Planning has not started.", width));
  lines.push(...labeledLines("decision-next", "Next step: ", review ? "Resolve reviewer comments or escalate scope" : state.isComplete ? "Release is approved only when all PRs pass" : "Continue scheduler execution", width));

  return lines;
}

function orvixBookLines(state: SimulationState, width: number): ActivityLine[] {
  const entries = state.bookEntries;
  const unread = state.agentSignals.filter((signal) => signal.status === "unread").slice(-3);

  if (entries.length === 0) {
    return [
      { id: "book-empty-1", node: <Text color={theme.muted}>Orvix Book has no entries yet.</Text> },
      { id: "book-empty-2", node: <Text color={theme.muted}>Agents will post questions, assumptions, contracts, and decisions here.</Text> }
    ];
  }

  const lines = entries.flatMap((entry) =>
    labeledLines(
      entry.id,
      `${entry.type.padEnd(11, " ")}${entry.fromAgentId.padEnd(18, " ")}`,
      entry.message,
      width,
      entry.type === "question" ? theme.warning : entry.type === "contract" || entry.type === "decision" ? theme.success : theme.accent
    )
  );

  if (unread.length > 0) {
    lines.push({
      id: "book-unread",
      node: <Text color={theme.muted}>{`Unread signals: ${unread.map((signal) => `${signal.toAgentId}:${signal.type}`).join(" · ")}`}</Text>
    });
  }

  return lines;
}

function artifactLabel(kind: ReasoningArtifact["kind"]) {
  if (kind === "mission_analysis") return "MasterMind analysis";
  if (kind === "orvix_map") return "Orvix Map";
  if (kind === "organization_design") return "Strategy org design";
  if (kind === "review_rubric") return "Critic review rubric";
  if (kind === "agent_execution") return "Agent execution";
  if (kind === "pr_review") return "PR review";
  return "Release final report";
}

function summarizeArtifact(artifact: ReasoningArtifact) {
  if (artifact.error) return artifact.error;
  if (!artifact.content) return "Waiting for Qwen content";
  try {
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
    if (artifact.kind === "mission_analysis") {
      return String(parsed.summary ?? parsed.projectType ?? artifact.content);
    }
    if (artifact.kind === "orvix_map") {
      const surfaces = Array.isArray(parsed.surfaces) ? parsed.surfaces.length : 0;
      const packets = Array.isArray(parsed.agentWorkPackets) ? parsed.agentWorkPackets.length : 0;
      return `${String(parsed.mapSummary ?? "Shared build contract")} · ${surfaces} surfaces · ${packets} packets`;
    }
    if (artifact.kind === "organization_design") {
      const agents = Array.isArray(parsed.agents) ? parsed.agents.length : "?";
      return `${String(parsed.organizationName ?? "Dynamic organization")} · ${agents} agents`;
    }
    if (artifact.kind === "review_rubric") {
      return `${String(parsed.decision ?? parsed.status ?? "Review prepared")} · ${Array.isArray(parsed.requestedChanges) ? parsed.requestedChanges.length : 0} requested changes`;
    }
    if (artifact.kind === "agent_execution") {
      const scaffold = parsed.scaffold as { label?: string; files?: unknown[] } | undefined;
      if (scaffold) {
        return `Project bootstrap · ${String(scaffold.label ?? "scaffold")} · ${Array.isArray(scaffold.files) ? scaffold.files.length : 0} files`;
      }
      const agent = parsed.agent as { name?: string } | undefined;
      const task = parsed.task as { title?: string } | undefined;
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const writes = results.filter((entry) => {
        const candidate = entry as { toolCall?: { tool?: string } };
        return candidate.toolCall?.tool === "write_file";
      }).length;
      return `${String(agent?.name ?? "Agent")} · ${writes} files · ${String(task?.title ?? "task execution")}`;
    }
    if (artifact.kind === "pr_review") {
      const decision = parsed.decision as { decision?: string; summary?: string } | undefined;
      return `${String(decision?.decision ?? "review")} · ${String(decision?.summary ?? "PR reviewed")}`;
    }
    return `${String(parsed.releaseRecommendation ?? parsed.missionStatus ?? "Report drafted")} · ${Array.isArray(parsed.nextSteps) ? parsed.nextSteps.length : 0} next steps`;
  } catch {
    return artifact.content.replace(/\s+/g, " ").trim();
  }
}

function parseArtifactContent(artifact: ReasoningArtifact | undefined): Record<string, unknown> | null {
  if (!artifact?.content) return null;
  try {
    return JSON.parse(artifact.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bootstrapArtifacts(artifacts: ReasoningArtifact[]): BootstrapArtifact[] {
  return artifacts.flatMap((artifact) => {
    if (artifact.kind !== "agent_execution" || !artifact.content) return [];
    const payload = parseArtifactContent(artifact);
    const scaffold = recordValue(payload?.scaffold);
    return payload && scaffold ? [{ artifact, payload, scaffold }] : [];
  });
}

function bootstrapBlockLines(bootstrap: BootstrapArtifact, width: number): ActivityLine[] {
  const label = String(bootstrap.scaffold.label ?? bootstrap.scaffold.type ?? "Project scaffold");
  const type = String(bootstrap.scaffold.type ?? "generic");
  const rationale = String(bootstrap.scaffold.rationale ?? `MasterMind selected ${label} as the best starter for this mission.`);
  const files = stringArray(bootstrap.scaffold.files);
  const commands = stringArray(bootstrap.scaffold.commands);
  const lines: ActivityLine[] = [
    transcriptLine(`${bootstrap.artifact.id}-bootstrap-say`, "think", `MasterMind selected ${label}. ${rationale}`, width, theme.text),
    toolPatchCallLine(`${bootstrap.artifact.id}-bootstrap-call`, "InitProject", type, width),
    toolResultLine(`${bootstrap.artifact.id}-bootstrap-result`, `Created ${label} scaffold with ${files.length} files`, width, theme.success)
  ];

  files.slice(0, 18).forEach((file, index) => {
    lines.push({
      id: `${bootstrap.artifact.id}-bootstrap-file-${index}`,
      node: (
        <Text>
          <Text color={theme.success}>✓ </Text>
          <Text>{fit(file, Math.max(12, width - 2))}</Text>
        </Text>
      )
    });
  });

  if (files.length > 18) {
    lines.push(toolResultLine(`${bootstrap.artifact.id}-bootstrap-more`, `${files.length - 18} more scaffold files`, width));
  }

  if (commands.length > 0) {
    lines.push(spacerLine(`${bootstrap.artifact.id}-bootstrap-command-space`));
    lines.push(transcriptLine(`${bootstrap.artifact.id}-bootstrap-commands`, "run", commands.join("  →  "), width, theme.accent));
  }

  return lines;
}

function reasoningLines(artifacts: ReasoningArtifact[], width: number): ActivityLine[] {
  if (artifacts.length === 0) {
    return [
      { id: "reasoning-empty-1", node: <Text color={theme.muted}>Qwen reasoning artifacts will appear here in cloud mode.</Text> },
      { id: "reasoning-empty-2", node: <Text color={theme.muted}>Expected: analysis, organization design, review rubric, final report.</Text> }
    ];
  }

  return artifacts.flatMap((artifact) => {
    const bootstrap = bootstrapArtifacts([artifact])[0];
    if (bootstrap) {
      return bootstrapBlockLines(bootstrap, width);
    }

    return labeledLines(
      artifact.id,
      `${artifact.status === "completed" ? "✓" : "!"} ${artifactLabel(artifact.kind).padEnd(23, " ")}`,
      artifact.artifactPath ?? summarizeArtifact(artifact),
      width,
      artifact.status === "completed" ? theme.success : theme.warning,
      theme.muted
    );
  });
}

function agentDesignedTools(agent: Agent, artifacts: ReasoningArtifact[]) {
  const organization = parseArtifactContent(artifacts.find((artifact) => artifact.kind === "organization_design"));
  const agents = Array.isArray(organization?.agents) ? organization.agents : [];
  const matchingAgent = agents.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return String(record.name ?? "").toLowerCase() === agent.name.toLowerCase()
      || String(record.id ?? "").toLowerCase() === agent.id.toLowerCase();
  }) as Record<string, unknown> | undefined;

  const tools = Array.isArray(matchingAgent?.tools) ? matchingAgent.tools.map(String) : [];
  if (tools.length > 0) return tools.slice(0, 6);

  if (agent.name.toLowerCase().includes("mastermind")) return ["create_task", "assign_task", "resolve_conflict", "approve_release"];
  if (agent.name.toLowerCase().includes("critic") || agent.name.toLowerCase().includes("qa")) return ["review_pr", "request_changes", "approve_pr", "run_tests"];
  return ["read_context", "write_artifact", "open_pr", "report_status"];
}

function agentReasoning(agent: Agent, artifacts: ReasoningArtifact[], width: number) {
  const organization = parseArtifactContent(artifacts.find((artifact) => artifact.kind === "organization_design"));
  const agents = Array.isArray(organization?.agents) ? organization.agents : [];
  const matchingAgent = agents.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return String(record.name ?? "").toLowerCase() === agent.name.toLowerCase()
      || String(record.id ?? "").toLowerCase() === agent.id.toLowerCase();
  }) as Record<string, unknown> | undefined;

	  if (matchingAgent) {
	    return [
	      `Goal: ${String(matchingAgent.goal ?? agent.currentActivity)}`,
	      `Acceptance: ${Array.isArray(matchingAgent.acceptanceCriteria) ? matchingAgent.acceptanceCriteria.slice(0, 2).join("; ") : "Criteria generated by Qwen"}`
	    ];
	  }

  const mission = parseArtifactContent(artifacts.find((artifact) => artifact.kind === "mission_analysis"));
  if (agent.id === "mastermind-agent" && mission) {
	    return [
	      `Mission: ${String(mission.summary ?? "Qwen mission analysis completed")}`,
	      `Risks: ${Array.isArray(mission.risks) ? mission.risks.slice(0, 2).join("; ") : "Risk analysis pending"}`
	    ];
	  }

  return [
    fit(`Reasoning: ${agent.currentActivity}`, width),
    fit("Evidence will expand as real tool execution is connected.", width)
  ];
}

function artifactPayload(artifact: ReasoningArtifact): Record<string, unknown> | null {
  if (!artifact.content) return null;
  try {
    return JSON.parse(artifact.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function agentExecutions(agent: Agent, artifacts: ReasoningArtifact[]): ParsedExecution[] {
  return artifacts.flatMap((artifact) => {
    if (artifact.kind !== "agent_execution") return [];
    const payload = artifactPayload(artifact);
    const payloadAgent = recordValue(payload?.agent);
    const payloadTask = recordValue(payload?.task);
    const matches = payloadAgent?.id === agent.id || payloadAgent?.name === agent.name || payloadTask?.ownerAgentId === agent.id;
    return payload && matches ? [{ artifact, payload }] : [];
  });
}

function agentReviews(agent: Agent, artifacts: ReasoningArtifact[], prs: PullRequest[]): ParsedReview[] {
  const prIds = new Set(prs.map((pr) => pr.id));
  return artifacts.flatMap((artifact) => {
    if (artifact.kind !== "pr_review") return [];
    const payload = artifactPayload(artifact);
    const pr = recordValue(payload?.pr);
    const matches = pr?.ownerAgentId === agent.id || prIds.has(Number(pr?.id));
    return payload && matches ? [{ artifact, payload }] : [];
  });
}

function resultTool(result: unknown) {
  const entry = recordValue(result);
  const toolCall = recordValue(entry?.toolCall);
  const toolResult = recordValue(entry?.result);
  return {
    toolCall,
    result: toolResult,
    tool: String(toolCall?.tool ?? "unknown"),
    path: typeof toolCall?.path === "string" ? toolCall.path : undefined,
    content: typeof toolCall?.content === "string" ? toolCall.content : undefined,
    resultPath: typeof toolResult?.path === "string" ? toolResult.path : undefined,
    afterContent: typeof toolResult?.afterContent === "string" ? toolResult.afterContent : undefined,
    diff: typeof toolResult?.diff === "string" ? toolResult.diff : undefined,
    additions: typeof toolResult?.additions === "number" ? toolResult.additions : undefined,
    removals: typeof toolResult?.removals === "number" ? toolResult.removals : undefined
  };
}

function executionResults(executions: ParsedExecution[]) {
  return executions.flatMap((execution) => Array.isArray(execution.payload.results) ? execution.payload.results : []);
}

function executionMessages(executions: ParsedExecution[]) {
  return executions.flatMap((execution) => {
    const plan = recordValue(execution.payload.plan);
    const messages = stringArray(plan?.agentMessages);
    if (messages.length > 0) return messages;
    const summary = typeof plan?.summary === "string" ? plan.summary : typeof execution.payload.summary === "string" ? execution.payload.summary : "";
    return summary ? [summary] : [];
  });
}

function executionTranscriptEvents(executions: ParsedExecution[]) {
  return executions.flatMap((execution) => {
    const plan = recordValue(execution.payload.plan);
    const transcript = Array.isArray(plan?.transcript) ? plan.transcript : [];
    return transcript.flatMap((entry, index) => {
      const record = recordValue(entry);
      if (!record || typeof record.text !== "string") return [];
      return [{
        id: `${execution.artifact.id}-transcript-${index}`,
        type: typeof record.type === "string" ? record.type : "thought",
        text: record.text,
        beforeToolIndex: numberValue(record.beforeToolIndex),
        tool: typeof record.tool === "string" ? record.tool : undefined,
        path: typeof record.path === "string" ? record.path : undefined
      }];
    });
  });
}

function executionReasoningMessages(executions: ParsedExecution[]) {
  return executions.flatMap((execution) => {
    const qwen = recordValue(execution.payload.qwen);
    const reasoning = typeof execution.artifact.reasoningContent === "string"
      ? execution.artifact.reasoningContent
      : typeof qwen?.reasoningContent === "string"
        ? qwen.reasoningContent
        : "";
    if (!reasoning.trim()) return [];

    return reasoning
      .split(/\n{2,}|\r?\n(?=\d+\.|\- |\* )/)
      .map((line) => line.replace(/^\s*(?:\d+\.|-|\*)\s*/, "").replace(/\s+/g, " ").trim())
      .filter((line) =>
        line.length > 24 &&
        !line.toLowerCase().includes("hidden chain-of-thought") &&
        !line.toLowerCase().startsWith("here's a thinking process")
      )
      .slice(0, 18);
  });
}

function writtenFiles(executions: ParsedExecution[]) {
  return executionResults(executions)
    .map(resultTool)
    .filter((tool) => tool.tool === "write_file" && tool.path);
}

function toolTraceLines(executions: ParsedExecution[], width: number) {
  const lines = executionResults(executions).map((result, index) => {
    const tool = resultTool(result);
    const ok = tool.result?.ok !== false;
    const target = tool.path ?? String(tool.result?.branch ?? tool.result?.output ?? "");
    return {
      id: `tool-${index}`,
      ok,
      line: `${ok ? "✓" : "!"} ${tool.tool}${target ? `  ${target}` : ""}`
    };
  });
  return lines.length > 0 ? lines : [{ id: "tool-empty", ok: true, line: "No tool calls recorded yet" }];
}

function latestReviewDecision(reviews: ParsedReview[]) {
  return recordValue(reviews[reviews.length - 1]?.payload.decision);
}

function reviewDiff(reviews: ParsedReview[]) {
  const latest = reviews[reviews.length - 1];
  return typeof latest?.payload.diff === "string" ? latest.payload.diff : "";
}

type CodePatchRow = {
  id: string;
  kind: "add" | "remove" | "context";
  lineNumber: number | null;
  text: string;
};

type FilePatchBlock = {
  id: string;
  path: string;
  rows: CodePatchRow[];
  additions: number;
  removals: number;
};

function filePathFromDiffLine(line: string) {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return match?.[2];
}

function parseHunkStart(line: string) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return {
    oldLine: match ? Number(match[1]) : 1,
    newLine: match ? Number(match[2]) : 1
  };
}

function patchBlocksFromUnifiedDiff(diff: string) {
  const blocks: FilePatchBlock[] = [];
  let current: FilePatchBlock | null = null;
  let oldLine = 1;
  let newLine = 1;

  for (const rawLine of diff.split(/\r?\n/)) {
    const nextPath = filePathFromDiffLine(rawLine);
    if (nextPath) {
      current = {
        id: `diff-${blocks.length}`,
        path: nextPath,
        rows: [],
        additions: 0,
        removals: 0
      };
      blocks.push(current);
      oldLine = 1;
      newLine = 1;
      continue;
    }

    if (!current || rawLine.startsWith("index ") || rawLine.startsWith("---") || rawLine.startsWith("+++")) {
      continue;
    }

    if (rawLine.startsWith("@@")) {
      const start = parseHunkStart(rawLine);
      oldLine = start.oldLine;
      newLine = start.newLine;
      continue;
    }

    if (rawLine.startsWith("+")) {
      current.additions += 1;
      current.rows.push({
        id: `${current.id}-add-${current.rows.length}`,
        kind: "add",
        lineNumber: newLine,
        text: rawLine.slice(1) || " "
      });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      current.removals += 1;
      current.rows.push({
        id: `${current.id}-remove-${current.rows.length}`,
        kind: "remove",
        lineNumber: oldLine,
        text: rawLine.slice(1) || " "
      });
      oldLine += 1;
      continue;
    }

    if (rawLine.trim()) {
      current.rows.push({
        id: `${current.id}-context-${current.rows.length}`,
        kind: "context",
        lineNumber: newLine,
        text: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return blocks.filter((block) => block.rows.length > 0);
}

function patchBlockFromWrite(path: string, content: string, index: number): FilePatchBlock {
  const rows = content.split(/\r?\n/).slice(0, 18).map((line, lineIndex) => ({
    id: `write-${index}-${lineIndex}`,
    kind: "add" as const,
    lineNumber: lineIndex + 1,
    text: line || " "
  }));

  return {
    id: `write-${index}`,
    path,
    rows,
    additions: rows.length,
    removals: 0
  };
}

function patchSummary(block: FilePatchBlock) {
  const additions = `${block.additions} addition${block.additions === 1 ? "" : "s"}`;
  const removals = block.removals > 0 ? ` and ${block.removals} removal${block.removals === 1 ? "" : "s"}` : "";
  return `Updated ${block.path} with ${additions}${removals}`;
}

function toolPatchCallLine(id: string, tool: string, target: string, width: number): ActivityLine {
  const call = `${tool}(${target})`;
  const wrapped = wrapText(call, Math.max(12, width - 2));
  return {
    id,
    node: (
      <Box flexDirection="column">
        {wrapped.map((line, index) => (
          <Text key={`${id}-${index}`}>
            {index === 0 ? <Text color={theme.success}>● </Text> : <Text>  </Text>}
            <Text color={theme.success} bold>{line}</Text>
          </Text>
        ))}
      </Box>
    )
  };
}

function CodePatchLine({ row, width }: { row: CodePatchRow; width: number }) {
  const numberText = row.lineNumber === null ? "    " : String(row.lineNumber).padStart(4, " ");
  const prefix = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const codeWidth = Math.max(8, width - 8);
  const wrapped = wrapText(row.text, codeWidth);
  const backgroundColor = row.kind === "add" ? theme.success : row.kind === "remove" ? theme.danger : undefined;
  const foregroundColor = row.kind === "context" ? theme.muted : theme.text;

  return (
    <Box flexDirection="column">
      {wrapped.map((line, index) => (
        <Text key={`${row.id}-${index}`}>
          <Text color={theme.muted}>{index === 0 ? numberText : "    "} </Text>
          <Text color={row.kind === "add" ? theme.success : row.kind === "remove" ? theme.danger : theme.muted}>
            {index === 0 ? prefix : " "}
          </Text>
          <Text> </Text>
          <Text color={foregroundColor} backgroundColor={backgroundColor}>
            {fit(line, codeWidth)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function patchBlockLines(block: FilePatchBlock, width: number, maxRows = 18): ActivityLine[] {
  const visibleRows = maxRows > 0 ? block.rows.slice(0, maxRows) : block.rows;
  const lines: ActivityLine[] = [
    toolPatchCallLine(`${block.id}-call`, "Update", block.path, width),
    toolResultLine(`${block.id}-result`, patchSummary(block), width)
  ];

  visibleRows.forEach((row) => {
    lines.push({
      id: row.id,
      node: <CodePatchLine row={row} width={width} />
    });
  });

  if (maxRows > 0 && block.rows.length > visibleRows.length) {
    lines.push(toolResultLine(`${block.id}-more`, `${block.rows.length - visibleRows.length} more changed lines hidden in preview`, width));
  }

  return lines;
}

function spacerLine(id: string): ActivityLine {
  return {
    id,
    node: <Text> </Text>
  };
}

function InspectorTabs({ selected }: { selected: InspectorTab }) {
  return (
    <Box marginTop={1}>
      {inspectorTabs.map((tab, index) => (
        <Box key={tab} marginRight={index < inspectorTabs.length - 1 ? 1 : 0}>
          <Text
            backgroundColor={tab === selected ? theme.accent : undefined}
            color={tab === selected ? "black" : theme.muted}
            bold={tab === selected}
          >
            {` ${tab} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function DossierPanel({
  title,
  meta,
  lines,
  width,
  rows,
  scrollOffset
}: {
  title: string;
  meta: string;
  lines: ActivityLine[];
  width: number;
  rows: number;
  scrollOffset: number;
}) {
  const contentWidth = Math.max(24, width - 5);
  const windowed = bottomWindow(lines.length > 0 ? lines : [{ id: "empty", node: <Text color={theme.muted}>No evidence captured yet.</Text> }], rows, scrollOffset);
  const position = `${windowed.start + 1}-${Math.min(windowed.start + rows, windowed.total)}/${windowed.total}`;

  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1} paddingY={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold>{title}</Text>
        <Text color={theme.muted}>{fit(`${meta} · ${position}`, Math.max(18, width - title.length - 8))}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {Array.from({ length: rows }).map((_, index) => {
          const line = windowed.visible[index];
          return (
            <Box key={line?.id ?? `empty-${index}`}>
              <Box width={contentWidth}>{line?.node ?? <Text> </Text>}</Box>
              <Box width={1}>
                <Text color={theme.accent}>{scrollbarGlyph(index, rows, windowed.total, windowed.start)}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function transcriptLine(id: string, badge: string, text: string, width: number, color: string = theme.accent): ActivityLine {
  const isSpeech = badge === "say" || badge === "think" || badge === "agent" || badge === "goal" || badge === "check";
  const markerColor = isSpeech ? theme.text : color;
  const label = isSpeech ? "" : `${badge} `;
  const prefixWidth = 2 + label.length;
  const wrapped = wrapText(text, Math.max(12, width - prefixWidth));
  return {
    id,
    node: (
      <Box flexDirection="column">
        {wrapped.map((line, index) => (
          <Text key={`${id}-${index}`}>
            {index === 0 ? (
              <>
                <Text color={markerColor}>● </Text>
                {label ? <Text color={color} bold>{label}</Text> : null}
              </>
            ) : (
              <Text>{" ".repeat(prefixWidth)}</Text>
            )}
            {line}
          </Text>
        ))}
      </Box>
    )
  };
}

function toolResultLine(id: string, text: string, width: number, color: string = theme.muted): ActivityLine {
  const wrapped = wrapText(text, Math.max(12, width - 4));
  return {
    id,
    node: (
      <Box flexDirection="column">
        {wrapped.map((line, index) => (
          <Text key={`${id}-${index}`}>
            <Text color={theme.muted}>{index === 0 ? "  └ " : "    "}</Text>
            <Text color={color}>{line}</Text>
          </Text>
        ))}
      </Box>
    )
  };
}

function formatToolCall(result: unknown) {
  const tool = resultTool(result);
  const ok = tool.result?.ok !== false;
  const branch = typeof tool.result?.branch === "string" ? tool.result.branch : undefined;
  const output = typeof tool.result?.output === "string" ? tool.result.output : undefined;
  const bytes = typeof tool.result?.bytes === "number" ? `${tool.result.bytes} bytes` : undefined;
  const patchStats = typeof tool.additions === "number" || typeof tool.removals === "number"
    ? `${tool.additions ?? 0}+ ${tool.removals ?? 0}-`
    : undefined;
  const targetPath = tool.resultPath ?? tool.path;
  const target = targetPath ? `(${targetPath})` : branch ? `(${branch})` : "";
  const resultText = ok
    ? [bytes, patchStats].filter(Boolean).join(" · ") || output || branch || "completed"
    : String(tool.result?.error ?? "failed");
  return {
    ok,
    call: `${tool.tool}${target}`,
    result: resultText
  };
}

type TranscriptEvent = ReturnType<typeof executionTranscriptEvents>[number];

function transcriptColor(event: TranscriptEvent) {
  if (event.type === "decision") return "cyan";
  if (event.type === "handoff") return theme.warning;
  if (event.type === "review_note") return theme.success;
  return theme.text;
}

function transcriptBadge(event: TranscriptEvent) {
  return event.type === "tool_intent" ? "think" : event.type;
}

function transcriptEventLine(event: TranscriptEvent, width: number) {
  return transcriptLine(event.id, transcriptBadge(event), event.text, width, transcriptColor(event));
}

function bucketTranscriptEvents(events: TranscriptEvent[], results: unknown[]) {
  const buckets = Array.from({ length: Math.max(1, results.length) }, () => [] as TranscriptEvent[]);
  const used = new Set<string>();

  for (const event of events) {
    if (event.beforeToolIndex === undefined) continue;
    const index = Math.max(0, Math.min(results.length - 1, event.beforeToolIndex));
    buckets[index]?.push(event);
    used.add(event.id);
  }

  for (const event of events) {
    if (used.has(event.id)) continue;
    const matchingIndex = results.findIndex((result) => {
      const tool = resultTool(result);
      const toolMatches = event.tool ? tool.tool === event.tool : false;
      const eventPath = event.path;
      const resultPath = tool.resultPath ?? tool.path;
      const pathMatches = eventPath ? resultPath === eventPath : true;
      return toolMatches && pathMatches;
    });

    if (matchingIndex >= 0) {
      buckets[matchingIndex]?.push(event);
      used.add(event.id);
    }
  }

  let cursor = 0;
  for (const event of events) {
    if (used.has(event.id)) continue;
    buckets[Math.min(cursor, buckets.length - 1)]?.push(event);
    used.add(event.id);
    cursor += 1;
  }

  return buckets;
}

function toolConversationLines(executions: ParsedExecution[], width: number, options: { fullWriteDiffs?: boolean } = {}) {
  const results = executionResults(executions);
  const transcriptEvents = executionTranscriptEvents(executions);
  const transcriptBuckets = bucketTranscriptEvents(transcriptEvents, results);
  const fallbackReasoning = transcriptEvents.length > 0
    ? []
    : [
        ...executionMessages(executions),
        ...executionReasoningMessages(executions)
      ];
  let fallbackIndex = 0;

  return results.flatMap((result, index) => {
    const transcriptPreface = (transcriptBuckets[index] ?? []).map((event) => transcriptEventLine(event, width));
    const fallbackPreface = transcriptPreface.length === 0 && fallbackReasoning[fallbackIndex]
      ? [transcriptLine(`tool-reasoning-${index}`, "think", fallbackReasoning[fallbackIndex++], width, theme.text)]
      : [];
    const preface = transcriptPreface.length > 0 ? transcriptPreface : fallbackPreface;
    const resultDetails = resultTool(result);
    if (resultDetails.tool === "write_file" && resultDetails.result?.ok !== false) {
      const parsedBlocks = resultDetails.diff ? patchBlocksFromUnifiedDiff(resultDetails.diff) : [];
      const blocks = parsedBlocks.length > 0
        ? parsedBlocks.map((block) => ({
            ...block,
            id: `tool-write-${index}-${block.id}`,
            rows: block.rows.map((row) => ({ ...row, id: `tool-write-${index}-${row.id}` }))
          }))
        : [patchBlockFromWrite(
            resultDetails.resultPath ?? resultDetails.path ?? "file",
            resultDetails.afterContent ?? resultDetails.content ?? "",
            index
          )];

      return [
        ...preface,
        ...blocks.slice(0, 1).flatMap((block) => patchBlockLines(block, width, options.fullWriteDiffs ? 0 : 8)),
        spacerLine(`tool-write-${index}-spacer`)
      ];
    }

    const tool = formatToolCall(result);
    return [
      ...preface,
      transcriptLine(`tool-call-${index}`, tool.ok ? "tool" : "error", tool.call, width, tool.ok ? theme.success : theme.danger),
      toolResultLine(`tool-result-${index}`, tool.result, width, tool.ok ? theme.muted : theme.danger),
      spacerLine(`tool-result-${index}-spacer`)
    ];
  });
}

function AgentInspector({
  state,
  agent,
  agentIndex,
  width,
  reasoningArtifacts,
  inspectorTab,
  inspectorScrollOffset
}: {
  state: SimulationState;
  agent: Agent;
  agentIndex: number;
  width: number;
  reasoningArtifacts: ReasoningArtifact[];
  inspectorTab: InspectorTab;
  inspectorScrollOffset: number;
}) {
  const contentWidth = Math.max(24, width - 4);
  const relatedTasks = state.tasks.filter((task) => task.ownerAgentId === agent.id);
  const relatedPrs = state.pullRequests.filter((pr) => pr.ownerAgentId === agent.id || pr.ownerName === agent.name);
  const relatedCalls = state.agentCalls.filter((call) => call.from === agent.name || call.to === agent.name);
  const executions = agentExecutions(agent, reasoningArtifacts);
  const reviews = agentReviews(agent, reasoningArtifacts, relatedPrs);
  const files = writtenFiles(executions);
  const trace = toolTraceLines(executions, Math.max(24, contentWidth - 6));
  const reviewDecision = latestReviewDecision(reviews);
  const bookEntries = state.bookEntries.filter((entry) => entry.fromAgentId === agent.id || entry.toAgentIds.includes(agent.id));
  const signals = state.agentSignals.filter((signal) => signal.fromAgentId === agent.id || signal.toAgentId === agent.id);
  const reasoning = agentReasoning(agent, reasoningArtifacts, Math.max(24, contentWidth - 2));
  const primaryTask = relatedTasks[0];
  const primaryPr = relatedPrs[0];
  const widePaneWidth = Math.max(24, width - 6);
  const rows = Math.max(8, Math.min(20, (useStdout().stdout.rows ?? 32) - 9));
  const bootstrapLines = agent.id === "mastermind-agent"
    ? bootstrapArtifacts(reasoningArtifacts).flatMap((bootstrap) => bootstrapBlockLines(bootstrap, widePaneWidth))
    : [];
  const reviewPatchBlocks = patchBlocksFromUnifiedDiff(reviewDiff(reviews));
  const writePatchBlocks = files.flatMap((file, index) => {
    const parsedBlocks = file.diff ? patchBlocksFromUnifiedDiff(file.diff) : [];
    if (parsedBlocks.length > 0) {
      return parsedBlocks.map((block) => ({
        ...block,
        id: `write-${index}-${block.id}`,
        rows: block.rows.map((row) => ({ ...row, id: `write-${index}-${row.id}` }))
      }));
    }
    return [patchBlockFromWrite(file.resultPath ?? file.path ?? "file", file.afterContent ?? file.content ?? "", index)];
  });
  const filePatchBlocks = writePatchBlocks.length > 0
    ? writePatchBlocks
    : reviewPatchBlocks;
  const toolConversation = toolConversationLines(executions, widePaneWidth, { fullWriteDiffs: true });
  const bookTranscript = bookEntries.slice(-4).flatMap((entry, index) => [
    ...(index > 0 ? [spacerLine(`overview-book-spacer-${index}`)] : []),
    transcriptLine(`book-${entry.id}`, entry.type, entry.message, widePaneWidth, entry.type === "question" ? theme.warning : "cyan")
  ]);
	  const overviewLines: ActivityLine[] = [
	    transcriptLine("agent-role", "agent", `${agent.name} owns ${agent.role}.`, widePaneWidth, theme.accent),
	    spacerLine("overview-after-sayings"),
	    ...bootstrapLines,
	    ...(bootstrapLines.length > 0 ? [spacerLine("overview-after-bootstrap")] : []),
	    transcriptLine("goal", "goal", reasoning[0] ?? agent.currentActivity, widePaneWidth, "cyan"),
	    transcriptLine("acceptance", "check", reasoning[1] ?? "Acceptance criteria generated by mission plan.", widePaneWidth, theme.success),
	    transcriptLine("branch", "branch", primaryTask?.branch ?? "No branch assigned yet.", widePaneWidth, "blue"),
	    transcriptLine("pr", "pr", primaryPr ? `PR #${primaryPr.id} is ${primaryPr.status}.` : "No PR opened yet.", widePaneWidth, primaryPr?.status === "Approved" ? theme.success : theme.warning),
	    toolResultLine("files", `${files.length} file write operation${files.length === 1 ? "" : "s"} captured.`, widePaneWidth),
	    spacerLine("overview-before-tools"),
	    ...toolConversation,
	    spacerLine("overview-after-tools"),
	    ...bookTranscript,
	    spacerLine("overview-after-book"),
	    transcriptLine("review", "review", String(reviewDecision?.summary ?? primaryPr?.summary ?? "Reviewer has not posted a decision yet."), widePaneWidth, primaryPr?.status === "Approved" ? theme.success : theme.warning)
	  ];
	  const traceLines = [
	    ...bootstrapLines,
	    ...(bootstrapLines.length > 0 ? [spacerLine("trace-after-bootstrap")] : []),
	    ...toolConversation
	  ];
  const fileLines: ActivityLine[] = filePatchBlocks.length > 0
    ? filePatchBlocks.flatMap((block, index) => [
        ...(index > 0 ? [spacerLine(`file-spacer-${index}`)] : []),
        ...patchBlockLines(block, widePaneWidth, 0)
      ])
    : [transcriptLine("files-empty", "file", "No file writes captured yet.", widePaneWidth, theme.muted)];
  const bookLines = bookEntries.flatMap((entry, index) => [
    ...(index > 0 ? [spacerLine(`book-spacer-${index}`)] : []),
    transcriptLine(`book-${entry.id}`, entry.type, `${entry.fromAgentId}: ${entry.message}`, widePaneWidth, entry.type === "question" ? theme.warning : entry.type === "answer" ? theme.success : "cyan")
  ]);
  const reviewLines: ActivityLine[] = [
    transcriptLine("review-pr", "pr", primaryPr ? `#${primaryPr.id} ${primaryPr.branch} · ${primaryPr.status}` : "No PR opened yet.", widePaneWidth, primaryPr?.status === "Approved" ? theme.success : theme.warning),
    transcriptLine("review-summary", "review", String(reviewDecision?.summary ?? primaryPr?.summary ?? "No review yet"), widePaneWidth, primaryPr?.status === "Approved" ? theme.success : theme.warning),
    ...stringArray(reviewDecision?.comments).map((comment, index) => transcriptLine(`comment-${index}`, "ok", comment, widePaneWidth, theme.success)),
    ...stringArray(reviewDecision?.risks).map((risk, index) => transcriptLine(`risk-${index}`, "risk", risk, widePaneWidth, theme.warning))
  ];
  const tabLines = inspectorTab === "overview" ? overviewLines :
    inspectorTab === "trace" ? traceLines :
      inspectorTab === "files" ? fileLines :
        inspectorTab === "book" ? bookLines :
          reviewLines;
  const tabTitle = inspectorTab === "overview" ? "Agent Reasoning & Transcript" :
    inspectorTab === "trace" ? "Tool Calling Timeline" :
      inspectorTab === "files" ? "Files & Patch Preview" :
        inspectorTab === "book" ? "Orvix Book Dialogue" :
          "Review Decision";

  return (
    <Box flexDirection="column">
      <TopStatus state={state} width={width} />
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text color={theme.accent} bold>{fit(agent.name, Math.max(18, contentWidth - 28))}</Text>
          <Text color={theme.muted}>agent {agentIndex + 1}/{state.agents.length}</Text>
        </Box>
        <Text color={theme.muted}>{fit(agent.role, contentWidth)}</Text>
        <Box marginTop={1}>
          <Text color={statusColor(agent.status)}>{statusSymbol(agent.status)} </Text>
          <Text>{agent.status}</Text>
          <Text color={theme.muted}>  {progressBar(agent.progress, 14)} {agent.progress}%</Text>
        </Box>
        <InspectorTabs selected={inspectorTab} />
      </Box>

      <DossierPanel
        title={tabTitle}
        meta={`${files.length} files · ${bookEntries.length} book · ${signals.length} signals`}
        lines={tabLines}
        width={width}
        rows={rows}
        scrollOffset={inspectorScrollOffset}
      />

      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>› </Text>
        <Text color={theme.muted}>{fit("1-5 tabs · ←/→ tabs · ↑/↓ scroll · n/p agents · h/esc/0 home · q quit", Math.max(24, width - 6))}</Text>
      </Box>
    </Box>
  );
}

function MenuScreen({ state, width, mode }: { state: SimulationState; width: number; mode: "mock" | "cloud" }) {
  return (
    <Box flexDirection="column">
      <TopStatus state={state} width={width} />
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={1} flexDirection="column">
        <Text color={theme.accent} bold>Orvix Menu</Text>
        <Box marginTop={1} flexDirection="column">
          <Text><Text color={theme.accent}>0 </Text>Home cockpit</Text>
	          <Text><Text color={theme.accent}>Tab </Text>Move focus between panels</Text>
	          <Text><Text color={theme.accent}>↑/↓ </Text>Select agents in Agent Network</Text>
	          <Text><Text color={theme.accent}>Wheel </Text>Scroll the activity panel when it is selected</Text>
	          <Text><Text color={theme.accent}>Enter </Text>Inspect selected agent</Text>
          <Text><Text color={theme.accent}>1/2/3/4/5 </Text>Signals, PRs, decisions, Qwen reasoning, Orvix Book</Text>
          <Text><Text color={theme.accent}>x </Text>Execute next unblocked real task {mode === "cloud" ? "" : "(cloud mode)"}</Text>
          <Text><Text color={theme.accent}>r </Text>Execute selected agent {mode === "cloud" ? "" : "(cloud mode)"}</Text>
          <Text><Text color={theme.accent}>v </Text>Review and merge next PR {mode === "cloud" ? "" : "(cloud mode)"}</Text>
          <Text><Text color={theme.accent}>a </Text>Run autopilot scheduler {mode === "cloud" ? "" : "(cloud mode)"}</Text>
          <Text><Text color={theme.accent}>e </Text>Expand or restore active panel</Text>
          <Text><Text color={theme.accent}>m </Text>Open or close this menu</Text>
          <Text><Text color={theme.accent}>q </Text>Quit</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>{fit("Current workflow: Qwen designs the org, Orvix creates tasks/PRs, the orchestrator coordinates review and final approval.", Math.max(30, width - 4))}</Text>
        </Box>
      </Box>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>› </Text>
        <Text color={theme.muted}>m/0/esc close menu</Text>
      </Box>
    </Box>
  );
}

/**
 * Bottom bar with a real prompt. Closed: a single clean hint line plus the
 * live status. Open (user pressed /): an input line with cursor where slash
 * commands run and plain text is posted to the agents as mission guidance.
 */
function CommandBar({
  active,
  width,
  mode,
  missionId,
  executionStatus,
  commandDraft,
  mentionCandidates = [],
  mentionIndex = 0
}: {
  activePanel: CockpitPanel;
  expandedPanel: CockpitPanel | null;
  active: boolean;
  width: number;
  mode: "mock" | "cloud";
  missionId: string | null;
  executionStatus: string;
  commandDraft: string | null;
  mentionCandidates?: Agent[];
  mentionIndex?: number;
}) {
  const isLive = mode === "cloud" && Boolean(missionId);
  const promptOpen = commandDraft !== null;

  return (
    <Box width={width} borderStyle="round" borderColor={promptOpen ? theme.accent : active ? theme.accent : theme.border} paddingX={1} marginTop={1} flexDirection="column">
      {promptOpen && mentionCandidates.length > 0 ? (
        <Box flexDirection="column" marginBottom={0}>
          <Text color={theme.faint}>@ mention — ↑↓ select · tab/enter insert · MasterMind is always CC'd</Text>
          {mentionCandidates.map((agent, index) => (
            <Text key={agent.id}>
              <Text color={index === mentionIndex ? theme.accentBright : theme.faint}>{index === mentionIndex ? `${glyphs.chevron} ` : "  "}</Text>
              <Text color={index === mentionIndex ? theme.text : theme.muted} bold={index === mentionIndex}>@{agent.id}</Text>
              <Text color={theme.faint}>  {fit(agent.name, 24)} {fit(agent.role, Math.max(10, width - 46))}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {promptOpen ? (
        <Text>
          <Text color={theme.accentBright} bold>{glyphs.chevron} </Text>
          <Text color={theme.text}>{fit(`${commandDraft}▌`, Math.max(24, width - 6))}</Text>
        </Text>
      ) : (
        <Box justifyContent="space-between">
          <Text>
            <Text color={theme.accent}>{glyphs.chevron} </Text>
            <Text color={theme.muted}>/ commands · @ mention an agent · type to talk as owner</Text>
            <Text color={theme.faint}>  ·  tab panels · ←→ tabs · ↑↓ move · enter inspect · e expand · q quit</Text>
          </Text>
          <Text color={isLive ? theme.cloud : theme.faint}>{fit(executionStatus, Math.max(12, Math.min(52, width - 60)))}</Text>
        </Box>
      )}
    </Box>
  );
}

export function MissionCockpit({
  state,
  selectedAgentIndex,
  activePanel,
  activityTab,
  activityScrollOffset,
  expandedPanel,
  reasoningArtifacts,
  inspectedAgentIndex,
  inspectorTab,
  inspectorScrollOffset,
  showMenu,
  mode,
  missionId,
  executionStatus,
  agentTurns,
  metrics,
  commandDraft,
  mentionCandidates,
  mentionIndex
}: MissionCockpitProps) {
  const { stdout } = useStdout();
  const width = Math.max(72, stdout.columns ?? 80);
  const height = Math.max(24, stdout.rows ?? 32);
  const leftWidth = Math.floor(width * 0.5);
  const rightWidth = width - leftWidth;
  const normalActivityRows = Math.max(4, Math.min(8, height - 24));
  const expandedActivityRows = Math.max(8, height - 13);
  const selectedAgent = state.agents[Math.min(selectedAgentIndex, state.agents.length - 1)] ?? state.agents[0];
  const inspectedAgent = inspectedAgentIndex === null
    ? null
    : state.agents[Math.min(inspectedAgentIndex, state.agents.length - 1)] ?? state.agents[0];

  if (showMenu) {
    return <MenuScreen state={state} width={width} mode={mode} />;
  }

  if (inspectedAgent) {
    return (
      <AgentInspector
        state={state}
        agent={inspectedAgent}
        agentIndex={Math.min(inspectedAgentIndex ?? 0, state.agents.length - 1)}
        width={width}
        reasoningArtifacts={reasoningArtifacts}
        inspectorTab={inspectorTab}
        inspectorScrollOffset={inspectorScrollOffset}
      />
    );
  }

  if (expandedPanel === "focus") {
    return (
      <Box flexDirection="column">
        <TopStatus state={state} width={width} metrics={metrics} />
        <FocusPanel state={state} selectedAgent={selectedAgent} active width={width} agentTurns={agentTurns} />
        <CommandBar activePanel={activePanel} expandedPanel={expandedPanel} active={activePanel === "input"} width={width} mode={mode} missionId={missionId} executionStatus={executionStatus} commandDraft={commandDraft} mentionCandidates={mentionCandidates} mentionIndex={mentionIndex} />
      </Box>
    );
  }

  if (expandedPanel === "agents") {
    return (
      <Box flexDirection="column">
        <TopStatus state={state} width={width} metrics={metrics} />
        <AgentsPanel agents={state.agents} selectedAgentIndex={selectedAgentIndex} active width={width} />
        <CommandBar activePanel={activePanel} expandedPanel={expandedPanel} active={activePanel === "input"} width={width} mode={mode} missionId={missionId} executionStatus={executionStatus} commandDraft={commandDraft} mentionCandidates={mentionCandidates} mentionIndex={mentionIndex} />
      </Box>
    );
  }

  if (expandedPanel === "activity") {
    return (
      <Box flexDirection="column">
        <TopStatus state={state} width={width} metrics={metrics} />
	        <ActivityPanel
	          state={state}
	          activityTab={activityTab}
	          scrollOffset={activityScrollOffset}
	          active
	          width={width}
	          contentRows={expandedActivityRows}
	          reasoningArtifacts={reasoningArtifacts}
	          agentTurns={agentTurns}
	        />
        <CommandBar activePanel={activePanel} expandedPanel={expandedPanel} active={activePanel === "input"} width={width} mode={mode} missionId={missionId} executionStatus={executionStatus} commandDraft={commandDraft} mentionCandidates={mentionCandidates} mentionIndex={mentionIndex} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <TopStatus state={state} width={width} metrics={metrics} />
      <Box width={width}>
        <Box width={leftWidth}>
          <FocusPanel state={state} selectedAgent={selectedAgent} active={activePanel === "focus"} width={leftWidth} agentTurns={agentTurns} />
        </Box>
        <Box width={rightWidth}>
          <AgentsPanel agents={state.agents} selectedAgentIndex={selectedAgentIndex} active={activePanel === "agents"} width={rightWidth} />
        </Box>
      </Box>
      <ActivityPanel
        state={state}
        activityTab={activityTab}
        scrollOffset={activityScrollOffset}
        active={activePanel === "activity"}
        width={width}
        contentRows={normalActivityRows}
        reasoningArtifacts={reasoningArtifacts}
        agentTurns={agentTurns}
      />
      <CommandBar activePanel={activePanel} expandedPanel={expandedPanel} active={activePanel === "input"} width={width} mode={mode} missionId={missionId} executionStatus={executionStatus} commandDraft={commandDraft} mentionCandidates={mentionCandidates} mentionIndex={mentionIndex} />
    </Box>
  );
}
