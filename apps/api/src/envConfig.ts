import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function findEnvFile(start = process.cwd()) {
  let current = resolve(start);

  while (true) {
    const candidate = resolve(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function loadEnvFile(path = findEnvFile()) {
  if (!path) {
    return;
  }

  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();
export const projectRoot = dirname(findEnvFile() ?? resolve(process.cwd(), ".env"));
export const workspaceRoot = resolve(projectRoot, ".orvix", "workspaces");

/**
 * Positive-int env knob. `0`, `none`, or `unlimited` disables the cap
 * entirely (returns a value far above any realistic agent count); otherwise
 * the value is clamped to `max` to keep typos from spawning 1000 sessions.
 */
export function envPositiveInt(name: string, fallback: number, max = 20) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "none" || raw === "unlimited") return 9999;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.floor(value));
}

