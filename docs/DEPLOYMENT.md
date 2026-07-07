# Deployment: Proof of Alibaba Cloud

Orvix's backend runs live on an Alibaba Cloud ECS instance, calling Qwen through Alibaba Cloud
Model Studio. This document is the submission-facing proof: what's actually running where, how
the CLI and API connect to it, and exactly which lines of code call Alibaba Cloud's services.

**Demo video:** https://youtu.be/CaVT8MNpp8E

## What's actually running on Alibaba Cloud

| Piece | Where it runs |
| --- | --- |
| Orvix API (`apps/api`) — planning, scheduling, agent runtime, review, acceptance gates | Docker container on an Alibaba Cloud ECS instance |
| Qwen model calls | Alibaba Cloud Model Studio (DashScope), via its OpenAI-compatible endpoint |
| Mission state | Persisted to disk on the same ECS instance (`.orvix/runs/<missionId>/`) |
| Orvix CLI (`apps/cli`) | Runs wherever the user is — a laptop, a different machine — and talks to the ECS instance only over HTTP/SSE |

The CLI never calls Qwen directly and never touches git. Every mutation goes through the API
running on Alibaba Cloud, which is what makes the CLI a pure thin client of a cloud-hosted
backend rather than a local process with an API key.

## Live proof

```bash
curl http://<ecs-public-ip>:8787/health
```

```json
{
  "service": "orvix-api",
  "status": "ok",
  "provider": "Alibaba Cloud ready",
  "runtime": "Node.js",
  "qwen": "configured",
  "qwenBaseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "qwenModel": "qwen-plus"
}
```

`provider: "Alibaba Cloud ready"` and a `qwenBaseUrl` pointing at Alibaba Cloud Model Studio's
DashScope endpoint together confirm both halves of the requirement: the compute is Alibaba
Cloud, and the model calls are Alibaba Cloud Model Studio (Qwen Cloud) — not a local process,
not a different provider.

## Where this is in the code

### 1. The API calls Alibaba Cloud Model Studio directly

[`packages/qwen/src/client.ts`](https://github.com/abbasmir12/orvix/blob/main/packages/qwen/src/client.ts#L487-L505) —
`createQwenConfig()` defaults `baseUrl` to Alibaba Cloud Model Studio's OpenAI-compatible
endpoint:

```ts
baseUrl: env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
```

Every planning, agent, review, acceptance, and owner-triage call in Orvix goes through this
client's `chatDetailed`, which issues the actual HTTP request against that endpoint (see the
`fetch` call around
[line 751](https://github.com/abbasmir12/orvix/blob/main/packages/qwen/src/client.ts#L751)).

### 2. The health check reports the live Alibaba Cloud state

[`apps/api/src/server.ts`](https://github.com/abbasmir12/orvix/blob/main/apps/api/src/server.ts#L92) —
the `/health` route literally returns `"provider": "Alibaba Cloud ready"` and echoes the active
`qwenBaseUrl`/`qwenModel`, so anyone can verify the deployment target without reading source —
just `curl` the running instance.

### 3. The Docker image deployed to the ECS instance

[`apps/api/Dockerfile`](https://github.com/abbasmir12/orvix/blob/main/apps/api/Dockerfile) —
the exact multi-stage build running in the container on the ECS instance: compiles all
workspaces, then ships only `@orvix/api`'s runtime dependencies plus the compiled
`core`/`qwen`/`workspace` packages, with `git` installed since agent sessions run real
`git worktree`/`npm install`/`npm run build` commands against mission workspaces.

### 4. Environment configuration tying the deployment to Alibaba Cloud

[`.env.example`](https://github.com/abbasmir12/orvix/blob/main/.env.example) — `QWEN_BASE_URL`
and `DASHSCOPE_API_KEY` are the two variables that point the deployed API at Alibaba Cloud
Model Studio. Full reference: [`env-reference/`](env-reference/).

## How the CLI connects to the Alibaba Cloud instance

This is the part that's easy to miss reading the code cold, so it's worth tracing end to end.

1. **First run:** the CLI's SetupWizard (`apps/cli/src/components/SetupWizard.tsx`) offers
   three runtime choices — Demo (no network), Local (`http://localhost:8787`), or Alibaba
   Cloud (a public URL you paste in, e.g. `http://<ecs-ip>:8787`).
2. **Verification before anything else happens:** choosing Alibaba Cloud calls
   `GET /health` on that URL, then `GET /runtime/check` with
   `Authorization: Bearer <ORVIX_API_TOKEN>` if a token was supplied. A bad token, a closed
   ECS security-group port, or an unreachable host is caught right here with a specific error
   — not a silent hang — before the wizard lets you launch a mission.
3. **Every mission action after that** — `POST /missions`, `GET /missions/:id`, posting an
   owner instruction, resuming a mission — is a plain HTTP or SSE request from the CLI process
   to that same Alibaba Cloud URL. The CLI holds no Qwen credentials and no git state of its
   own; the ECS instance holds all of it.
4. **The connection is remembered.** Once a connection verifies successfully, the CLI saves the
   URL (and token, file mode `0600`) to `~/.orvix/cli.json` on the machine running the CLI, so
   the next launch offers to reconnect to the same Alibaba Cloud instance automatically.

Full walkthrough of provisioning the ECS instance itself, security groups, and
`ORVIX_API_TOKEN`: [`SETUP.md` §6](SETUP.md#6-deploy-the-api-to-alibaba-cloud-ecs).

## Related docs

[`SETUP.md`](SETUP.md) (provisioning + connecting) · [`architecture/`](architecture/)
(system shape) · [`env-reference/`](env-reference/) (every Alibaba Cloud / Qwen variable) ·
[`collaboration/`](collaboration/) and [`owner-channel/`](owner-channel/) (real incidents
found and fixed on missions run against this live deployment)
