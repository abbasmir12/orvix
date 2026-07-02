import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";

export function FinalReport() {
  const generated = [
    "Project blueprint",
    "Dynamic organization",
    "Task graph",
    "Branch plan",
    "PR review cycle",
    "Conflict resolution event",
    "Final release approval"
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent} bold>
        Final Delivery Report
      </Text>
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text>
          <Text color="gray">Mission Status:</Text> Completed Simulation
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Generated:</Text>
          {generated.map((item) => (
            <Text key={item}>
              <Text color="green">✓</Text> {item}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Summary:</Text>
          <Text>
            Orvix created a project-specific AI engineering organization, assigned work to
            specialized agents, simulated branch-based collaboration, reviewed PRs, requested changes,
            resolved a dependency conflict, and approved the final delivery.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text color="gray">Next Step:</Text> Connect the reasoning layer to Qwen Cloud.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
