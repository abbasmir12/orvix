import React from "react";
import { Box, Text } from "ink";
import type { SimulationState } from "../types.js";

type StatusStripProps = {
  state: SimulationState;
};

function Metric({ label, value, color = "white" }: { label: string; value: string | number; color?: string }) {
  return (
    <Box flexDirection="column" width={20}>
      <Text color="gray">{label}</Text>
      <Text color={color} bold>
        {value}
      </Text>
    </Box>
  );
}

export function StatusStrip({ state }: StatusStripProps) {
  const completedAgents = state.agents.filter((agent) => agent.status === "completed").length;
  const activeAgents = state.agents.filter((agent) => agent.status === "active").length;
  const blockedAgents = state.agents.filter((agent) => agent.status === "blocked").length;
  const approvedPrs = state.pullRequests.filter((pr) => pr.status === "Approved").length;
  const reviewPr = state.pullRequests.find((pr) => pr.status === "Changes requested");

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
      columnGap={2}
    >
      <Metric label="Agents" value={`${completedAgents}/${state.agents.length} done`} color="green" />
      <Metric label="Active" value={activeAgents} color={activeAgents > 0 ? "cyan" : "gray"} />
      <Metric label="Blocked" value={blockedAgents} color={blockedAgents > 0 ? "yellow" : "gray"} />
      <Metric label="PRs" value={`${approvedPrs}/${state.pullRequests.length} approved`} color="green" />
      <Metric label="Review Gate" value={reviewPr ? `PR #${reviewPr.id} changes` : "clear"} color={reviewPr ? "yellow" : "green"} />
    </Box>
  );
}
