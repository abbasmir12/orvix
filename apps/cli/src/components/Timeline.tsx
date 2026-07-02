import React from "react";
import { Box, Text } from "ink";
import { theme } from "../lib/theme.js";
import type { TimelineEvent } from "../types.js";

type TimelineProps = {
  events: TimelineEvent[];
};

const colorForSeverity = (severity: TimelineEvent["severity"]) => {
  if (severity === "success") return "green";
  if (severity === "warning") return "yellow";
  return "gray";
};

export function Timeline({ events }: TimelineProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginBottom={1}>
      <Text color={theme.accent} bold>
        Timeline
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {events.length === 0 ? (
          <Text color="gray">00:00  Analyzing mission...</Text>
        ) : (
          events.map((event) => (
            <Text key={event.id}>
              <Text color="gray">{event.time}</Text>{"  "}
              <Text color={colorForSeverity(event.severity)}>{event.message}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
