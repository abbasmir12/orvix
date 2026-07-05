import React, { useEffect, useMemo, useState } from "react";
import { Box, useApp, useInput, useStdin } from "ink";
import { MissionCockpit, type ActivityTab, type CockpitPanel, type InspectorTab } from "./components/MissionCockpit.js";
import { PlanningConsole } from "./components/PlanningConsole.js";
import {
  applySimulationStep,
  createInitialSimulation,
  createMockReasoningArtifacts,
  nudgeActiveProgress,
  simulationSteps
} from "./data/mockSimulation.js";
import type { AgentTurnEvent, PlanningStageEvent, ReasoningArtifact, RunMetricsSummary, SimulationState } from "./types.js";

type AppProps = {
  mission: string;
  mode?: "mock" | "cloud";
  apiUrl?: string;
  apiToken?: string;
  /** Resume this mission id from the API's disk snapshots instead of creating a new one. */
  resumeId?: string;
};

/** What the cloud connection should attach to: a fresh mission or a resumed one. */
type MissionTarget = { kind: "new"; mission: string } | { kind: "resume"; missionId: string };

type SseMessage = {
  event: string;
  data: unknown;
};

function actionErrorMessage(error: unknown, apiUrl: string) {
  const message = error instanceof Error ? error.message : "unknown error";
  if (/fetch failed|failed to fetch|ECONNREFUSED|socket|network/i.test(message)) {
    return `API unreachable at ${apiUrl}. Restart the Orvix API and rerun cloud mode; the local cockpit is showing the last streamed state.`;
  }

  return `Execution failed: ${message}`;
}

const activityTabs: ActivityTab[] = ["turns", "signals", "prs", "decisions", "reasoning", "book", "brief"];
const inspectorTabs: InspectorTab[] = ["overview", "trace", "files", "book", "review"];
const enableSgrMouse = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const disableSgrMouse = "\u001b[?1000l\u001b[?1002l\u001b[?1006l";

function mockAt(seconds: number) {
  return new Date(Date.UTC(2026, 6, 5, 11, 0, seconds)).toISOString();
}

const mockPlanningTimeline: PlanningStageEvent[][] = [
  [
    { stage: "research", status: "started", detail: "Scanning CRM delivery patterns and agent split risks", at: mockAt(1) }
  ],
  [
    { stage: "research", status: "completed", detail: "Research ready: CRM surfaces, auth boundary, review gates", elapsedMs: 1800, at: mockAt(3) },
    { stage: "council", status: "completed", detail: "Planning council selected vertical product slices", elapsedMs: 2400, at: mockAt(5) },
    { stage: "scaffold", status: "completed", detail: "Next.js-style CRM scaffold selected for demo evidence", elapsedMs: 1200, at: mockAt(6) }
  ],
  [
    { stage: "analysis", status: "completed", detail: "MasterMind classified SaaS CRM as medium complexity", elapsedMs: 3100, at: mockAt(8) },
    { stage: "orvix_map", status: "completed", detail: "Orvix Map locked: pages, file ownership, acceptance gates", elapsedMs: 4200, at: mockAt(10) },
    { stage: "organization", status: "completed", detail: "Strategy Weaver created parallel implementation lanes", elapsedMs: 2900, at: mockAt(12) },
    { stage: "rubric", status: "completed", detail: "Critic Council rubric rejects markdown-only PRs", elapsedMs: 1500, at: mockAt(13) }
  ]
];

const mockTurnTimeline: AgentTurnEvent[][] = [
  [
    {
      missionId: "demo-recording",
      agentId: "mastermind-agent",
      agentName: "MasterMind Agent",
      taskId: "mission-analysis",
      branch: "main",
      turn: 1,
      at: mockAt(2),
      kind: "note",
      detail: "Parsed mission, opened Orvix Book, and summoned Strategy Weaver."
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "architect-agent",
      agentName: "Blueprint Architect",
      taskId: "task-architecture-001",
      branch: "blueprint/project-architecture",
      turn: 1,
      at: mockAt(8),
      kind: "tool",
      tool: "write_file",
      path: "docs/orvix-map.json",
      ok: true,
      detail: "locked pages, components, file ownership, and acceptance gates"
    },
    {
      missionId: "demo-recording",
      agentId: "architect-agent",
      agentName: "Blueprint Architect",
      taskId: "task-architecture-001",
      branch: "blueprint/project-architecture",
      turn: 2,
      at: mockAt(9),
      kind: "tool",
      tool: "open_pr",
      path: "blueprint/project-architecture",
      ok: true,
      detail: "PR #1 Project architecture blueprint"
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "frontend-manager",
      agentName: "Interface Guild Lead",
      taskId: "task-dashboard-001",
      branch: "feat/dashboard",
      turn: 1,
      at: mockAt(13),
      kind: "tool",
      tool: "create_branch",
      path: "feat/dashboard",
      ok: true
    },
    {
      missionId: "demo-recording",
      agentId: "frontend-manager",
      agentName: "Interface Guild Lead",
      taskId: "task-dashboard-001",
      branch: "feat/dashboard",
      turn: 2,
      at: mockAt(14),
      kind: "tool",
      tool: "write_file",
      path: "app/dashboard/page.tsx",
      ok: true,
      detail: "42 additions"
    },
    {
      missionId: "demo-recording",
      agentId: "frontend-manager",
      agentName: "Interface Guild Lead",
      taskId: "task-dashboard-001",
      branch: "feat/dashboard",
      turn: 3,
      at: mockAt(15),
      kind: "tool",
      tool: "post_book_entry",
      path: "ui-contract",
      ok: true,
      detail: "shared contact row shape with Systems Guild"
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "backend-manager",
      agentName: "Systems Guild Lead",
      taskId: "task-database-001",
      branch: "feat/database-schema",
      turn: 1,
      at: mockAt(18),
      kind: "tool",
      tool: "write_file",
      path: "db/schema.sql",
      ok: true,
      detail: "users, contacts, notes tables"
    },
    {
      missionId: "demo-recording",
      agentId: "backend-manager",
      agentName: "Systems Guild Lead",
      taskId: "task-auth-001",
      branch: "feat/auth",
      turn: 2,
      at: mockAt(22),
      kind: "tool",
      tool: "open_pr",
      path: "feat/auth",
      ok: true,
      detail: "PR #2 Authentication workflow"
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "qa-reviewer-agent",
      agentName: "Critic Council",
      taskId: "review-pr-2",
      branch: "feat/auth",
      turn: 1,
      at: mockAt(25),
      kind: "harness",
      tool: "review_pr",
      path: "PR #2",
      ok: false,
      detail: "missing protected-route fallback"
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "backend-manager",
      agentName: "Systems Guild Lead",
      taskId: "task-auth-001",
      branch: "feat/auth",
      turn: 3,
      at: mockAt(28),
      kind: "tool",
      tool: "write_file",
      path: "components/protected-route.tsx",
      ok: true,
      detail: "added auth-required fallback"
    },
    {
      missionId: "demo-recording",
      agentId: "backend-manager",
      agentName: "Systems Guild Lead",
      taskId: "task-auth-001",
      branch: "feat/auth",
      turn: 4,
      at: mockAt(29),
      kind: "tool",
      tool: "commit_changes",
      path: "feat/auth",
      ok: true,
      detail: "fix auth fallback review gate"
    }
  ],
  [
    {
      missionId: "demo-recording",
      agentId: "qa-reviewer-agent",
      agentName: "Critic Council",
      taskId: "review-pr-2",
      branch: "feat/auth",
      turn: 2,
      at: mockAt(31),
      kind: "harness",
      tool: "review_pr",
      path: "PR #2",
      ok: true,
      detail: "approved after source revision"
    },
    {
      missionId: "demo-recording",
      agentId: "release-agent",
      agentName: "Release Marshal",
      taskId: "release-report",
      branch: "main",
      turn: 1,
      at: mockAt(34),
      kind: "tool",
      tool: "write_file",
      path: "docs/final-report.md",
      ok: true,
      detail: "release verdict and submission evidence"
    }
  ]
];

const mockMetrics: RunMetricsSummary = {
  missionId: "demo-recording",
  mode: "mock",
  isComplete: true,
  wallClockMs: 94000,
  qwenCalls: 37,
  promptTokens: 184000,
  completionTokens: 31000,
  totalTokens: 215000,
  totalQwenDurationMs: 72000,
  callsByRole: { planner: 5, agent: 24, reviewer: 6, release: 2 },
  tokensByRole: { planner: 52000, agent: 121000, reviewer: 31000, release: 11000 },
  agents: 7,
  tasks: 5,
  tasksCompleted: 5,
  pullRequests: 5,
  pullRequestsApproved: 5,
  filesWritten: 9,
  reviewComments: 4
};

function terminalMouseWheelDelta(input: string) {
  let delta = 0;
  const sgrPattern = /\u001b\[<(\d+);(\d+);(\d+)([mM])/g;
  for (const match of input.matchAll(sgrPattern)) {
    const button = Number(match[1]);
    if (button === 64) delta += 3;
    if (button === 65) delta -= 3;
  }

  return delta;
}

function parseSseMessages(buffer: string): { messages: SseMessage[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const messages = parts.flatMap((part) => {
    const event = part.match(/^event: (.+)$/m)?.[1] ?? "message";
    const data = part.match(/^data: (.+)$/m)?.[1];
    if (!data) return [];

    return [{ event, data: JSON.parse(data) as unknown }];
  });

  return { messages, rest };
}

export function App({ mission, mode = "mock", apiUrl = "http://localhost:8787", apiToken, resumeId }: AppProps) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const [missionTarget, setMissionTarget] = useState<MissionTarget>(
    resumeId ? { kind: "resume", missionId: resumeId } : { kind: "new", mission }
  );
  const [commandDraft, setCommandDraft] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const initialState = useMemo(() => createInitialSimulation(mission), [mission]);
  const [state, setState] = useState(initialState);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [activePanel, setActivePanel] = useState<CockpitPanel>("focus");
  const [activityTab, setActivityTab] = useState<ActivityTab>("turns");
  const [activityScroll, setActivityScroll] = useState<Record<ActivityTab, number>>({
    turns: 0,
    signals: 0,
    prs: 0,
    decisions: 0,
    reasoning: 0,
    book: 0,
    brief: 0
  });
  const [expandedPanel, setExpandedPanel] = useState<CockpitPanel | null>(null);
  const [reasoningArtifacts, setReasoningArtifacts] = useState<ReasoningArtifact[]>(
    mode === "mock" ? createMockReasoningArtifacts(mission) : []
  );
  const [inspectedAgentIndex, setInspectedAgentIndex] = useState<number | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [inspectorScroll, setInspectorScroll] = useState<Record<InspectorTab, number>>({
    overview: 0,
    trace: 0,
    files: 0,
    book: 0,
    review: 0
  });
  const [showMenu, setShowMenu] = useState(false);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState<string>("Workspace execution idle");
  const [planningStages, setPlanningStages] = useState<PlanningStageEvent[]>(
    mode === "mock" ? mockPlanningTimeline[0] ?? [] : []
  );
  const [agentTurns, setAgentTurns] = useState<AgentTurnEvent[]>(
    mode === "mock" ? mockTurnTimeline[0] ?? [] : []
  );
  const [metrics, setMetrics] = useState<RunMetricsSummary | null>(mode === "mock" ? mockMetrics : null);
  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
    return headers;
  }, [apiToken]);
  const jsonHeaders = useMemo<Record<string, string>>(() => ({ "Content-Type": "application/json", ...authHeaders }), [authHeaders]);
  // Agents matching the trailing @token of the prompt draft (mention picker).
  const mentionQuery = commandDraft !== null ? commandDraft.match(/@([a-z0-9-]*)$/i)?.[1]?.toLowerCase() ?? null : null;
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return state.agents
      .filter((agent) => agent.id.toLowerCase().includes(mentionQuery) || agent.name.toLowerCase().includes(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, state.agents]);

  async function runAgentExecution(kind: "next" | "selected" | "review" | "autopilot") {
    if (mode !== "cloud" || !missionId) {
      setExecutionStatus("Start cloud mode before running real agent execution");
      return;
    }

    const selectedAgent = state.agents[Math.min(selectedAgentIndex, state.agents.length - 1)];
    const path = kind === "next"
      ? `/missions/${missionId}/execute-next`
      : kind === "review"
        ? `/missions/${missionId}/review-next`
        : kind === "autopilot"
          ? `/missions/${missionId}/autopilot`
          : `/missions/${missionId}/agents/${selectedAgent?.id}/execute`;

    try {
      setExecutionStatus(
        kind === "next"
          ? "Executing next unblocked task..."
          : kind === "review"
            ? "Reviewing next PR..."
            : kind === "autopilot"
              ? "Autopilot running scheduler turns..."
              : `Executing ${selectedAgent?.name ?? "selected agent"}...`
      );
      const response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: jsonHeaders,
        body: kind === "autopilot" ? JSON.stringify({ cycles: 300 }) : undefined
      });
	      const result = await response.json() as {
	        ok?: boolean;
	        cycles?: number;
	        agent?: { name?: string };
	        task?: { title?: string };
	        pr?: { id?: number };
	        decision?: { decision?: string };
	        error?: string;
	        message?: string;
	      };
	      if (!response.ok || !result.ok) {
	        setExecutionStatus(`Execution failed: ${result.message ?? result.error ?? response.status}`);
	        return;
	      }

      setExecutionStatus(
        kind === "review"
          ? `Reviewed PR #${result.pr?.id ?? "?"}: ${result.decision?.decision ?? "done"}`
          : kind === "autopilot"
            ? result.message ?? `Autopilot completed ${result.cycles ?? 0} parallel scheduler waves`
            : `Executed ${result.agent?.name ?? "agent"}: ${result.task?.title ?? "task"}`
      );
    } catch (error) {
      setExecutionStatus(actionErrorMessage(error, apiUrl));
    }
  }

  function selectActivityTab(tab: ActivityTab) {
    setActivityTab(tab);
    setActivePanel("activity");
  }

  function cycleActivityTab(step: number) {
    const currentIndex = activityTabs.indexOf(activityTab);
    selectActivityTab(activityTabs[(currentIndex + step + activityTabs.length) % activityTabs.length]);
  }

  /** Executes a submitted prompt-bar line: /commands or plain-text guidance to the agents. */
  async function runCommand(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith("/")) {
      // Plain text is the OWNER speaking: it lands in the Orvix Book under
      // the `owner` identity, MasterMind always CC'd. @agent-id mentions
      // target specific agents — a mentioned agent with a live workstream
      // gets its PR reopened so the revision loop applies the request.
      if (mode !== "cloud" || !missionId) {
        setExecutionStatus("Owner messages need a live cloud mission");
        return;
      }
      const mentionIds = Array.from(trimmed.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)).map((match) => match[1].toLowerCase());
      try {
        const response = await fetch(`${apiUrl}/missions/${missionId}/owner`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ message: trimmed, toAgentIds: mentionIds })
        });
        const result = await response.json() as { ok?: boolean; mentioned?: string[]; reopenedPrs?: number[] };
        if (!response.ok || !result.ok) {
          setExecutionStatus(`Owner message failed: ${response.status}`);
          return;
        }
        const target = result.mentioned?.length ? result.mentioned.join(", ") : "MasterMind";
        const reopened = result.reopenedPrs?.length ? ` · reopened PR ${result.reopenedPrs.map((id) => `#${id}`).join(", ")}` : "";
        setExecutionStatus(`Owner → ${target} (Book)${reopened}`);
      } catch (error) {
        setExecutionStatus(actionErrorMessage(error, apiUrl));
      }
      return;
    }

    const [command, ...args] = trimmed.slice(1).split(/\s+/);
    switch (command.toLowerCase()) {
      case "help":
        setExecutionStatus("/autopilot /next /review /missions /resume <id> /tab <name> /quit — plain text posts guidance to agents");
        return;
      case "quit":
      case "exit":
        exit();
        return;
      case "autopilot":
        void runAgentExecution("autopilot");
        return;
      case "next":
        void runAgentExecution("next");
        return;
      case "review":
        void runAgentExecution("review");
        return;
      case "tab": {
        const tab = activityTabs.find((candidate) => candidate.startsWith((args[0] ?? "").toLowerCase()));
        if (tab) selectActivityTab(tab);
        setExecutionStatus(tab ? `Switched to ${tab}` : `Unknown tab; tabs: ${activityTabs.join(", ")}`);
        return;
      }
      case "missions": {
        try {
          const response = await fetch(`${apiUrl}/missions/disk`, { headers: authHeaders });
          const payload = await response.json() as { runs?: Array<{ missionId: string; isComplete: boolean; mode: string }> };
          const listing = (payload.runs ?? []).slice(0, 5)
            .map((entry) => `${entry.missionId}${entry.isComplete ? " (done)" : ""}`)
            .join(" · ");
          setExecutionStatus(listing ? `On disk: ${listing} — /resume <id>` : "No missions on disk");
        } catch (error) {
          setExecutionStatus(actionErrorMessage(error, apiUrl));
        }
        return;
      }
      case "resume": {
        const target = args[0];
        if (!target) {
          setExecutionStatus("Usage: /resume <missionId> (see /missions)");
          return;
        }
        if (mode !== "cloud") {
          setExecutionStatus("Resume needs cloud mode (orvix mission --mode cloud)");
          return;
        }
        setAgentTurns([]);
        setPlanningStages([]);
        setReasoningArtifacts([]);
        setMissionTarget({ kind: "resume", missionId: target });
        setExecutionStatus(`Resuming ${target}...`);
        return;
      }
      default:
        setExecutionStatus(`Unknown command /${command} — try /help`);
    }
  }

	  function scrollActivity(delta: number) {
	    setActivityScroll((current) => ({
	      ...current,
	      [activityTab]: Math.max(0, (current[activityTab] ?? 0) + delta)
	    }));
	  }

  function scrollInspector(delta: number) {
    setInspectorScroll((current) => ({
      ...current,
      [inspectorTab]: Math.max(0, (current[inspectorTab] ?? 0) + delta)
    }));
  }

  useEffect(() => {
    const activityHasFocus = activePanel === "activity" || expandedPanel === "activity";
    if (!activityHasFocus || !stdin) {
      return;
    }

    process.stdout.write(enableSgrMouse);
    const onData = (chunk: Buffer | string) => {
      const delta = terminalMouseWheelDelta(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      if (delta !== 0) {
        scrollActivity(delta);
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.stdout.write(disableSgrMouse);
    };
  }, [activePanel, activityTab, expandedPanel, stdin]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // Prompt bar captures every keystroke while open.
    if (commandDraft !== null) {
      if (key.escape) {
        setCommandDraft(null);
        return;
      }
      // @mention picker: while the trailing token is @something, arrows move
      // the selection and Tab/Enter insert the highlighted agent id.
      if (mentionCandidates.length > 0) {
        if (key.upArrow) {
          setMentionIndex((current) => (current + mentionCandidates.length - 1) % mentionCandidates.length);
          return;
        }
        if (key.downArrow) {
          setMentionIndex((current) => (current + 1) % mentionCandidates.length);
          return;
        }
        if (key.tab || key.return) {
          const chosen = mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)];
          setCommandDraft((current) => (current ?? "").replace(/@[a-z0-9-]*$/i, `@${chosen.id} `));
          setMentionIndex(0);
          return;
        }
      }
      if (key.return) {
        const line = commandDraft;
        setCommandDraft(null);
        void runCommand(line);
        return;
      }
      if (key.backspace || key.delete) {
        setCommandDraft((current) => (current && current.length > 0 ? current.slice(0, -1) : ""));
        setMentionIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setCommandDraft((current) => `${current ?? ""}${input}`);
        if (input === "@") setMentionIndex(0);
      }
      return;
    }

    if (input === "/") {
      setCommandDraft("/");
      return;
    }

    if (input === "@") {
      setCommandDraft("@");
      setMentionIndex(0);
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (showMenu) {
      if (input === "m" || input === "0" || key.escape) {
        setShowMenu(false);
      }
      return;
    }

    if (inspectedAgentIndex !== null) {
      const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
      const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);

      if (input >= "1" && input <= "5") {
        setInspectorTab(inspectorTabs[Number(input) - 1]);
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        const currentIndex = inspectorTabs.indexOf(inspectorTab);
        setInspectorTab(inspectorTabs[(currentIndex + (key.rightArrow ? 1 : inspectorTabs.length - 1)) % inspectorTabs.length]);
        return;
      }

      if (key.upArrow) {
        scrollInspector(1);
        return;
      }

      if (key.downArrow) {
        scrollInspector(-1);
        return;
      }

      if (pageUp) {
        scrollInspector(6);
        return;
      }

      if (pageDown) {
        scrollInspector(-6);
        return;
      }

      if (input === "p") {
        setInspectedAgentIndex((current) => Math.max(0, (current ?? 0) - 1));
        return;
      }

      if (input === "n") {
        setInspectedAgentIndex((current) => Math.min(state.agents.length - 1, (current ?? 0) + 1));
        return;
      }

      if (input === "0" || input === "h" || key.escape) {
        setInspectedAgentIndex(null);
        setActivePanel("agents");
        return;
      }

      if (input === "m") {
        setShowMenu(true);
        return;
      }
    }

    if (input === "m") {
      setShowMenu(true);
      return;
    }

    if (input === "0") {
      setInspectedAgentIndex(null);
      setShowMenu(false);
      setExpandedPanel(null);
      setSelectedAgentIndex(0);
      setActivePanel("focus");
      setActivityTab("signals");
      return;
    }

    if (key.tab) {
      const panels: CockpitPanel[] = ["focus", "agents", "activity", "input"];
      const currentIndex = panels.indexOf(activePanel);
      setActivePanel(panels[(currentIndex + 1) % panels.length]);
      return;
    }

    const activityHasFocus = activePanel === "activity" || expandedPanel === "activity";
    const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
    const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);

    if (activityHasFocus && (key.upArrow || key.downArrow || pageUp || pageDown)) {
      if (key.upArrow) scrollActivity(1);
      if (key.downArrow) scrollActivity(-1);
      if (pageUp) scrollActivity(6);
      if (pageDown) scrollActivity(-6);
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      cycleActivityTab(key.rightArrow ? 1 : -1);
      return;
    }

    if (key.upArrow && activePanel === "agents") {
      setSelectedAgentIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow && activePanel === "agents") {
      setSelectedAgentIndex((current) => Math.min(state.agents.length - 1, current + 1));
      return;
    }

    if (key.return && activePanel === "agents") {
      setInspectedAgentIndex(selectedAgentIndex);
      setInspectorTab("overview");
      return;
    }

    if (input === "1") {
      selectActivityTab(activityTabs[0]);
      return;
    }

    if (input === "2") {
      selectActivityTab(activityTabs[1]);
      return;
    }

    if (input === "3") {
      selectActivityTab(activityTabs[2]);
      return;
    }

    if (input === "4") {
      selectActivityTab(activityTabs[3]);
      return;
    }

    if (input === "5") {
      selectActivityTab(activityTabs[4]);
      return;
    }

    if (input === "6") {
      selectActivityTab(activityTabs[5]);
      return;
    }

    if (input === "7") {
      selectActivityTab(activityTabs[6]);
      return;
    }

    if (input === "x") {
      void runAgentExecution("next");
      return;
    }

    if (input === "r") {
      void runAgentExecution("selected");
      return;
    }

    if (input === "v") {
      void runAgentExecution("review");
      return;
    }

    if (input === "a") {
      void runAgentExecution("autopilot");
      return;
    }

    if (input === "e") {
      setExpandedPanel((current) => (current ? null : activePanel));
    }
  });

  useEffect(() => {
    if (mode !== "mock") {
      return;
    }

    const progressTimer = setInterval(() => {
      setState((current) => (current.isComplete ? current : nudgeActiveProgress(current)));
    }, 450);

    return () => clearInterval(progressTimer);
  }, [mode]);

  useEffect(() => {
    if (mode !== "mock") {
      return;
    }

    if (stepIndex >= simulationSteps.length) {
      return;
    }

    const stepTimer = setTimeout(
      () => {
        setState((current) => applySimulationStep(current, simulationSteps[stepIndex], stepIndex));
        setPlanningStages((current) => [...current, ...(mockPlanningTimeline[stepIndex + 1] ?? [])]);
        setAgentTurns((current) => [...current, ...(mockTurnTimeline[stepIndex + 1] ?? [])].slice(-300));
        setStepIndex((current) => current + 1);
      },
      stepIndex === 0 ? 1400 : stepIndex < 3 ? 2200 : 1800
    );

    return () => clearTimeout(stepTimer);
  }, [mode, stepIndex]);

  useEffect(() => {
    if (mode !== "cloud") {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function connect() {
      try {
        const createResponse = missionTarget.kind === "resume"
          ? await fetch(`${apiUrl}/missions/${missionTarget.missionId}/resume`, {
            method: "POST",
            headers: authHeaders,
            signal: controller.signal
          })
          : await fetch(`${apiUrl}/missions`, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ mission: missionTarget.mission, mode: "qwen" }),
            signal: controller.signal
          });

        if (!createResponse.ok) {
          throw new Error(missionTarget.kind === "resume"
            ? `Resume failed for ${missionTarget.missionId} (${createResponse.status})`
            : `API returned ${createResponse.status}`);
        }

        const created = await createResponse.json() as { missionId: string; eventsUrl: string };
        setMissionId(created.missionId);
        const stateResponse = await fetch(`${apiUrl}/missions/${created.missionId}`, { headers: authHeaders, signal: controller.signal });
        if (stateResponse.ok) {
          const snapshot = await stateResponse.json() as { state?: SimulationState; planningStages?: PlanningStageEvent[] };
          if (snapshot.state) setState(snapshot.state);
          if (snapshot.planningStages?.length) setPlanningStages(snapshot.planningStages);
        }
        if (missionTarget.kind === "resume") {
          // Restore the live-turns feed from the persisted turn log so the
          // cockpit comes back exactly as it was, not just the state header.
          const turnsResponse = await fetch(`${apiUrl}/missions/${created.missionId}/turns`, { headers: authHeaders, signal: controller.signal });
          if (turnsResponse.ok) {
            const persisted = await turnsResponse.json() as { turns?: AgentTurnEvent[] };
            if (persisted.turns?.length) setAgentTurns(persisted.turns.slice(-300));
          }
        }
        const reasoningResponse = await fetch(`${apiUrl}/missions/${created.missionId}/reasoning`, {
          headers: authHeaders,
          signal: controller.signal
        });
        if (reasoningResponse.ok) {
          const reasoning = await reasoningResponse.json() as { artifacts?: ReasoningArtifact[] };
          setReasoningArtifacts(reasoning.artifacts ?? []);
        }

        // Streaming with an idle watchdog and automatic reconnection: on a
        // slow or flaky connection the SSE stream can silently stall — the
        // old behavior froze the screen and even marked the mission failed.
        // Now a stalled/closed stream refetches the state snapshot and
        // re-subscribes until the effect is cancelled.
        while (!cancelled) {
          try {
            const streamController = new AbortController();
            const onOuterAbort = () => streamController.abort();
            controller.signal.addEventListener("abort", onOuterAbort, { once: true });
            const eventsResponse = await fetch(`${apiUrl}${created.eventsUrl}`, {
              headers: authHeaders,
              signal: streamController.signal
            });
            if (!eventsResponse.ok || !eventsResponse.body) {
              throw new Error(`Event stream returned ${eventsResponse.status}`);
            }

            const reader = eventsResponse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (!cancelled) {
              const idleTimer = setTimeout(() => streamController.abort(), 60000);
              const chunk = await reader.read().finally(() => clearTimeout(idleTimer));
              if (chunk.done) break;

              buffer += decoder.decode(chunk.value, { stream: true });
              const parsed = parseSseMessages(buffer);
              buffer = parsed.rest;

              for (const message of parsed.messages) {
                if (message.event === "state") {
                  setState(message.data as SimulationState);
                }

                if (message.event === "reasoning") {
                  setReasoningArtifacts((current) => {
                    const nextArtifact = message.data as ReasoningArtifact;
                    const existing = current.find((artifact) => artifact.id === nextArtifact.id);
                    if (existing) {
                      return current.map((artifact) => artifact.id === nextArtifact.id ? nextArtifact : artifact);
                    }

                    return [...current, nextArtifact];
                  });
                }

                if (message.event === "planning") {
                  const stageEvent = message.data as PlanningStageEvent;
                  setPlanningStages((current) => [...current, stageEvent]);
                }

                if (message.event === "planning_snapshot") {
                  setPlanningStages(message.data as PlanningStageEvent[]);
                }

                if (message.event === "agent_turn") {
                  const turnEvent = message.data as AgentTurnEvent;
                  setAgentTurns((current) => [...current, turnEvent].slice(-300));
                }
              }
            }
            controller.signal.removeEventListener("abort", onOuterAbort);
          } catch {
            // fall through to the reconnect below
          }
          if (cancelled || controller.signal.aborted) return;
          setExecutionStatus("Stream interrupted — reconnecting…");
          await new Promise((resolvePause) => setTimeout(resolvePause, 3000));
          try {
            const refreshed = await fetch(`${apiUrl}/missions/${created.missionId}`, { headers: authHeaders });
            if (refreshed.ok) {
              const snapshot = await refreshed.json() as { state?: SimulationState };
              if (snapshot.state) setState(snapshot.state);
              setExecutionStatus("Reconnected — state refreshed");
            }
          } catch {
            // API itself unreachable; keep retrying the stream loop.
          }
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setExecutionStatus(actionErrorMessage(error, apiUrl));
      }
    }

    void connect();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiUrl, authHeaders, jsonHeaders, missionTarget, mode]);

  useEffect(() => {
    if (mode !== "cloud" || !missionId) return;

    let cancelled = false;
    const controller = new AbortController();

    async function pollMetrics() {
      try {
        const response = await fetch(`${apiUrl}/missions/${missionId}/metrics`, { headers: authHeaders, signal: controller.signal });
        if (!response.ok || cancelled) return;
        setMetrics(await response.json() as RunMetricsSummary);
      } catch {
        // metrics are best-effort telemetry; a missed poll is not worth surfacing
      }
    }

    void pollMetrics();
    const interval = setInterval(() => void pollMetrics(), 3000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [apiUrl, authHeaders, mode, missionId]);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {state.phase === "loading" || state.phase === "briefing" || state.phase === "organizing" ? (
          <PlanningConsole
            state={state}
            mission={mission}
            mode={mode}
            apiUrl={apiUrl}
            reasoningArtifacts={reasoningArtifacts}
            planningStages={planningStages}
          />
        ) : (
          <MissionCockpit
            state={state}
            selectedAgentIndex={selectedAgentIndex}
            activePanel={activePanel}
            activityTab={activityTab}
            activityScrollOffset={activityScroll[activityTab] ?? 0}
            expandedPanel={expandedPanel}
            reasoningArtifacts={reasoningArtifacts}
            inspectedAgentIndex={inspectedAgentIndex}
            inspectorTab={inspectorTab}
            inspectorScrollOffset={inspectorScroll[inspectorTab] ?? 0}
            showMenu={showMenu}
            mode={mode}
            missionId={missionId}
            executionStatus={executionStatus}
            agentTurns={agentTurns}
            metrics={metrics}
            commandDraft={commandDraft}
            mentionCandidates={mentionCandidates}
            mentionIndex={mentionIndex}
          />
        )}
      </Box>
    </Box>
  );
}
