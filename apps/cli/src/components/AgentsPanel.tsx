import React from "react";
import { Box, Text } from "ink";
import { progressBar, statusSymbol } from "../lib/progress.js";
import { theme } from "../lib/theme.js";
import type { Agent } from "../types.js";

type AgentsPanelProps = {
  agents: Agent[];
};

const colorForStatus = (status: Agent["status"]) => {
  if (status === "completed") return "green";
  if (status === "active") return "cyan";
  if (status === "blocked") return "yellow";
  return "gray";
};

export function AgentsPanel({ agents }: AgentsPanelProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Active Agents
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {agents.map((agent) => (
          <Box key={agent.id}>
            <Box width={2}>
              <Text color={colorForStatus(agent.status)}>{statusSymbol(agent.status)}</Text>
            </Box>
            <Box width={23}>
              <Text>{agent.name}</Text>
            </Box>
            <Box width={28}>
              <Text color="gray">{agent.currentActivity}</Text>
            </Box>
            <Box width={13}>
              <Text color={colorForStatus(agent.status)}>{progressBar(agent.progress, 8)}</Text>
            </Box>
            <Text>{agent.progress.toString().padStart(3, " ")}%</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
