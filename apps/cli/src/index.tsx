#!/usr/bin/env node
import React, { useState } from "react";
import { Command } from "commander";
import { render } from "ink";
import { App } from "./App.js";
import { LaunchPrompt } from "./components/LaunchPrompt.js";

type RunMode = "mock" | "cloud";

function Root({
  initialMission,
  mode,
  apiUrl
}: {
  initialMission?: string;
  mode: RunMode;
  apiUrl?: string;
}) {
  const [mission, setMission] = useState(initialMission ?? "");

  if (mission) {
    return <App mission={mission} mode={mode} apiUrl={apiUrl} />;
  }

  return <LaunchPrompt onSubmit={setMission} />;
}

async function runMission(missionParts: string[] = [], options: { mode?: RunMode; apiUrl?: string } = {}) {
  const mission = missionParts.join(" ").trim();
  const instance = render(
    <Root
      initialMission={mission || undefined}
      mode={options.mode ?? "mock"}
      apiUrl={options.apiUrl}
    />
  );
  await instance.waitUntilExit();
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
  .action(async (request: string[] = [], options: { mode?: string; apiUrl?: string }) => {
    const mode = options.mode === "cloud" ? "cloud" : "mock";
    await runMission(request, { mode, apiUrl: options.apiUrl });
  });

program.action(async () => {
  await runMission();
});

await program.parseAsync(process.argv);
