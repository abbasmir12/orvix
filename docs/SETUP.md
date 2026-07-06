# Setup Guide

Two runtimes to set up: the **Orvix API** (plans, runs, reviews missions) and the **Orvix
CLI** (the cockpit you watch it from). You can run both on one laptop for local development,
or run the API on an Alibaba Cloud ECS instance and point the CLI at it from anywhere — that
second shape is what the hackathon submission requires proof of.

## 1. Prerequisites

- Node.js 20+ and npm
- git
- An Alibaba Cloud Model Studio (DashScope) API key — [console.aliyun.com](https://common-buy.aliyun.com/) → Model Studio → API Keys

## 2. Fetch the repo

```bash
git clone <this-repo-url> orvix
cd orvix
```

## 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```bash
DASHSCOPE_API_KEY=sk-...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus
```

`QWEN_MODEL` (and every `QWEN_*_MODEL` override) accepts a single model or a comma-separated
fallback chain — see [`env-reference/`](env-reference/) for the full list of tunables
(timeouts, concurrency, per-role model overrides, agent turn budgets).

Leave `ORVIX_API_TOKEN` empty for local development. Set it before exposing the API on the
public internet (Alibaba Cloud deployment, step 6).

## 4. Install and build

```bash
npm install
npm run build
```

This builds all five workspaces in dependency order: `@orvix/core` → `@orvix/qwen` →
`@orvix/workspace` → `@orvix/api` → `@orvix/cli`.

## 5. Run locally

Start the API:

```bash
npm run start:api
# orvix-api auth disabled: set ORVIX_API_TOKEN before exposing this API publicly.
# listening on :8787
```

Check it's alive:

```bash
curl http://localhost:8787/health
```

Launch the CLI in a second terminal:

```bash
npm run dev
```

With no arguments the CLI opens the **SetupWizard** — pick "Local runtime" (defaults to
`http://localhost:8787`, no token) or "Demo cockpit" (scripted UI walkthrough, no API key or
running server needed). It verifies `/health` and `/runtime/check` before handing you the
mission launcher.

You can also skip the wizard and go straight to a mission:

```bash
node apps/cli/dist/index.js mission "Build a 2D snake game in the browser with score and game over" \
  --mode cloud --api-url http://localhost:8787
```

Or drive the API directly without the CLI at all:

```bash
curl -X POST http://localhost:8787/missions \
  -H "Content-Type: application/json" \
  -d '{"mission":"Build a SaaS CRM with auth, dashboard, contacts and notes","mode":"qwen"}'

curl http://localhost:8787/missions/<mission_id>          # full state + planning stages
curl http://localhost:8787/missions/<mission_id>/metrics  # live Qwen usage + progress
curl http://localhost:8787/missions/<mission_id>/book     # Orvix Book ledger
```

`POST /missions` returns in well under a second — planning runs in the background and streams
`planning` stage events over SSE (`GET /missions/<mission_id>/events`), so nothing blocks and
nothing hides a failure.

## 6. Deploy the API to Alibaba Cloud (ECS)

This is the shape the hackathon submission asks you to prove: the Orvix **API** runs on an
Alibaba Cloud compute instance; the CLI (wherever you run it — laptop, another machine) is
just a client of it over the public internet.

### 6.1 Provision an ECS instance

1. Alibaba Cloud console → **ECS** → Create Instance.
2. Any x86_64 instance with 2 vCPU / 4 GB RAM is enough for a demo mission (agent sessions are
   mostly network-bound, waiting on Qwen calls, not CPU-bound).
3. Choose a Linux image where you can install Node.js 20+ and git.
4. **Security group**: open the port you'll run the API on (default `8787`) to the IP ranges
   that need to reach it — your own IP for testing, `0.0.0.0/0` only if you intend the demo to
   be reachable by judges directly. Prefer putting it behind a reverse proxy on 80/443 if you
   want a clean public URL (see 6.4).

### 6.2 Get the code and secrets onto the instance

```bash
ssh <user>@<ecs-public-ip>
git clone <this-repo-url> orvix
cd orvix
cp .env.example .env
```

Edit `.env` on the instance:

```bash
DASHSCOPE_API_KEY=sk-...
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-plus

# Required once this is reachable from outside localhost.
ORVIX_API_TOKEN=<generate a long random string>
```

Generate a token if you don't already have one:

```bash
openssl rand -hex 32
```

**Never commit `.env` or paste the live token into a chat/PR** — `.env` is already gitignored.

### 6.3 Install, build, and run the API

```bash
npm install
npm run build
npm run start:api
```

For a long-running demo, run the API inside `tmux`, `screen`, `pm2`, or a systemd service so
it keeps running after you disconnect from SSH.

Verify it's up:

```bash
curl http://<ecs-public-ip>:8787/health
# {"service":"orvix-api","status":"ok","provider":"Alibaba Cloud ready","qwen":"configured",...}
```

`provider: "Alibaba Cloud ready"` and `qwen: "configured"` in that response is the deployment
proof the submission asks for — screen-record or link straight to this endpoint.

### 6.4 (Optional) put it behind a domain / TLS

If you want `https://api.yourdomain.com` instead of `http://<ip>:8787`, put nginx or Alibaba
Cloud's own SLB/ALB in front of the Node API and forward to port 8787. The CLI and `curl`
examples below work identically against either URL — only the `--api-url` value changes.

### 6.5 Point the CLI at the deployed API

From your laptop (or anywhere with network access to the instance):

```bash
node apps/cli/dist/index.js
```

In the SetupWizard, choose **"Alibaba Cloud runtime"**, paste the public API URL
(`http://<ecs-public-ip>:8787` or your domain) and the `ORVIX_API_TOKEN` you set in step 6.2.
The wizard calls `/health` and `/runtime/check` with `Authorization: Bearer <token>` before
letting you launch a mission — a bad token or unreachable API surfaces immediately with a
specific error (auth failure vs. network failure vs. security-group block), not a silent hang.

Or skip the wizard:

```bash
node apps/cli/dist/index.js mission "Build a weather dashboard" \
  --mode cloud \
  --api-url http://<ecs-public-ip>:8787 \
  --api-token <your ORVIX_API_TOKEN>
```

Or with environment variables instead of flags:

```bash
export ORVIX_API_URL=http://<ecs-public-ip>:8787
export ORVIX_API_TOKEN=<your token>
node apps/cli/dist/index.js
```

## 7. Resuming a mission after a restart

Missions are never lost when the API process restarts — every mutation is written to
`.orvix/runs/<missionId>/` as it happens. After pulling changes or restarting the API:

```bash
curl http://<api-url>/missions/disk        # list every mission snapshot on disk
node apps/cli/dist/index.js --resume <missionId> --api-url <api-url> --api-token <token>
```

The CLI replays the mission's turn/event/reasoning history into the cockpit before
reconnecting to the live SSE stream, so you land exactly where the mission left off.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| SetupWizard: "Cannot reach `<url>`" | API not running, wrong port, or ECS security group blocks it | Confirm `curl <url>/health` works from your machine; open the port in the security group |
| SetupWizard: "Runtime requires a valid ORVIX_API_TOKEN" | `/runtime/check` needs auth but no/wrong token was supplied | Match the CLI's `--api-token` to the API's `ORVIX_API_TOKEN` exactly |
| Mission stuck at 0% / no planning events | Missing or invalid `DASHSCOPE_API_KEY` | Check `/health` returns `qwen: "configured"`; check API logs for a 401 from DashScope |
| Build gate keeps failing with "Cannot find module" for a dependency that *is* in `package.json` | Rare install/build race — fixed in the gate itself (retries once, serialized per repo) | Update to latest; if it recurs, check API logs for the retry line and file an issue |
