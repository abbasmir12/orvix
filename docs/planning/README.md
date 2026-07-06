# Planning Pipeline

Planning is what turns free-text mission input into the Orvix Map and an org chart, before any
agent writes a line of code. It runs entirely in the background after `POST /missions` returns
(well under a second), and streams every stage's outcome over SSE — so a planning failure is
visible immediately, not discovered when execution mysteriously has no agents.

Implementation: `apps/api/src/planning.ts` (`bootstrapQwenReasoning` is the entry point,
`recordPlanningStage` is what the CLI's planning rail renders live).

## The seven stages

| # | Stage | What happens |
| --- | --- | --- |
| 1 | `research` | Optional web research (`research_web`/`fetch_url` tools, `research.ts`) to ground the plan in real information about the domain, if the mission implies external facts (an API's shape, a framework's conventions). |
| 2 | `council` | A planning council pass drafts an initial read on the mission — problem framing, before the formal analysis. |
| 3 | `scaffold` | Chooses the initial project scaffold type (`chooseInitialScaffold`) — Next.js App Router, Express API, Node CLI, etc. — which determines what `packages/workspace`'s scaffolder generates and which acceptance-gate commands apply later. |
| 4 | `analysis` | MasterMind's mission analysis: project type, core features, risks — the deterministic frame the Orvix Map is drafted against. |
| 5 | `orvix_map` | Draft → review → lock. See [`orvix-map/`](../orvix-map/) for the full structure and lifecycle. |
| 6 | `organization` | Strategy Weaver designs the org chart *against the locked map* — up to 20 named specialists, each mapped to one or more `agentWorkPackets`. |
| 7 | `rubric` | Critic Council's review rubric is derived from the same map, so review criteria and build criteria never drift apart. |

Each stage recorded via `recordPlanningStage(run, stage, "started" | "completed" | "degraded" |
"failed", detail?, durationMs?)`. `degraded` means the stage produced a fallback result instead
of failing outright (e.g. an emergency map gets locked with reduced scope rather than blocking
the mission forever) — this is intentionally visible in the CLI rail rather than silently
absorbed, consistent with the "no hidden deterministic fallback" principle in
[`architecture/`](../architecture/).

## Solo mode

`mode: "solo"` skips stage 6 (no org design) — one generalist agent gets the entire locked map
and works through it sequentially with a much larger turn/tool-call budget
(`QWEN_SOLO_AGENT_MAX_TURNS`/`QWEN_SOLO_AGENT_MAX_TOOL_CALLS`, see
[`env-reference/`](../env-reference/)). Everything downstream — review, build gates, runtime
acceptance — runs identically to `qwen` mode; only the org shape differs. This is what makes a
solo-vs-society comparison apples-to-apples rather than two different pipelines.

## What happens after planning

Once the map is locked and the org is designed, the scheduler (`runMissionPool` in
`scheduler.ts`) takes over — agent sessions, reviews, revisions, and the build/acceptance gates
all run as a continuous work pool, not a second static plan. See
[`architecture/`](../architecture/#how-a-mission-runs) for that half of the lifecycle, and
[`collaboration/`](../collaboration/) for how agents negotiate once they're actually working.

## Related docs

[`orvix-map/`](../orvix-map/) · [`collaboration/`](../collaboration/) ·
[`architecture/`](../architecture/)
