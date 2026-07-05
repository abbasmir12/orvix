import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { BrandMark } from "./BrandMark.js";
import { glyphs, theme } from "../lib/theme.js";

export type RuntimeProfile = {
  mode: "mock" | "cloud";
  apiUrl: string;
  apiToken?: string;
};

type SetupWizardProps = {
  defaultApiUrl: string;
  defaultApiToken?: string;
  onComplete: (profile: RuntimeProfile) => void;
};

type RuntimeChoice = "demo" | "local" | "cloud";
type Field = "url" | "token";
type CheckState =
  | { status: "idle" }
  | { status: "checking"; label: string }
  | { status: "ok"; label: string }
  | { status: "failed"; label: string };

const choices: Array<{
  id: RuntimeChoice;
  title: string;
  badge: string;
  summary: string;
  detail: string;
}> = [
  {
    id: "demo",
    title: "Demo cockpit",
    badge: "SCRIPTED",
    summary: "Explore Orvix without Qwen calls.",
    detail: "Runs the local fixed simulation. Best for quick walkthroughs and UI demos."
  },
  {
    id: "local",
    title: "Local runtime",
    badge: "DEV",
    summary: "Run the Orvix API on this machine.",
    detail: "CLI connects to localhost; missions, files, builds, and logs stay on your computer."
  },
  {
    id: "cloud",
    title: "Alibaba Cloud runtime",
    badge: "LIVE",
    summary: "Use a deployed Orvix API.",
    detail: "CLI becomes the cockpit; Alibaba Cloud runs Orvix Map, Book, agents, files, and Qwen calls."
  }
];

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, "") : `http://${trimmed.replace(/\/+$/, "")}`;
}

function RuntimeCard({
  active,
  choice
}: {
  active: boolean;
  choice: typeof choices[number];
}) {
  return (
    <Box
      flexDirection="column"
      width={34}
      minHeight={8}
      marginRight={1}
      paddingX={1}
      paddingY={1}
      borderStyle={active ? "round" : "single"}
      borderColor={active ? theme.borderActive : theme.border}
    >
      <Text color={active ? theme.accentBright : theme.muted} bold>
        {active ? glyphs.chevron : " "} {choice.title}
      </Text>
      <Text color={active ? theme.cloud : theme.faint}>[{choice.badge}]</Text>
      <Box marginTop={1}>
        <Text color={theme.text}>{choice.summary}</Text>
      </Box>
      <Text color={theme.faint}>{choice.detail}</Text>
    </Box>
  );
}

function StatusLine({ check }: { check: CheckState }) {
  if (check.status === "checking") {
    return <Text color={theme.cloud}>{glyphs.active} {check.label}</Text>;
  }
  if (check.status === "ok") {
    return <Text color={theme.success}>{glyphs.done} {check.label}</Text>;
  }
  if (check.status === "failed") {
    return <Text color={theme.warning}>{glyphs.degraded} {check.label}</Text>;
  }
  return <Text color={theme.faint}>Select a runtime. Orvix will verify live API endpoints before continuing.</Text>;
}

export function SetupWizard({ defaultApiUrl, defaultApiToken = "", onComplete }: SetupWizardProps) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cloudUrl, setCloudUrl] = useState(defaultApiUrl);
  const [token, setToken] = useState(defaultApiToken);
  const [field, setField] = useState<Field>("url");
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const selected = choices[selectedIndex];

  async function verifyAndContinue(choice: RuntimeChoice) {
    if (choice === "demo") {
      onComplete({ mode: "mock", apiUrl: "http://localhost:8787" });
      return;
    }

    const apiUrl = choice === "local" ? "http://localhost:8787" : normalizeUrl(cloudUrl);
    if (!apiUrl) {
      setCheck({ status: "failed", label: "Enter the deployed Orvix API URL first." });
      return;
    }

    setCheck({ status: "checking", label: `Checking ${apiUrl}/health...` });
    try {
      const health = await fetch(`${apiUrl}/health`);
      if (!health.ok) {
        setCheck({ status: "failed", label: `/health returned ${health.status}. Check the API URL and Alibaba security group.` });
        return;
      }

      const headers = token.trim() ? { Authorization: `Bearer ${token.trim()}` } : undefined;
      const runtime = await fetch(`${apiUrl}/runtime/check`, { headers });
      if (runtime.status === 401) {
        setCheck({ status: "failed", label: "Runtime requires a valid ORVIX_API_TOKEN." });
        return;
      }
      if (!runtime.ok) {
        setCheck({ status: "failed", label: `/runtime/check returned ${runtime.status}; /health works but runtime is not ready.` });
        return;
      }

      setCheck({ status: "ok", label: "Runtime verified. Opening mission launcher..." });
      setTimeout(() => onComplete({ mode: "cloud", apiUrl, apiToken: token.trim() || undefined }), 350);
    } catch {
      setCheck({ status: "failed", label: `Cannot reach ${apiUrl}. Check server, port, and ECS security group.` });
    }
  }

  useEffect(() => {
    setCheck({ status: "idle" });
  }, [selectedIndex, cloudUrl, token]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (key.leftArrow) {
      setSelectedIndex((current) => (current === 0 ? choices.length - 1 : current - 1));
      return;
    }

    if (key.rightArrow) {
      setSelectedIndex((current) => (current + 1) % choices.length);
      return;
    }

    if (key.tab) {
      setField((current) => current === "url" ? "token" : "url");
      return;
    }

    if (key.return) {
      void verifyAndContinue(selected.id);
      return;
    }

    if (selected.id !== "cloud") return;

    if (key.backspace || key.delete) {
      if (field === "url") setCloudUrl((current) => current.slice(0, -1));
      if (field === "token") setToken((current) => current.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (field === "url") setCloudUrl((current) => `${current}${input}`);
      if (field === "token") setToken((current) => `${current}${input}`);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <BrandMark />
        <Text color={theme.muted}>Choose where the Orvix agent society should run.</Text>
      </Box>

      <Box justifyContent="center" marginTop={1}>
        {choices.map((choice, index) => (
          <RuntimeCard key={choice.id} choice={choice} active={index === selectedIndex} />
        ))}
      </Box>

      {selected.id === "cloud" ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.cloud} paddingX={2} paddingY={1}>
          <Text color={theme.cloud} bold>Cloud connection</Text>
          <Text color={field === "url" ? theme.accentBright : theme.muted}>
            API URL    {field === "url" ? glyphs.chevron : " "} {cloudUrl || "https://your-orvix-api.example.com"}
          </Text>
          <Text color={field === "token" ? theme.accentBright : theme.muted}>
            API token  {field === "token" ? glyphs.chevron : " "} {token ? "•".repeat(Math.min(token.length, 28)) : "optional unless server requires ORVIX_API_TOKEN"}
          </Text>
          <Text color={theme.faint}>Alibaba ECS note: open the API port in the security group, or put the API behind 80/443.</Text>
        </Box>
      ) : null}

      <Box marginTop={1} justifyContent="center">
        <StatusLine check={check} />
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color={theme.faint}>←/→ runtime · Tab field · Enter verify/start · Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
