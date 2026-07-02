import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { AgentCall, AgentCallStatus } from "../types.js";

type AgentCallsPanelProps = {
  calls: AgentCall[];
};

const symbolForStatus = (status: AgentCallStatus) => {
  if (status === "returned") return "✓";
  if (status === "blocked") return "!";
  if (status === "calling" || status === "running") return "•";
  return "○";
};

const colorForStatus = (status: AgentCallStatus) => {
  if (status === "returned") return "green";
  if (status === "blocked") return "yellow";
  if (status === "calling" || status === "running") return theme.accent;
  return "gray";
};

const fit = (value: string, width: number) => {
  if (value.length <= width) return value.padEnd(width, " ");
  return `${value.slice(0, Math.max(0, width - 1))}…`;
};

export function AgentCallsPanel({ calls }: AgentCallsPanelProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Agent Calls
      </Text>
      <Box marginTop={1} flexDirection="column">
        {calls.map((call) => (
          <Box key={call.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Box width={2}>
                <Text color={colorForStatus(call.status)}>{symbolForStatus(call.status)}</Text>
              </Box>
              <Text>{fit(call.from, 16)}</Text>
              <Text color="gray"> → </Text>
              <Text>{fit(call.to, 18)}</Text>
              <Text color="gray"> </Text>
              <Text color={colorForStatus(call.status)}>{call.status}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="gray">{fit(call.intent, 28)}</Text>
              <Text color="gray"> · </Text>
              <Text color={colorForStatus(call.status)}>{fit(call.signal, 26)}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
