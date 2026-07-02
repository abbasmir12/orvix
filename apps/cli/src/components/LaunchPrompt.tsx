import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { BrandMark } from "./BrandMark.js";
import { theme } from "../lib/theme.js";

type LaunchPromptProps = {
  onSubmit: (mission: string) => void;
};

const defaultMission = "Build a SaaS CRM with auth, dashboard, contacts and notes";

const suggestions = [
  "Build a SaaS CRM with auth, dashboard, contacts and notes",
  "Build a mobile habit app with auth, reminders and analytics",
  "Build a browser game with physics, levels and a leaderboard"
];

export function LaunchPrompt({ onSubmit }: LaunchPromptProps) {
  const { exit } = useApp();
  const [mission, setMission] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (key.return) {
      onSubmit(mission.trim() || suggestions[selectedSuggestion] || defaultMission);
      return;
    }

    if (key.tab) {
      setMission(suggestions[selectedSuggestion] ?? defaultMission);
      setSelectedSuggestion((current) => (current + 1) % suggestions.length);
      return;
    }

    if (key.upArrow) {
      setSelectedSuggestion((current) => (current === 0 ? suggestions.length - 1 : current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedSuggestion((current) => (current + 1) % suggestions.length);
      return;
    }

    if (key.backspace || key.delete) {
      setMission((current) => current.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setMission((current) => `${current}${input}`);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box borderStyle="single" borderColor={theme.accent} paddingX={1} paddingY={1}>
          <Box width={28} flexDirection="column" alignItems="center" justifyContent="center" paddingRight={1}>
            <Text color={theme.text}>Welcome to</Text>
            <BrandMark />
            <Text color={theme.muted}>Autonomous AI org</Text>
            <Box marginTop={1} flexDirection="column" alignItems="center">
              <Text color={theme.muted}>Qwen-ready</Text>
              <Text color={theme.muted}>Mock runtime</Text>
            </Box>
          </Box>

          <Box width={41} flexDirection="column" borderStyle="single" borderColor={theme.accentDim} paddingX={1}>
            <Box flexDirection="column">
              <Text color={theme.accent}>Recent activity</Text>
              <Text>
                <Text color={theme.muted}>1m ago</Text>   Mission console refined
              </Text>
              <Text>
                <Text color={theme.muted}>8m ago</Text>   Review loop added
              </Text>
              <Text>
                <Text color={theme.muted}>2d ago</Text>   Org planner drafted
              </Text>
              <Text color={theme.muted}>... /resume for more</Text>
            </Box>

            <Box marginY={1}>
              <Text color={theme.accentDim}>──────────────────────────────────</Text>
            </Box>

            <Box flexDirection="column">
              <Text color={theme.accent}>What’s new</Text>
              <Text>/mission creates the agent org</Text>
              <Text>/review to inspect PR-style work</Text>
              <Text>/release for final approval</Text>
              <Text color={theme.muted}>... /help for more</Text>
            </Box>
          </Box>
        </Box>

        <Box marginTop={3}>
          <Text color={theme.muted}>────────────────────────────────────────────────────────────────────</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.accent}>› </Text>
          {mission.length > 0 ? (
            <Text>{mission}</Text>
          ) : (
            <Text color={theme.muted}>Try "Build a SaaS CRM with auth, dashboard, contacts and notes"</Text>
          )}
          <Text color={theme.text}>█</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.muted}>Enter run mission │ Tab fill suggestion │ Up/Down rotate │ Ctrl+C exit</Text>
        </Box>
      </Box>
    </Box>
  );
}
