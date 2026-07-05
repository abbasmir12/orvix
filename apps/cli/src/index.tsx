#!/usr/bin/env node
import React, { useState } from "react";
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

async function runMission(missionParts: string[] = [], options: { mode?: RunMode; apiUrl?: string; apiToken?: string; resume?: string } = {}) {
  const mission = missionParts.join(" ").trim();
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
