# CLI Guide

The Orvix CLI (`apps/cli`) is an Ink/React terminal cockpit. It never talks to Qwen or git
directly — everything goes through the Orvix API over REST + SSE, so the CLI can run on a
different machine than the API (see `SETUP.md` §6.5).

## Launching

```bash
node apps/cli/dist/index.js                     # opens the SetupWizard / launcher
node apps/cli/dist/index.js mission "<text>"     # skip the launcher, start a mission directly
node apps/cli/dist/index.js --resume <missionId> # reattach to a mission already on disk
```

Flags (all optional):

| Flag | Meaning |
| --- | --- |
| `--mode <mock\|cloud>` | `mock` (default) runs a scripted local demo, no API key or server needed. `cloud` talks to a real Orvix API. |
| `--api-url <url>` | Orvix API base URL. Default `http://localhost:8787` or `$ORVIX_API_URL`. |
| `--api-token <token>` | Bearer token, if the API has `ORVIX_API_TOKEN` set. |
| `--resume <missionId>` | Resume a mission from the API's on-disk snapshot. Implies cloud mode. |

## First run: the SetupWizard

With no mission text and no `--resume`, the CLI opens the SetupWizard (unless
`ORVIX_SKIP_ONBOARDING` is set). Three runtime cards:

- **Demo cockpit** — a scripted timeline with fake metrics; no API key, no running server.
  Good for a quick look at the UI without spending any Qwen budget.
- **Local runtime** — connects to `http://localhost:8787`; use this while developing.
- **Alibaba Cloud runtime** — paste a public API URL and its `ORVIX_API_TOKEN`. The wizard
  calls `/health` then `/runtime/check` before proceeding, so a bad token, wrong URL, or a
  closed ECS security-group port is caught immediately with a specific message — not a hang.

## The mission launcher

Type a mission in plain English and press Enter. There's also a resume picker (recent
missions from `GET /missions/disk`) if you'd rather continue something already running.

## The cockpit

Every screen — planning and execution — shares a **left rail**: the Orvix brand mark, the
mission text, the current phase, delivery/usage counters, and a **live view of the mission's
actual repo file tree** (polled from the workspace, colored by file type, folders/files with
tree connectors). The rail is what makes the cockpit legible even on a small terminal: the
main panels adapt around it rather than the other way around.

### Keybindings (cockpit)

| Key | Action |
| --- | --- |
| `Tab` | Cycle focus between the Focus / Agents / Activity / prompt panels |
| `←` / `→` | Cycle the activity tab (turns / signals / prs / decisions / reasoning / book / brief) |
| `1`–`7` | Jump directly to an activity tab |
| `↑` / `↓` | Scroll the focused panel, or move the agent selection in the Agents panel |
| `Enter` | On the Agents panel, open the inspector for the selected agent |
| `PageUp` / `PageDown` | Scroll faster (6 lines) in the focused panel or inspector |
| `m` | Open the menu overlay |
| `0` | Reset to the default view (or close the inspector/menu) |
| `q` / `Ctrl+C` | Quit |
| `/` | Open the prompt bar in **command mode** — see below |
| `@` | Open the prompt bar with an **agent mention** already started |

Inside the agent inspector: `1`–`5` switch inspector tabs, `←`/`→` also cycle them, `p`/`n`
move to the previous/next agent.

### Activity tabs

`turns` (live agent tool-call feed, default) · `signals` · `prs` · `decisions` · `reasoning` ·
`book` (Orvix Book ledger) · `brief` (versioned MasterMind mission debrief — see below).

### The prompt bar: commands and the owner channel

Press `/` for commands:

```text
/help                 list commands
/quit                 exit
/autopilot            toggle the scheduler's autopilot loop
/next                 execute the next unblocked task
/review               review the next pending PR
/tab <name>           jump to an activity tab by name
/missions              list missions on disk
/resume <missionId>   resume a mission
```

Anything typed that **isn't** a `/command` is sent as an **owner instruction** to the
mission — this is how a human steers a mission that's already running, or gives follow-up
requests after it completes (e.g. "switch to a dark theme", "add CSV export"). MasterMind is
always CC'd on owner messages. Type `@` to open the mention picker and address a specific
agent by name; arrow keys move the highlight, `Tab`/`Enter` inserts the highlighted agent id.

Behind the scenes this hits `POST /missions/:id/owner`, which routes the instruction through
`masterMindOwnerTriage`: reopen a PR, delegate via a Book contract to an existing agent, or —
if no current specialist fits — **hire a new agent** for the request. A hired agent shows up
in the Agent Network panel automatically, with its own queued task and welcome contract. See
[`owner-channel/`](../owner-channel/) for exactly how a reopened PR gets picked up by the
scheduler with no special-casing required.

### Mission debrief (`brief` tab)

When a mission completes, MasterMind generates a versioned debrief: what was built, how, the
key files to look at, how to test it, any to-dos for the owner, and suggested next steps. The
Focus panel shows a "debrief vN ready" indicator on MasterMind the moment it's posted. An
owner instruction that reopens work after completion produces a new version (v2, v3, …) rather
than overwriting the first.

## Slow connections (SSH / high latency)

If you're running the CLI over a slow SSH tunnel, two things help:

- Set `ORVIX_MOUSE_TRACK=false` (or `~/.orvix/cli.json` → `{"mouseTrack": false}`) to stop the
  terminal from emitting mouse-tracking escape codes, which otherwise flood a laggy link.
- The SSE client has a 60-second idle watchdog and auto-reconnects with a full state refetch,
  showing "Stream interrupted — reconnecting…" instead of silently going stale.

## Mock mode vs. cloud mode

`--mode mock` needs no API key and no running server — it's a deterministic, scripted replay
of the UI for demos or screenshots. It cannot exercise the real scheduler, Qwen calls, or git
operations; use `--mode cloud` against a real API (local or Alibaba Cloud) for an actual
mission.
