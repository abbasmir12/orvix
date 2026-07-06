# Agent Collaboration & Negotiation

Agents in a mission are never coordinated by a central planner re-assigning work turn by turn —
they negotiate through the Orvix Book and a small number of deterministic guardrails. This doc
walks through the actual mechanics: what happens when an agent needs something from another
agent, when two agents want the same file, and when a merge breaks someone else's branch.

## Declared dependencies and speculative work

Every task carries `dependsOnAgentIds` — set during org design when Strategy Weaver decides,
for example, that the UI layer depends on the data layer's contract. When an agent starts a
task and a dependency hasn't landed yet (`isAgentDependencySatisfied` returns false),
`postSpeculativeDependencyNotes` (`apps/api/src/agentRuntime.ts`) posts two things to the Book
in one shot:

- a `question` to the dependency's owner(s), asking them to publish their interface contract
  or constraints, and
- a note that the current agent is proceeding **speculatively**, with explicit assumptions,
  rather than sitting idle.

This is a deliberate choice: idle-waiting for a dependency doesn't parallelize anything. An
agent building a UI component against an assumed API shape, then reconciling once the real
`api.ts` lands, is usually faster than a strict dependency chain — and it's exactly what a
real engineering team does when a dependency is running behind.

## File ownership: who gets to write what

Every agent's task resolves to one `agentWorkPacket` in the locked Orvix Map (via the scored
matcher, see [`orvix-map/`](../orvix-map/)), and that packet's `mustCreateOrUpdate` list is
the agent's declared "turf." `fileOwnershipConflict` (`agentRuntime.ts`) checks every
`write_file`/`delete_file` call against it, with two escape hatches that matter more than the
rule itself:

1. **Agent-named-file safety valve.** If a file's base name is transparently the agent's own
   (`WeatherCard.tsx` for an agent named "WeatherCard Builder"), it's treated as owned
   regardless of what the packet matcher concluded — a mis-scored packet must never lock an
   agent out of the component it was obviously hired to build.
2. **`mainNeedsFixes` bypass.** While the incremental build gate has flagged `main` as broken,
   ownership enforcement is suspended entirely. A build-break fix routinely has to touch a file
   outside the fixing agent's normal turf (an integration point, a shared config); enforcing
   turf rules during a fire would deadlock the fix against the rule meant to prevent chaos.

## Reconciling with a moving `main`

When a PR merges, `syncOpenBranchesAfterMerge` (`review.ts`) decides which other open branches
need to catch up — not all of them (that used to cascade into N-1 extra merges per landing).
A branch is synced only if its task explicitly depends on the merged agent, or its own diff
touches a file the merge changed. If the sync applies cleanly, the owner gets a `contract`
entry telling them main moved and why. If it doesn't — a real conflict — MasterMind posts a
`conflict` entry and leaves the conflict markers in place for the owning agent to resolve
itself (`beginOwnerConflictedSync` in `packages/workspace/src/index.ts`): Orvix never silently
picks a side of a merge conflict (no `-X theirs`), because that can quietly discard one agent's
real work.

## Disagreement with the reviewer: revision cycles

A PR that gets `request_changes` isn't a dead end — it's requeued as a **revision** session,
carrying the reviewer's comments as context, and the scheduler runs revisions as their own
concurrent job kind alongside fresh executions (see [`architecture/`](../architecture/)). Two
guardrails stop this from looping forever:

- **`reviewAttemptLimit`** (50) escalates a PR that's been reviewed that many times without
  resolution, rather than cycling indefinitely.
- **Supersede logic** (`trySupersedeEmptyDiffPr`): if a branch's diff against `main` is empty
  and it's already been reviewed at least once, MasterMind approves it as superseded — the
  work already landed by some other path (a merge, a sync), so there's nothing left to review.
  This is explicitly blocked while `main` needs fixes, or when the PR carries an
  "Owner request" comment, so a real pending owner change is never silently waved through.

The reviewer now receives full branch file contents, not just the diff, so a file that is
already correct on `main` does not get misread as missing because its diff is small.

## Never silently stuck: the wake-up pass

If none of the above resolves a task — the agent's session produced nothing usable, or
reviewer feedback demanded something unfulfillable — the task lands `blocked`. MasterMind's
wake-up pass (in `runMissionPool`, `scheduler.ts`) runs **every scheduling round**, re-queues
any blocked task up to `QWEN_BLOCKED_WAKE_LIMIT` times with an explicit Book message naming the
blocker, and only accepts "blocked" for good once that budget is spent. This is what stops one
agent's slow revision cycle from starving a completely unrelated blocked agent forever.

## Related docs

[`orvix-map/`](../orvix-map/) · [`orvix-book/`](../orvix-book/) ·
[`owner-channel/`](../owner-channel/) · [`architecture/`](../architecture/)
