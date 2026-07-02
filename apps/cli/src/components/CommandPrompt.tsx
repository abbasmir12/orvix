import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { SimulationState } from "../types.js";

type CommandPromptProps = {
  state: SimulationState;
};

const phaseLabel: Record<SimulationState["phase"], string> = {
  loading: "mission.intake",
  briefing: "ceo.analysis",
  organizing: "org.design",
  executing: "agent.execution",
  final: "release.approval"
};

export function CommandPrompt({ state }: CommandPromptProps) {
  const activeAgent = state.agents.find((agent) => agent.status === "active");
  const command =
    state.phase === "loading"
      ? `orvix mission "${state.analysis.request}"`
      : `run ${phaseLabel[state.phase]} --mode mock --track agent-society`;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Box>
        <Text color={theme.accent}>orvix</Text>
        <Text color="gray"> / </Text>
        <Text color="white">{phaseLabel[state.phase]}</Text>
        <Text color="gray">  </Text>
        <Text color={state.isComplete ? "green" : theme.accent}>{state.isComplete ? "✓ complete" : "• running"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">→  </Text>
        <Text>{command}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">focus: </Text>
        <Text color={activeAgent?.status === "blocked" ? "yellow" : "white"}>
          {activeAgent ? `${activeAgent.name} · ${activeAgent.currentActivity}` : "All agents idle"}
        </Text>
      </Box>
    </Box>
  );
}
