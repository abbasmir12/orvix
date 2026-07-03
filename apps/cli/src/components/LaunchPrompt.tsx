import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { BrandMark } from "./BrandMark.js";
import { theme, glyphs } from "../lib/theme.js";

type RunMode = "mock" | "cloud";

type LaunchPromptProps = {
  mode: RunMode;
  onModeChange: (mode: RunMode) => void;
  apiUrl: string;
  onSubmit: (mission: string) => void;
};

const suggestions = [
  "Build a SaaS CRM with auth, dashboard, contacts and notes",
  "Build a mobile habit app with auth, reminders and analytics",
  "Build a browser game with physics, levels and a leaderboard"
];

type ApiHealth =
  | { status: "checking" }
  | { status: "unreachable" }
  | { status: "ready"; qwenConfigured: boolean; qwenModel: string };

function useApiHealth(apiUrl: string, active: boolean) {
  const [health, setHealth] = useState<ApiHealth>({ status: "checking" });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setHealth({ status: "checking" });

    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`status ${response.status}`))))
      .then((body: { qwen?: string; qwenModel?: string }) => {
        if (cancelled) return;
        setHealth({
          status: "ready",
          qwenConfigured: body.qwen === "configured",
          qwenModel: body.qwenModel ?? "unknown"
        });
      })
      .catch(() => {
        if (!cancelled) setHealth({ status: "unreachable" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiUrl, active]);

  return health;
}

function ModePill({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <Box borderStyle={active ? "round" : "single"} borderColor={active ? color : theme.border} paddingX={1}>
      <Text color={active ? color : theme.muted} bold={active}>
        {active ? `${glyphs.ring} ` : ""}{label}
      </Text>
    </Box>
  );
}

function ModeStatusLine({ mode, health, apiUrl }: { mode: RunMode; health: ApiHealth; apiUrl: string }) {
  if (mode === "mock") {
    return (
      <Text color={theme.warning}>
        {glyphs.degraded} Scripted local demo — the same fixed simulation every time, no live Qwen calls.
      </Text>
    );
  }

  if (health.status === "checking") {
    return <Text color={theme.muted}>{glyphs.active} checking {apiUrl}...</Text>;
  }

  if (health.status === "unreachable") {
    return <Text color={theme.danger}>{glyphs.blocked} API unreachable at {apiUrl} — start it with `npm run start:api`.</Text>;
  }

  if (!health.qwenConfigured) {
    return <Text color={theme.warning}>{glyphs.degraded} API is up but DASHSCOPE_API_KEY is missing — agents cannot reach Qwen.</Text>;
  }

  return <Text color={theme.success}>{glyphs.done} live — real Orvix agents on {health.qwenModel.split(",")[0]}</Text>;
}

export function LaunchPrompt({ mode, onModeChange, apiUrl, onSubmit }: LaunchPromptProps) {
  const { exit } = useApp();
  const [mission, setMission] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const health = useApiHealth(apiUrl, mode === "cloud");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (input === "m" && mission.length === 0) {
      onModeChange(mode === "cloud" ? "mock" : "cloud");
      return;
    }

    if (key.return) {
      onSubmit(mission.trim() || suggestions[selectedSuggestion]);
      return;
    }

    if (key.tab) {
      setMission(suggestions[selectedSuggestion]);
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
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <BrandMark />
        <Text color={theme.muted}>Self-organizing AI engineering company</Text>
        <Text color={theme.faint}>Global AI Hackathon with Qwen Cloud — Track 3: Agent Society</Text>
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Box marginRight={1}>
          <ModePill label="MOCK DEMO" active={mode === "mock"} color={theme.warning} />
        </Box>
        <ModePill label="QWEN CLOUD" active={mode === "cloud"} color={theme.cloud} />
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <ModeStatusLine mode={mode} health={health} apiUrl={apiUrl} />
      </Box>

      <Box marginTop={2} flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={2} paddingY={1}>
        <Text color={theme.muted}>What should Orvix build?</Text>
        <Box marginTop={1}>
          <Text color={theme.accent} bold>{glyphs.chevron} </Text>
          {mission.length > 0 ? (
            <Text color={theme.text}>{mission}</Text>
          ) : (
            <Text color={theme.faint}>{suggestions[selectedSuggestion]}</Text>
          )}
          <Text color={theme.accentBright}>█</Text>
        </Box>
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color={theme.faint}>Enter run · Tab cycle example · ↑/↓ browse · m toggle mode · Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
