import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import "./envConfig.js";
import { projectRoot } from "./envConfig.js";

const logDir = resolve(projectRoot, ".orvix", "logs");
const crashLogPath = resolve(logDir, "api-crash.log");

function logCrash(kind: string, error: unknown) {
  const line = `[${new Date().toISOString()}] ${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
  // eslint-disable-next-line no-console
  console.error(line);
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(crashLogPath, line);
  } catch {
    // Disk may be the reason we're here; losing the log entry is not worth crashing over.
  }
}

// A single unhandled rejection or thrown error anywhere in the many
// concurrent agent/qwen/git code paths must not take down every mission
// the server is holding in memory (there is no disk-backed resume). Log it
// and keep serving instead of dying silently.
process.on("unhandledRejection", (error) => logCrash("unhandledRejection", error));
process.on("uncaughtException", (error) => logCrash("uncaughtException", error));

import "./server.js";
