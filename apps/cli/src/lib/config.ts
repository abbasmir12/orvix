import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User-editable CLI config at ~/.orvix/cli.json, written with defaults on
 * first run so it is discoverable. Env vars override the file:
 *   ORVIX_MOUSE_TRACK=false   disable mouse escape sequences (recommended on
 *                             slow SSH / EC2 sessions — wheel/hover tracking
 *                             floods the connection and garbles input)
 */
export type OrvixCliConfig = {
  /** Emit terminal mouse-tracking sequences for wheel scroll + panel hover. */
  mouseTrack: boolean;
};

const defaults: OrvixCliConfig = {
  mouseTrack: true
};

function loadConfigFile(): Partial<OrvixCliConfig> {
  const dir = join(homedir(), ".orvix");
  const path = join(dir, "cli.json");
  try {
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
      return {};
    }
    return JSON.parse(readFileSync(path, "utf8")) as Partial<OrvixCliConfig>;
  } catch {
    return {};
  }
}

function envBool(name: string): boolean | undefined {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return undefined;
}

const fileConfig = loadConfigFile();

export const cliConfig: OrvixCliConfig = {
  mouseTrack: envBool("ORVIX_MOUSE_TRACK") ?? fileConfig.mouseTrack ?? defaults.mouseTrack
};
