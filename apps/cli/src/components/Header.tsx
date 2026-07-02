import React from "react";
import { Box, Text } from "ink";
import { BrandMark } from "./BrandMark.js";
import type { MissionAnalysis } from "../types.js";

type HeaderProps = {
  analysis: MissionAnalysis;
};

export function Header({ analysis }: HeaderProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <BrandMark compact />
          <Text color="gray">Autonomous AI Engineering Organization</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color="gray">Mission Control Console</Text>
          <Text>
            <Text color="gray">Track:</Text> Agent Society
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Mission ID {analysis.id} │ Mode Mock Simulation │ Track Agent Society</Text>
        <Text color="gray">Runtime Ink + TypeScript │ Backend mock │ Qwen integration pending</Text>
      </Box>
    </Box>
  );
}
