import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { MissionAnalysis } from "../types.js";

type MissionBriefProps = {
  analysis: MissionAnalysis;
};

export function MissionBrief({ analysis }: MissionBriefProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Mission Brief
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="gray">Request:</Text> {analysis.request}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="gray">Type:</Text> {analysis.projectType}
          </Text>
          <Text>
            <Text color="gray">Complexity:</Text> {analysis.complexity}
          </Text>
          <Text>
            <Text color="gray">Primary Goal:</Text> {analysis.primaryGoal}
          </Text>
          <Text>
            <Text color="gray">Strategy:</Text> {analysis.strategy}
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Detected Capabilities:</Text>
          <Text>{analysis.features.join(" · ")}</Text>
        </Box>
      </Box>
    </Box>
  );
}
