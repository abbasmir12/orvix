# Orvix

<div align="center">

<pre>
   ▄██████▄  ▄████████  ███    ███  ▄█  ▀████    ▐████▀
  ███    ███ ███    ███ ███    ███ ███    ███▌   ████▀
  ███    ███ ███    ███  ███  ███  ███     ███  ▐███
  ███    ███ ████████▀    ██████   ███     ▀███▄███▀
  ███    ███ ███   ███     ████    ███     ████▀██▄
  ███    ███ ███    ███     ██     ███    ▐███  ▀███
   ▀██████▀  ███    ███      ▀     █▀    ▄████    ███▄
     ══╡ Self-organizing AI engineering company ╞══
</pre>

</div>

**Orvix turns one product request into an on-demand AI engineering agency.** It plans the project, creates the specialist agents it needs, lets them coordinate through shared memory, runs their work in parallel branches, reviews their PR-style submissions, and keeps expanding the team when the mission changes.

Instead of a fixed chatbot or a static list of roles, Orvix behaves like a living software organization: **MasterMind directs the mission, Strategy Weaver designs the team, specialists build, Critic Council reviews, and the owner can interrupt mid-flight to redirect or request new work.**

```text
User mission
  -> MasterMind analysis
  -> Orvix Map
  -> dynamic agent organization
  -> parallel implementation branches
  -> Orvix Book coordination
  -> Critic Council reviews
  -> runtime acceptance
  -> final delivery brief
```

The goal is not to make one AI assistant pretend to be many roles. The goal is to build an agent runtime that can organize itself around the work: decompose the mission, create agents on demand, negotiate through a shared ledger, resolve conflicts, review code, and produce a working output.

## Why This Exists

Most coding agents are single-threaded. They receive a request, produce code, and maybe revise it. Orvix explores a different model:

```text
software delivery as an autonomous agent society
```

Orvix is designed around four ideas:

- **Self-organization**: MasterMind and Strategy Weaver decide which agents the mission needs.
- **Self-expansion**: the [owner channel](docs/owner-channel/) can cause MasterMind to route follow-up work or hire a new specialist.
- **Parallel execution**: independent agents work in parallel through a dependency-aware scheduler.
- **Shared organizational memory**: agents coordinate through the [Orvix Book](docs/orvix-book/) instead of one giant shared prompt.

This creates a different product experience: the user asks for an outcome, and Orvix forms the temporary engineering company needed to deliver it.

## What Orvix Builds

Orvix can receive high-level software missions such as:

```text
Build a SaaS CRM with auth, dashboard, contacts and notes.
Build a small playable 2D web game in React.
Build a weather dashboard with search, favorites and error states.
```

For each mission, Orvix creates a dedicated workspace under `.orvix/workspaces/<missionId>/`, scaffolds a project, runs agents against real files, opens internal PR-style work items, reviews them, merges approved branches, and runs build/acceptance checks before finalizing the mission.

## Core System Concepts

### MasterMind Agent

[MasterMind](docs/architecture/) is the mission director. It reads the user request, watches the mission, resolves conflicts, routes owner instructions, and decides when the project is ready for release.

MasterMind is not a fixed script. It receives live mission state, [Orvix Book](docs/orvix-book/) context, PR status, task status, runtime failures, owner requests, and Qwen reasoning output.

### Orvix Map

The **[Orvix Map](docs/orvix-map/)** is the locked build contract for the mission.

It defines:

- product scope
- pages, screens, routes, endpoints, or CLI commands
- components and interaction contracts
- data and system contracts
- design direction
- agent work packets
- file ownership hints
- acceptance gates
- forbidden outputs

Every agent, reviewer, and acceptance gate reads from the same map. This prevents agents from inventing incompatible versions of the product.

### Orvix Book

The **[Orvix Book](docs/orvix-book/)** is the shared coordination ledger.

Agents post:

- questions
- answers
- assumptions
- contracts
- handoffs
- conflicts
- review notes
- owner instructions

Each agent receives a filtered slice of the Book when it starts a session. This is effectively Orvix's **Agentic Loop Prompt**: agents continuously influence each other through structured messages, not just through the original user prompt.

### Strategy Weaver

[Strategy Weaver](docs/planning/) designs the agent society for the mission. It can create a small team for a small project or a larger organization for a complex product. The system prefers useful specialists over filler roles.

Agents are encouraged to own vertical slices when possible: a complete capability or surface end-to-end, rather than artificial frontend/backend/style fragments that create unnecessary dependency chains.

### Critic Council

[Critic Council](docs/collaboration/) reviews PR-style work against the [Orvix Map](docs/orvix-map/). It sees the diff and the current branch file contents, so it is not fooled by small diffs or already-merged work.

It can:

- approve PRs
- request changes
- reject markdown-only implementation work
- flag missing source evidence
- route concrete revision requirements back to the responsible agent

### Owner Channel

The human owner can steer a running mission from the cockpit through the **[owner channel](docs/owner-channel/)**.

Examples:

```text
make the UI more premium and dark
@frontend-manager switch the dashboard to black and white
@critic-council review the auth flow more strictly
```

Owner messages enter the [Orvix Book](docs/orvix-book/) as first-class entries from `owner`. MasterMind is always aware of them. Direct `@agent-id` mentions route to that agent and can reopen work; unaddressed instructions go through MasterMind triage. If no current agent fits the request, MasterMind can create a new specialist for that work.

## Architecture

![Orvix architecture](docs/architecture/diagrams/architecture.png)

Orvix has two runtimes:

| Runtime | Role |
| --- | --- |
| `apps/api` | The actual Orvix runtime: planning, scheduling, Qwen calls, Orvix Map, Orvix Book, git workspaces, reviews, acceptance checks |
| `apps/cli` | The cockpit: SetupWizard, mission launcher, planning console, execution cockpit, activity tabs, owner prompt bar |

The CLI never calls Qwen directly and never mutates git. It talks to the API over REST and Server-Sent Events.

This makes the cloud architecture meaningful:

```text
Local CLI = cockpit
Alibaba Cloud API = agent society runtime
Qwen Cloud = model reasoning and tool-call generation
```

Read more: [docs/architecture/](docs/architecture/)

## Mission Lifecycle

### 1. Planning

After mission creation, Orvix runs a streamed planning pipeline:

```text
research
planning council
scaffold choice
MasterMind analysis
Orvix Map draft/review/lock
Strategy Weaver organization design
Critic Council rubric
```

The CLI shows these stages live in the planning console.

Read more: [docs/planning/](docs/planning/)

### 2. Execution

The scheduler runs a continuous work pool. Revisions, signal handling, PR reviews, agent executions, and build gates can all be active as independent job types.

Agents run multi-turn Qwen sessions with real tools:

```text
list_files
read_file
write_file
delete_file
create_branch
commit_changes
open_pr
post_book_entry
read_book
read_signals
research_web
fetch_url
```

The model emits tool calls; Orvix executes them against the workspace; tool results are fed back into the next turn.

## Where Generated Projects Live

Each Orvix mission gets its own generated project repo inside the Orvix runtime workspace:

```text
.orvix/
  workspaces/
    <missionId>/
      repo/                 generated project repository
        .git/               mission git repo
        <project files>     app/site/API/game created by agents
  runs/
    <missionId>/            mission state, events, Book, signals, turns
```

If you choose **Local runtime**, these folders are created on your local machine, inside the Orvix repo you started the API from.

If you choose **Alibaba Cloud runtime**, these folders are created on the Alibaba ECS server, because the API running there owns the agent tools, git workspace, build checks, and generated files. Your local CLI is only the cockpit.

```text
Local runtime:
  your machine -> .orvix/workspaces/<missionId>/repo

Alibaba Cloud runtime:
  ECS server -> .orvix/workspaces/<missionId>/repo
```

Mission snapshots live separately under `.orvix/runs/<missionId>/`, so a restarted API can resume a mission from disk.

### 3. Collaboration

Agents coordinate through the Orvix Book and deterministic guardrails:

- dependency notes
- file ownership checks
- merge conflict routing
- reviewer revision loops
- MasterMind wake-up pass for blocked work

Read more: [docs/collaboration/](docs/collaboration/)

### 4. Review

Every PR-style work item goes through review. Critic Council validates it against the Orvix Map and branch file contents.

### 5. Runtime Acceptance

When required PRs are approved, Orvix builds the generated project and checks whether the shipped output satisfies the mission.

### 6. Debrief

MasterMind creates a versioned mission brief describing what was built, how to run it, key files, owner actions, and next steps.

## Setup

### Prerequisites

- Node.js 20+
- npm
- git
- Alibaba Cloud Model Studio / DashScope API key for live Qwen mode

### Local Run

```bash
git clone <repo-url> orvix
cd orvix
cp .env.example .env
# set DASHSCOPE_API_KEY
npm install
npm run build
```

Start the API:

```bash
npm run start:api
```

In another terminal, launch the cockpit:

```bash
npm run dev
```

The SetupWizard offers:

| Mode | Purpose |
| --- | --- |
| Demo cockpit | Scripted local replay, no Qwen calls |
| Local runtime | CLI connects to `http://localhost:8787` |
| Alibaba Cloud runtime | CLI connects to a deployed Orvix API |

Full setup guide: [docs/SETUP.md](docs/SETUP.md)

## Alibaba Cloud Deployment

To run Orvix as a remote agent runtime, deploy the **Orvix API** to Alibaba Cloud ECS and connect the CLI to it.

On the ECS instance:

```bash
git clone <repo-url> orvix
cd orvix
cp .env.example .env
```

Set:

```bash
DASHSCOPE_API_KEY=...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
ORVIX_API_TOKEN=<long-random-secret>
PORT=8787
```

Then:

```bash
npm install
npm run build
npm run start:api
```

Verify:

```bash
curl http://<ecs-public-ip>:8787/health
```

Expected:

```json
{
  "service": "orvix-api",
  "status": "ok",
  "provider": "Alibaba Cloud ready",
  "qwen": "configured"
}
```

From your laptop, run the CLI and choose **Alibaba Cloud runtime**, then paste:

- API URL: `http://<ecs-public-ip>:8787`
- API token: the same `ORVIX_API_TOKEN`

In this setup:

```text
your laptop runs the cockpit
Alibaba Cloud runs the Orvix runtime
Qwen Cloud handles model reasoning
generated project files are created on the cloud server
```

## Environment

Minimum live configuration:

```bash
DASHSCOPE_API_KEY=...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
```

For public/cloud API deployments:

```bash
ORVIX_API_TOKEN=<long-random-secret>
```

The CLI sends:

```text
Authorization: Bearer <ORVIX_API_TOKEN>
```

Full reference: [docs/env-reference/](docs/env-reference/)

## API Examples

Create a live Qwen-backed mission:

```bash
curl -X POST http://localhost:8787/missions \
  -H "Content-Type: application/json" \
  -d '{"mission":"Build a SaaS CRM with auth, dashboard, contacts and notes","mode":"qwen"}'
```

Inspect state:

```bash
curl http://localhost:8787/missions/<mission_id>
curl http://localhost:8787/missions/<mission_id>/metrics
curl http://localhost:8787/missions/<mission_id>/book
```

Post an owner instruction:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/owner \
  -H "Content-Type: application/json" \
  -d '{"message":"make the dashboard darker and more premium"}'
```

## Repository Layout

```text
apps/
  api/              Orvix runtime API
  cli/              Ink/React terminal cockpit

packages/
  core/             shared types, simulation state, run store
  qwen/             Qwen/DashScope client, prompts, tool schemas
  workspace/        git workspace, worktrees, file tools, scaffold helpers

docs/
  architecture/     system architecture and diagrams
  orvix-map/        locked mission blueprint
  orvix-book/       shared agent ledger
  planning/         planning pipeline
  collaboration/    negotiation and conflict handling
  owner-channel/    human-in-the-loop steering
  cli/              CLI cockpit guide
  env-reference/    environment variables
  SETUP.md          local and Alibaba Cloud setup
```

## Documentation Map

| Topic | Link |
| --- | --- |
| Architecture | [docs/architecture/](docs/architecture/) |
| Setup | [docs/SETUP.md](docs/SETUP.md) |
| CLI | [docs/cli/](docs/cli/) |
| Orvix Map | [docs/orvix-map/](docs/orvix-map/) |
| Orvix Book | [docs/orvix-book/](docs/orvix-book/) |
| Planning | [docs/planning/](docs/planning/) |
| Collaboration | [docs/collaboration/](docs/collaboration/) |
| Owner Channel | [docs/owner-channel/](docs/owner-channel/) |
| Environment | [docs/env-reference/](docs/env-reference/) |

## License

[MIT](LICENSE)
