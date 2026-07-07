#!/usr/bin/env node
import React, { useEffect, useRef, useState } from "react";
import { Command } from "commander";
import { render } from "ink";
import { App } from "./App.js";
import { LaunchPrompt } from "./components/LaunchPrompt.js";
import { SetupWizard, type RuntimeProfile } from "./components/SetupWizard.js";

type RunMode = "mock" | "cloud";

function Root({
  initialMission,
  initialMode,
  apiUrl,
  apiToken,
  resumeId
}: {
  initialMission?: string;
  initialMode: RunMode;
  apiUrl?: string;
  apiToken?: string;
  resumeId?: string;
}) {
  const [mission, setMission] = useState(initialMission ?? "");
  const [activeResumeId, setActiveResumeId] = useState(resumeId);
  const [runtime, setRuntime] = useState<RuntimeProfile>({
    mode: initialMode,
    apiUrl: apiUrl ?? process.env.ORVIX_API_URL ?? "http://localhost:8787",
    apiToken: apiToken ?? process.env.ORVIX_API_TOKEN
  });
  const [setupComplete, setSetupComplete] = useState(Boolean(initialMission || resumeId || process.env.ORVIX_SKIP_ONBOARDING));

  // Ink never erases rows above a new frame that is shorter than the last —
  // switching SetupWizard -> LaunchPrompt -> App left stale rows from the
  // previous screen pinned above the new one. Hard-clear on screen
  // boundaries only (never on first mount — clearing before Ink's first
  // paint leaves a blank screen until something else forces a repaint,
  // e.g. maximizing the window).
  const mountedRoot = useRef(false);
  useEffect(() => {
    if (!mountedRoot.current) {
      mountedRoot.current = true;
      return;
    }
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }, [setupComplete, Boolean(mission), Boolean(activeResumeId)]);

  if (activeResumeId) {
    return <App mission={mission || `Resuming ${activeResumeId}`} mode="cloud" apiUrl={runtime.apiUrl} apiToken={runtime.apiToken} resumeId={activeResumeId} />;
  }

  if (mission) {
    return <App mission={mission} mode={runtime.mode} apiUrl={runtime.apiUrl} apiToken={runtime.apiToken} />;
  }

  if (!setupComplete) {
    return (
      <SetupWizard
        defaultApiUrl={runtime.apiUrl}
        defaultApiToken={runtime.apiToken}
        onComplete={(profile) => {
          setRuntime(profile);
          setSetupComplete(true);
        }}
      />
    );
  }

  return (
    <LaunchPrompt
      mode={runtime.mode}
      onModeChange={(mode) => setRuntime((current) => ({ ...current, mode }))}
      apiUrl={runtime.apiUrl}
      apiToken={runtime.apiToken}
      onSubmit={setMission}
      onResume={setActiveResumeId}
    />
  );
}

// Alt-screen isolates our frame in its own buffer for the whole app
// lifetime: mouse y=1 is genuinely our top row (not an offset into
// scrollback), which panel-hover hit-testing depends on, and it also
// keeps the real terminal scrollback clean of every intermediate frame.
const enableAltScreen = "[?1049h";
const disableAltScreen = "[?1049l";

/**
 * SSH sessions (and some ConPTY/Windows Terminal panes) can hand the remote
 * shell a stale terminal size at connect time — process.stdout.columns/rows
 * only gets corrected once the client sends a real window-change, which
 * normally only happens when the user actually resizes the window. Ink's
 * very first layout pass then runs against the wrong dimensions and paints
 * nothing, which looks identical to a blank screen until the user nudges
 * the window. Probe the terminal's real size directly with a cursor-position
 * report (works over plain SSH, unlike trusting the reported columns/rows)
 * and patch it in before Ink ever renders.
 */
function probeRealTerminalSize(timeoutMs = 200): Promise<{ columns: number; rows: number } | null> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }
    const wasRaw = process.stdin.isRaw;
    let settled = false;
    let buffer = "";

    const finish = (size: { columns: number; rows: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      if (!wasRaw) process.stdin.setRawMode?.(false);
      resolve(size);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/\x1b\[(\d+);(\d+)R/);
      if (match) finish({ rows: Number(match[1]), columns: Number(match[2]) });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    process.stdin.setRawMode?.(true);
    process.stdin.on("data", onData);
    // Save cursor, jump to a position far past any real terminal's bounds
    // (the terminal clamps it to its actual last row/column), ask for a
    // cursor position report, then restore — invisible to the user.
    process.stdout.write("[s[999;999H[6n[u");
  });
}

async function runMission(missionParts: string[] = [], options: { mode?: RunMode; apiUrl?: string; apiToken?: string; resume?: string } = {}) {
  const mission = missionParts.join(" ").trim();

  const realSize = await probeRealTerminalSize();
  if (realSize && realSize.columns > 0 && realSize.rows > 0) {
    process.stdout.columns = realSize.columns;
    process.stdout.rows = realSize.rows;
  }

  process.stdout.write(enableAltScreen);
  const restore = () => process.stdout.write(disableAltScreen);
  process.on("exit", restore);
  try {
    const instance = render(
      <Root
        initialMission={mission || undefined}
        initialMode={options.mode ?? "mock"}
        apiUrl={options.apiUrl}
        apiToken={options.apiToken}
        resumeId={options.resume}
      />
    );
    // Safety net in case the probe above timed out or the terminal ignored
    // it: still nudge Ink to recompute once the buffer has settled.
    setTimeout(() => process.stdout.emit("resize"), 50);
    await instance.waitUntilExit();
  } finally {
    process.off("exit", restore);
    restore();
  }
}

const program = new Command();

program
  .name("orvix")
  .description("CLI mission console for an autonomous AI engineering organization")
  .version("0.1.0");

program
  .command("mission [request...]")
  .description("Analyze a product mission and run the mock multi-agent delivery simulation")
  .option("--mode <mode>", "Run mode: mock or cloud", "mock")
  .option("--api-url <url>", "Orvix API URL for cloud mode", "http://localhost:8787")
  .option("--api-token <token>", "Bearer token for a secured Orvix API")
  .option("--resume <missionId>", "Resume a mission from the API's disk snapshots (implies cloud mode)")
  .action(async (request: string[] = [], options: { mode?: string; apiUrl?: string; apiToken?: string; resume?: string }) => {
    const mode = options.mode === "cloud" ? "cloud" : "mock";
    await runMission(request, { mode, apiUrl: options.apiUrl, apiToken: options.apiToken, resume: options.resume });
  });

program.action(async () => {
  await runMission();
});

await program.parseAsync(process.argv);
