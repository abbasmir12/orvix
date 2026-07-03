import React, { useEffect, useMemo, useState } from "react";
import { Box, useApp, useInput, useStdin } from "ink";
import { MissionCockpit, type ActivityTab, type CockpitPanel, type InspectorTab } from "./components/MissionCockpit.js";
import { PlanningConsole } from "./components/PlanningConsole.js";
import {
  applySimulationStep,
  createInitialSimulation,
  nudgeActiveProgress,
  simulationSteps
} from "./data/mockSimulation.js";
import type { AgentTurnEvent, PlanningStageEvent, ReasoningArtifact, RunMetricsSummary, SimulationState } from "./types.js";

type AppProps = {
  mission: string;
  mode?: "mock" | "cloud";
  apiUrl?: string;
};

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

const activityTabs: ActivityTab[] = ["turns", "signals", "prs", "decisions", "reasoning", "book"];
const inspectorTabs: InspectorTab[] = ["overview", "trace", "files", "book", "review"];
const enableSgrMouse = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const disableSgrMouse = "\u001b[?1000l\u001b[?1002l\u001b[?1006l";

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

export function App({ mission, mode = "mock", apiUrl = "http://localhost:8787" }: AppProps) {
  const { exit } = useApp();
  const { stdin } = useStdin();
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
    book: 0
  });
  const [expandedPanel, setExpandedPanel] = useState<CockpitPanel | null>(null);
  const [reasoningArtifacts, setReasoningArtifacts] = useState<ReasoningArtifact[]>([]);
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
  const [planningStages, setPlanningStages] = useState<PlanningStageEvent[]>([]);
  const [agentTurns, setAgentTurns] = useState<AgentTurnEvent[]>([]);
  const [metrics, setMetrics] = useState<RunMetricsSummary | null>(null);

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
        headers: { "Content-Type": "application/json" },
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
    if ((key.ctrl && input === "c") || input === "q") {
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
        setStepIndex((current) => current + 1);
      },
      stepIndex === 0 ? 900 : 1600
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
        const createResponse = await fetch(`${apiUrl}/missions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mission, mode: "qwen" }),
          signal: controller.signal
        });

        if (!createResponse.ok) {
          throw new Error(`API returned ${createResponse.status}`);
        }

        const created = await createResponse.json() as { missionId: string; eventsUrl: string };
        setMissionId(created.missionId);
        const reasoningResponse = await fetch(`${apiUrl}/missions/${created.missionId}/reasoning`, {
          signal: controller.signal
        });
        if (reasoningResponse.ok) {
          const reasoning = await reasoningResponse.json() as { artifacts?: ReasoningArtifact[] };
          setReasoningArtifacts(reasoning.artifacts ?? []);
        }

        const eventsResponse = await fetch(`${apiUrl}${created.eventsUrl}`, {
          signal: controller.signal
        });

        if (!eventsResponse.ok || !eventsResponse.body) {
          throw new Error(`Event stream returned ${eventsResponse.status}`);
        }

        const reader = eventsResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const chunk = await reader.read();
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
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
          setExecutionStatus(actionErrorMessage(error, apiUrl));
          setState((current) => ({
            ...current,
            phase: "final",
            isComplete: true,
          events: [
            ...current.events,
            {
              id: "cloud-error",
              time: "00:00",
              message: actionErrorMessage(error, apiUrl),
              severity: "warning"
            }
          ]
        }));
      }
    }

    void connect();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiUrl, mission, mode]);

  useEffect(() => {
    if (mode !== "cloud" || !missionId) return;

    let cancelled = false;
    const controller = new AbortController();

    async function pollMetrics() {
      try {
        const response = await fetch(`${apiUrl}/missions/${missionId}/metrics`, { signal: controller.signal });
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
  }, [apiUrl, mode, missionId]);

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
          />
        )}
      </Box>
    </Box>
  );
}
