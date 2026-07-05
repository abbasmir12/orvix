#!/usr/bin/env node
import React, { useState } from "react";
import { Command } from "commander";
import { render } from "ink";
import { App } from "./App.js";
import { LaunchPrompt } from "./components/LaunchPrompt.js";

type RunMode = "mock" | "cloud";

function Root({
  initialMission,
  initialMode,
  apiUrl,
  resumeId
}: {
  initialMission?: string;
  initialMode: RunMode;
  apiUrl?: string;
  resumeId?: string;
}) {
  const [mission, setMission] = useState(initialMission ?? "");
  const [mode, setMode] = useState<RunMode>(initialMode);

  if (resumeId) {
    return <App mission={mission || `Resuming ${resumeId}`} mode="cloud" apiUrl={apiUrl} resumeId={resumeId} />;
  }

  if (mission) {
    return <App mission={mission} mode={mode} apiUrl={apiUrl} />;
  }

  return <LaunchPrompt mode={mode} onModeChange={setMode} apiUrl={apiUrl ?? "http://localhost:8787"} onSubmit={setMission} />;
}

// Alt-screen isolates our frame in its own buffer for the whole app
// lifetime: mouse y=1 is genuinely our top row (not an offset into
// scrollback), which panel-hover hit-testing depends on, and it also
// keeps the real terminal scrollback clean of every intermediate frame.
const enableAltScreen = "[?1049h";
const disableAltScreen = "[?1049l";

async function runMission(missionParts: string[] = [], options: { mode?: RunMode; apiUrl?: string; resume?: string } = {}) {
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
  .option("--resume <missionId>", "Resume a mission from the API's disk snapshots (implies cloud mode)")
  .action(async (request: string[] = [], options: { mode?: string; apiUrl?: string; resume?: string }) => {
    const mode = options.mode === "cloud" ? "cloud" : "mock";
    await runMission(request, { mode, apiUrl: options.apiUrl, resume: options.resume });
  });

program.action(async () => {
  await runMission();
});

await program.parseAsync(process.argv);
