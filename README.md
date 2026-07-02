# Orvix

Orvix is a CLI prototype for an autonomous AI engineering organization. It analyzes a user mission, creates a dynamic agent organization, creates a mission workspace repo, simulates branch-style task execution, runs a PR review cycle, resolves a dependency conflict, and emits a final CEO delivery report.

The current build includes a local mock engine, a deployable Node.js API backend, a Qwen Cloud adapter, persistent run artifacts, and a sandboxed workspace layer. Real Git branches and real PR creation are still intentionally deferred.

## Run

Install dependencies:

```bash
npm install
```

Run a mission:

```bash
npm run dev -- mission "Build a SaaS CRM with auth, dashboard, contacts and notes"
```

Or run interactively:

```bash
npm run dev -- mission
```

Build the CLI:

```bash
npm run build
```

Run the compiled command:

```bash
node apps/cli/dist/index.js mission "Build a mobile app with auth and payments"
```

## API Backend

Start the backend:

```bash
npm run build
npm run start:api
```

Health check:

```bash
curl http://localhost:8787/health
```

Create a mission:

```bash
curl -X POST http://localhost:8787/missions \
  -H "Content-Type: application/json" \
  -d '{"mission":"Build a SaaS CRM with auth, dashboard, contacts and notes","mode":"qwen"}'
```

Inspect Qwen-generated reasoning artifacts:

```bash
curl http://localhost:8787/missions/<mission_id>/reasoning
```

Inspect the mission workspace repo:

```bash
curl http://localhost:8787/missions/<mission_id>/workspace
```

Inspect the Orvix Book and an agent-specific filtered view:

```bash
curl http://localhost:8787/missions/<mission_id>/book

curl "http://localhost:8787/missions/<mission_id>/book?agentId=auth-agent"
```

Post an Orvix Book entry:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/book \
  -H "Content-Type: application/json" \
  -d '{"type":"question","fromAgentId":"auth-agent","toAgentIds":["database-agent"],"message":"What user ID type should auth use?","topics":["users","sessions"],"priority":"high"}'
```

Run controlled Git tools inside the mission workspace:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/workspace/git \
  -H "Content-Type: application/json" \
  -d '{"tool":"create_branch","branch":"feat/auth"}'

curl -X POST http://localhost:8787/missions/<mission_id>/workspace/git \
  -H "Content-Type: application/json" \
  -d '{"tool":"git_status"}'
```

Execute real agent work through Orvix tools:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/execute-next

curl -X POST http://localhost:8787/missions/<mission_id>/agents/<agent_id>/execute
```

Review and merge PR-style work:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/review-next

curl -X POST http://localhost:8787/missions/<mission_id>/prs/<pr_id>/review
```

Run the scheduler:

```bash
curl -X POST http://localhost:8787/missions/<mission_id>/scheduler/tick

curl -X POST http://localhost:8787/missions/<mission_id>/autopilot \
  -H "Content-Type: application/json" \
  -d '{"cycles":30}'
```

Run the CLI against the backend:

```bash
node apps/cli/dist/index.js mission "Build a SaaS CRM with auth, dashboard, contacts and notes" \
  --mode cloud \
  --api-url http://localhost:8787
```

In cloud mode, the cockpit can trigger real workspace execution:

- `x` executes the next unblocked task.
- `r` executes the selected agent's next unexecuted task.
- `v` reviews the next PR and merges it if approved.
- `a` runs the autopilot scheduler for multiple turns.
- `5` opens the Orvix Book tab.

## Qwen Cloud Configuration

Copy `.env.example` and configure:

```bash
DASHSCOPE_API_KEY=sk-...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
```

`packages/qwen` uses Alibaba Cloud Model Studio's OpenAI-compatible `/chat/completions` API shape. In Qwen mode, the backend currently generates four Qwen reasoning artifacts before the live simulation continues:

- mission analysis
- organization design
- PR review rubric
- final report draft

## Agent Runtime Direction

Qwen can be used in two ways:

- OpenAI-compatible Model Studio calls from the Node.js backend.
- The Python-first `Qwen-Agent` framework for agents, tools, MCP, and code interpreter style workflows.

Orvix currently uses the OpenAI-compatible route so the Node API can own scheduling, tool allowlists, workspace boundaries, event logs, and UI streaming. This keeps agent execution auditable and prevents individual agents from receiving arbitrary shell access.

Each mission now receives two separate storage areas:

- `.orvix/runs/<mission_id>/` stores orchestration evidence, state snapshots, event logs, and Qwen reasoning artifacts.
- `.orvix/workspaces/<mission_id>/repo/` is the target repo where future agents will create or modify project files through controlled tools.

The first workspace tools are implemented in `@orvix/workspace`:

- `list_files`
- `read_file`
- `write_file`
- `init_repo`
- `git_status`
- `create_branch`
- `checkout_branch`
- `commit_changes`
- `get_diff`

All workspace paths are resolved inside the mission repo and path escapes are rejected. Git is also owned by Orvix: agents request branch, commit, and diff operations as tool calls; Orvix performs them and logs the result.

The Orvix Book is the shared mission ledger. Agents receive a filtered view of it every turn, plus unread signals and the ownership index. They can post questions, assumptions, notes, contracts, decisions, and review notes without blocking their current work. Orvix routes mentions and topic updates into agent signals.

Agent execution is now partially real. Qwen mode can ask a specialist agent for a constrained JSON execution plan, then Orvix validates the tool names, executes allowed workspace/Git tools, updates task/PR state, and saves an `agent_execution` artifact. Review is also partially real: the reviewer inspects the branch diff, approves or requests changes, saves a `pr_review` artifact, and approved work is merged back into `main`. Mock mode uses deterministic execution and review decisions for local development.

## Alibaba Cloud Deployment

The backend can be containerized for Alibaba Cloud ECS:

```bash
docker build -f apps/api/Dockerfile -t orvix-api .
docker run -p 8787:8787 --env-file .env orvix-api
```

For the hackathon deployment proof video, show:

- ECS instance or container runtime on Alibaba Cloud
- `orvix-api` container running
- public `/health` endpoint returning `provider: "Alibaba Cloud ready"`
- CLI running with `--mode cloud --api-url <public-api-url>`

## Structure

```text
apps/api/
  src/
    index.ts
apps/cli/
  src/
    index.tsx
    App.tsx
    components/
    lib/
packages/core/
  src/
    missionAnalyzer.ts
    mockSimulation.ts
    types.ts
packages/qwen/
  src/
    client.ts
packages/workspace/
  src/
    index.ts
```

The Ink UI consumes `SimulationState` from `@orvix/core`. The API uses the same core engine and streams updates to the CLI over Server-Sent Events.
