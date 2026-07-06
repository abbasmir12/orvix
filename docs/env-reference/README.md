# Environment Variable Reference

All variables live in `.env` (see `.env.example` for a ready-to-copy starting point). Only
`DASHSCOPE_API_KEY` is required to run in `qwen` mode; everything else has a sensible default.

## Qwen Cloud connection

| Variable | Default | Meaning |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | — | Alibaba Cloud Model Studio API key. Required for `qwen`/`solo` modes. |
| `QWEN_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | DashScope's OpenAI-compatible endpoint. |
| `QWEN_MODEL` | `qwen-plus` | Model id, or a comma-separated fallback chain (see below). |
| `QWEN_PLANNER_MODEL` / `QWEN_AGENT_MODEL` / `QWEN_REVIEW_MODEL` | falls back to `QWEN_MODEL` | Per-role model override; each also accepts a fallback chain. |

**Model fallback chains.** Any `QWEN_*_MODEL` variable accepts either a single model or a
comma-separated list, e.g. `QWEN_MODEL=qwen3.7-max,qwen3.7-plus,qwen3.6-max`. Each model has
its own free-tier quota; when the active model's quota is exhausted mid-mission, the client
detects the quota error and switches to the next model in the chain for all subsequent calls —
no dropped mission, no manual restart. `QWEN_MODEL_BENCH_MS` (default `300000`) controls how
long an exhausted model is skipped before Orvix tries it again. `QWEN_SPREAD_AGENTS` (default
`true`) staggers which chain position each parallel agent starts from, so they don't all retry
the same model at once.

## Timeouts

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN_TIMEOUT_MS` | `240000` | Default per-request timeout. |
| `QWEN_ORVIX_MAP_TIMEOUT_MS` | `120000` | Timeout for drafting the Orvix Map. |
| `QWEN_COMPACT_MAP_TIMEOUT_MS` | `60000` | Timeout for compacting the map for agent prompts. |
| `QWEN_MAP_REVIEW_TIMEOUT_MS` | `60000` | Timeout for the map review rubric step. |
| `QWEN_AGENT_TURN_TIMEOUT_MS` | `120000` | Per-turn timeout inside an agent's multi-turn session. |

## Scheduler concurrency

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN_EXECUTION_CONCURRENCY` | `4` | Max agent execution sessions running at once. |
| `QWEN_REVISION_CONCURRENCY` | `3` | Max revision sessions running at once. |
| `QWEN_REVIEW_CONCURRENCY` | `2` | Max PR reviews running at once. |
| `QWEN_POOL_CONCURRENCY` | `6` | Total jobs (revision + signal + review + execution + build) the work-pool scheduler runs at once. |
| `QWEN_BLOCKED_WAKE_LIMIT` | `2` | How many fresh sessions MasterMind gives a blocked task, via the wake-up pass, before accepting it as blocked for good. |
| `QWEN_MAX_CONCURRENT_REQUESTS` | `6` | Global semaphore across all Qwen calls, independent of job kind. |

## Agent sessions

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN_AGENT_MAX_TURNS` | `10` | Max turns in a specialist agent's session (society mode). |
| `QWEN_SOLO_AGENT_MAX_TURNS` | `40` | Max turns for the single generalist agent in `solo` mode — it owns the whole mission alone, so it needs a much larger budget. |
| `QWEN_SOLO_AGENT_MAX_TOOL_CALLS` | `150` | Max tool calls in `solo` mode. |
| `QWEN_ENABLE_THINKING` | `false` | Enable extended-thinking mode on models that support it. |
| `QWEN_THINKING_BUDGET` | — | Thinking token budget, if enabled. |
| `QWEN_CONTEXT_WINDOW_TOKENS` | `32768` | Fallback context window, used only when the provider's `/models` metadata doesn't report a context length for the active model. |
| `QWEN_COMPACT_AT_PERCENT` | `80` | Compact session history once it crosses this percent of the model's context window. |

## Orvix runtime API

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port the API listens on. |
| `ORVIX_API_TOKEN` | — | If set, every route except `GET /health` requires `Authorization: Bearer <token>`. Leave empty for local development; **set it before exposing the API publicly** (see `SETUP.md` §6). |
| `ORVIX_API_URL` | `http://localhost:8787` | CLI default when no `--api-url` flag is given. |

## Orvix CLI

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORVIX_SKIP_ONBOARDING` | — | Skip the first-run SetupWizard (useful for scripted demos/recordings). |
| `ORVIX_MOUSE_TRACK` | `true` | Set to `false` to disable mouse-tracking escape codes — recommended over a slow/high-latency SSH connection, where mouse events flood the link and cause visible lag. Also configurable persistently via `~/.orvix/cli.json` → `{"mouseTrack": false}`; the env var wins if both are set. |

## Which of these actually matter for the hackathon submission

For a straightforward demo you only need to touch three: `DASHSCOPE_API_KEY`, `QWEN_MODEL`
(pick a chain if you're worried about quota), and `ORVIX_API_TOKEN` once the API leaves
`localhost`. Everything else is tuned for throughput and can be left at its default.
