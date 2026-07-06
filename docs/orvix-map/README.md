# The Orvix Map

The Orvix Map is the single build contract every agent, reviewer, and acceptance gate reads
from. It exists so that a 12-agent mission doesn't rediscover "what are we building" 12
different ways — everyone is implementing against the same locked document.

## Where it comes from

The Orvix Map is drafted, reviewed, and locked during **planning**, before a single agent
session starts (see [`planning/`](../planning/) for the full pipeline). Concretely:

1. MasterMind analyzes the mission (project type, core features, risks).
2. A Qwen call drafts the map (`draftOrvixMapJson` in `packages/qwen/src/client.ts`) — for
   larger missions a compact variant (`draftCompactOrvixMapJson`) keeps it small enough for
   every agent prompt to carry it in full.
3. A second Qwen call reviews it (`reviewOrvixMapJson`) and can request a revision
   (`reviseOrvixMap`) before it's marked `status: "locked"`.
4. Strategy Weaver designs the org chart *against the locked map* — so the number and shape
   of specialist agents follows from the map's actual `agentWorkPackets`, not the other way
   around.

Once locked, the map does not change mid-mission except through an explicit owner-driven
re-plan. Agents build against a fixed target; the acceptance gate judges against the same
fixed target.

## What's in it

```ts
type OrvixMap = {
  version: string;
  status: "draft" | "locked";
  mission: string;
  productType: string;
  mapSummary: string;
  surfaces: OrvixMapSurface[];        // pages/routes/screens/endpoints/commands — see below
  systems: Array<{ id, name, purpose, fileHints?, contracts? }>;
  designSystem?: { theme?, colors?, typography?, motion?, layoutRules? };
  dataContracts?: Array<{ id, name, fields?, rules? }>;
  interactionContracts?: Array<{ id, trigger, response, ownerHint? }>;
  agentWorkPackets: Array<{
    id: string;
    suggestedAgentRole: string;
    owns: string[];                   // surface/system ids this packet is responsible for
    mustCreateOrUpdate?: string[];    // concrete file paths
    acceptance: string[];             // checks specific to this packet
    coordinationNotes?: string[];
  }>;
  acceptanceGates: string[];           // mission-wide checks, independent of any one packet
  forbiddenOutputs: string[];
  openQuestions?: string[];
};
```

`surfaces` is deliberately generic across product types: for a GUI it's pages/routes/screens,
each with nested `sections` → `components` → `elements` (down to a `testId` and a
`contentRule`/`behavior` per element); for an API it's endpoints and schemas; for a CLI it's
commands and terminal output; for a library it's public modules/functions; for a data/ML
pipeline it's stages and outputs. The prompt (`draftOrvixMap` in `client.ts`) explicitly
adapts what "surface" means to the detected `productType`.

## How agents use it

Each agent's task carries a reference into the map, resolved at runtime by
`mapWorkPacketForAgent` (`apps/api/src/run.ts`) — a **scored match**, not first-match: it
scores every packet against the agent's id/name/role and the task's title/branch, weighting
distinctive tokens (packet id, `owns` entries, file basenames) over generic role words like
"component" or "specialist". The matched packet's
`mustCreateOrUpdate` list is also what backs the **file-ownership guard**
(`fileOwnershipConflict` in `agentRuntime.ts`) — see [`collaboration/`](../collaboration/).

## How the reviewer uses it

Critic Council reviews a PR's diff and the full current content of its changed files (see
[`architecture/`](../architecture/)) **against this packet's `acceptance` list and the
mission-wide `acceptanceGates`** — not against a generic "is this good code" standard. That's
what keeps review feedback concrete and actionable instead of open-ended nitpicking.

## How the acceptance gate uses it

`runRuntimeAcceptanceGate` (`apps/api/src/acceptance.ts`) builds the project for real and
smoke-tests the routes/surfaces the map declared exist — it isn't guessing what pages should
be reachable, it's checking the map's own `surfaces` list. The Qwen acceptance judge is given
the same map as its rubric for "does the shipped product satisfy the mission."

## Related docs

[`planning/`](../planning/) · [`collaboration/`](../collaboration/) ·
[`orvix-book/`](../orvix-book/) · [`architecture/`](../architecture/)
