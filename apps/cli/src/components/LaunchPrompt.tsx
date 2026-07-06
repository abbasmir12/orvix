import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { BrandMark } from "./BrandMark.js";
import { theme, glyphs } from "../lib/theme.js";

type RunMode = "mock" | "cloud";

type LaunchPromptProps = {
  mode: RunMode;
  onModeChange: (mode: RunMode) => void;
  apiUrl: string;
  apiToken?: string;
  onSubmit: (mission: string) => void;
  onResume?: (missionId: string) => void;
};

const suggestions = [
  "Build a SaaS CRM with auth, dashboard, contacts and notes",
  "Build a mobile habit app with auth, reminders and analytics",
  "Build a browser game with physics, levels and a leaderboard"
];

const launchCommands = [
  { name: "resume", hint: "Pick a past mission and continue it exactly where it stopped" },
  { name: "mode", hint: "Toggle between scripted demo and live cloud runtime" },
  { name: "quit", hint: "Exit Orvix" }
];

type DiskRun = {
  missionId: string;
  mission: string;
  mode: string;
  createdAt: string;
  isComplete: boolean;
  inMemory: boolean;
};

function relativeAge(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type ApiHealth =
  | { status: "checking" }
  | { status: "unreachable" }
  | { status: "ready"; qwenConfigured: boolean; qwenModel: string };

function useApiHealth(apiUrl: string, apiToken: string | undefined, active: boolean) {
  const [health, setHealth] = useState<ApiHealth>({ status: "checking" });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setHealth({ status: "checking" });

    const controller = new AbortController();
    fetch(`${apiUrl}/health`, {
      signal: controller.signal,
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined
    })
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
  }, [apiUrl, apiToken, active]);

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

function runtimeLabel(mode: RunMode, apiUrl: string) {
  if (mode === "mock") {
    return { label: "SCRIPTED DEMO", color: theme.warning };
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(apiUrl);
  return isLocal
    ? { label: "LOCAL RUNTIME", color: theme.local }
    : { label: "ALIBABA CLOUD", color: theme.cloud };
}

function runtimeName(apiUrl: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(apiUrl)
    ? "local machine"
    : "Alibaba Cloud";
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

  return (
    <Text color={theme.success}>
      {glyphs.done} live — Orvix runtime on {runtimeName(apiUrl)}
    </Text>
  );
}

export function LaunchPrompt({ mode, onModeChange, apiUrl, apiToken, onSubmit, onResume }: LaunchPromptProps) {
  const { exit } = useApp();
  const [mission, setMission] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [resumeRuns, setResumeRuns] = useState<DiskRun[] | null>(null);
  const [resumeIndex, setResumeIndex] = useState(0);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const health = useApiHealth(apiUrl, apiToken, mode === "cloud");
  const runtime = runtimeLabel(mode, apiUrl);

  const paletteOpen = mission.startsWith("/");
  const paletteQuery = paletteOpen ? mission.slice(1).toLowerCase() : "";
  const paletteCommands = launchCommands.filter((command) => command.name.startsWith(paletteQuery));

  async function openResumePicker() {
    setResumeNote(null);
    try {
      const response = await fetch(`${apiUrl}/missions/disk`, {
        headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : undefined
      });
      const payload = await response.json() as { runs?: DiskRun[] };
      if (!response.ok || !payload.runs) throw new Error(`status ${response.status}`);
      setResumeRuns(payload.runs);
      setResumeIndex(0);
    } catch {
      setResumeNote(`Could not list missions from ${apiUrl} — is the Orvix API running?`);
    }
  }

  function runPaletteCommand(name: string) {
    setMission("");
    setCommandIndex(0);
    if (name === "quit") {
      exit();
      return;
    }
    if (name === "mode") {
      onModeChange(mode === "cloud" ? "mock" : "cloud");
      return;
    }
    if (name === "resume") {
      void openResumePicker();
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // Resume picker captures navigation while open.
    if (resumeRuns !== null) {
      if (key.escape) {
        setResumeRuns(null);
        return;
      }
      if (key.upArrow) {
        setResumeIndex((current) => (current + resumeRuns.length - 1) % Math.max(1, resumeRuns.length));
        return;
      }
      if (key.downArrow) {
        setResumeIndex((current) => (current + 1) % Math.max(1, resumeRuns.length));
        return;
      }
      if (key.return && resumeRuns.length > 0) {
        const chosen = resumeRuns[Math.min(resumeIndex, resumeRuns.length - 1)];
        onResume?.(chosen.missionId);
        return;
      }
      return;
    }

    if (paletteOpen) {
      if (key.escape) {
        setMission("");
        return;
      }
      if (key.upArrow) {
        setCommandIndex((current) => (current + paletteCommands.length - 1) % Math.max(1, paletteCommands.length));
        return;
      }
      if (key.downArrow) {
        setCommandIndex((current) => (current + 1) % Math.max(1, paletteCommands.length));
        return;
      }
      if ((key.return || key.tab) && paletteCommands.length > 0) {
        runPaletteCommand(paletteCommands[Math.min(commandIndex, paletteCommands.length - 1)].name);
        return;
      }
      if (key.backspace || key.delete) {
        setMission((current) => current.slice(0, -1));
        setCommandIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setMission((current) => `${current}${input}`);
        setCommandIndex(0);
      }
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

  if (resumeRuns !== null) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          <BrandMark />
          <Text color={theme.muted}>Resume a mission — everything comes back: agents, PRs, turns, Book</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={2} paddingY={1}>
          {resumeRuns.length === 0 ? (
            <Text color={theme.faint}>No missions on disk yet — run one first.</Text>
          ) : resumeRuns.slice(0, 10).map((run, index) => (
            <Box key={run.missionId} flexDirection="column" marginBottom={index === Math.min(resumeIndex, resumeRuns.length - 1) ? 0 : 0}>
              <Text>
                <Text color={index === resumeIndex ? theme.accentBright : theme.faint}>{index === resumeIndex ? `${glyphs.chevron} ` : "  "}</Text>
                <Text color={run.isComplete ? theme.success : theme.warning}>{run.isComplete ? glyphs.done : glyphs.active} </Text>
                <Text color={index === resumeIndex ? theme.text : theme.muted} bold={index === resumeIndex}>{run.missionId}</Text>
                <Text color={run.mode === "qwen" ? theme.cloud : theme.faint}>  {run.mode.toUpperCase()}</Text>
                <Text color={theme.faint}>  {relativeAge(run.createdAt)}{run.isComplete ? "  · complete" : "  · resumable"}</Text>
              </Text>
              <Text color={index === resumeIndex ? theme.muted : theme.faint}>      {run.mission.slice(0, 96)}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1} justifyContent="center">
          <Text color={theme.faint}>↑/↓ select · Enter resume · Esc back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <BrandMark />
        <Text color={theme.muted}>From product request to reviewed code, shipped by agents</Text>
        <Text color={theme.faint}>Parallel AI Agency for autonomous software delivery</Text>
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <ModePill label={runtime.label} active color={runtime.color} />
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
        {paletteOpen ? (
          <Box flexDirection="column" marginTop={1}>
            {paletteCommands.length === 0 ? (
              <Text color={theme.faint}>no matching command — Esc to clear</Text>
            ) : paletteCommands.map((command, index) => (
              <Text key={command.name}>
                <Text color={index === commandIndex ? theme.accentBright : theme.faint}>{index === commandIndex ? `${glyphs.chevron} ` : "  "}</Text>
                <Text color={index === commandIndex ? theme.text : theme.muted} bold={index === commandIndex}>/{command.name}</Text>
                <Text color={theme.faint}>  {command.hint}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      {resumeNote ? (
        <Box marginTop={1} justifyContent="center">
          <Text color={theme.danger}>{resumeNote}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} justifyContent="center">
        <Text color={theme.faint}>Enter run · / commands · Tab cycle example · ↑/↓ browse · m toggle mode · Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
