import React from "react";
import { Box, Text } from "ink";
import { statusSymbol } from "../lib/progress.js";
import { theme } from "../lib/theme.js";
import type { PullRequest } from "../types.js";

type TaskBoardProps = {
  pullRequests: PullRequest[];
};

const colorForStatus = (status: PullRequest["status"]) => {
  if (status === "Approved") return "green";
  if (status === "Changes requested") return "yellow";
  if (status === "In progress") return "cyan";
  return "gray";
};

const fit = (value: string, width: number) => {
  if (value.length <= width) return value.padEnd(width, " ");
  return `${value.slice(0, Math.max(0, width - 1))}…`;
};

export function TaskBoard({ pullRequests }: TaskBoardProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Task / PR Board
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {pullRequests.map((pr) => (
          <Box key={pr.id}>
            <Box width={2}>
              <Text color={colorForStatus(pr.status)}>{statusSymbol(pr.status)}</Text>
            </Box>
            <Box width={9}>
              <Text>{fit(`PR #${pr.id}`, 8)}</Text>
            </Box>
            <Box width={27}>
              <Text color="gray">{fit(pr.branch, 25)}</Text>
            </Box>
            <Box width={16}>
              <Text>{fit(pr.ownerName, 14)}</Text>
            </Box>
            <Text color={colorForStatus(pr.status)}>{fit(pr.status, 17)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
