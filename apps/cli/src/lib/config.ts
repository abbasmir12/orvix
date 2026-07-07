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
  /** Last Alibaba Cloud API URL/token that verified successfully, so the SetupWizard can offer them again next run. */
  lastCloudUrl?: string;
  lastCloudToken?: string;
};

const defaults: OrvixCliConfig = {
  mouseTrack: true
};

const configDir = join(homedir(), ".orvix");
const configPath = join(configDir, "cli.json");

function loadConfigFile(): Partial<OrvixCliConfig> {
  try {
    if (!existsSync(configPath)) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(defaults, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return {};
    }
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<OrvixCliConfig>;
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
  mouseTrack: envBool("ORVIX_MOUSE_TRACK") ?? fileConfig.mouseTrack ?? defaults.mouseTrack,
  lastCloudUrl: fileConfig.lastCloudUrl,
  lastCloudToken: fileConfig.lastCloudToken
};

/**
 * Persists a verified Alibaba Cloud connection to ~/.orvix/cli.json (mode
 * 0600, since it may hold a bearer token) so the SetupWizard can autofill it
 * next run. Best-effort: a failed write should never block the CLI.
 */
export function saveLastCloudConnection(url: string, token?: string) {
  cliConfig.lastCloudUrl = url;
  cliConfig.lastCloudToken = token;
  try {
    mkdirSync(configDir, { recursive: true });
    const current = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    const next = { ...current, lastCloudUrl: url, lastCloudToken: token };
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort persistence only
  }
}
