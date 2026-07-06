# The Owner Channel

The owner channel is how a human steers a mission that's already running, or gives follow-up
instructions after it's already complete — "switch to a dark theme," "add CSV export," "why
did you choose Tailwind?" — without the human ever touching git, the Orvix Map, or an agent
directly. This doc traces one instruction all the way from the CLI keystroke to a working
scheduler pass picking it up, since that hand-off is the part that isn't obvious from the API
surface alone.

## Sending an instruction

From the CLI, press `@` (or `/` then type) in the prompt bar — see [`cli/`](../cli/). Typing
`@` opens a mention picker over the current agent roster; arrow keys highlight, `Tab`/`Enter`
inserts `@agent-id`. Anything that isn't a `/command` is sent as plain text to:

```
POST /missions/:id/owner   { "message": "...", "toAgentIds": ["<agent-id>", ...] }
```

`toAgentIds` comes from parsing `@mentions` out of the text client-side; it's optional — an
unaddressed instruction is legal and is in fact the more common case ("just fix the thing").

## Step 1: deterministic routing (`routeOwnerInstruction`)

This runs synchronously, before the HTTP response is sent, in `apps/api/src/review.ts`:

1. Posts a Book entry from `fromAgentId: "owner"` — a `question` if the message ends in `?`,
   otherwise a `decision`. **MasterMind is always in `toAgentIds`**, whether or not the human
   named anyone else, so it's always aware an owner instruction happened even if it never has
   to act on it directly.
2. If the message directly `@mentions` one or more agents and isn't a question, their
   in-flight PR is reopened right there: status flips to `"Changes requested"`, the message is
   appended to the PR's comments as `"Owner request: <message>"`, and if the mission had
   already completed, `isComplete` flips back to `false` and the phase returns to
   `"executing"`.
3. Returns which agents got a direct mention and which PRs got reopened.

This is the fast path — a directly-addressed instruction doesn't need an LLM call to route it.

## Step 2: MasterMind triage, only when routing needs judgment

The server route (`apps/api/src/server.ts`) decides, *after* responding to the HTTP request,
whether the deterministic step was enough:

```ts
if (!isQuestion && result.mentioned.length === 0) {
  await masterMindOwnerTriage(run, message);
}
if (!run.autopilotActive && run.workspace) {
  void runAutopilot(run, 300, "automatic");
}
```

An unaddressed, non-question instruction ("add dark mode") is exactly the case that needs
judgment: which existing agent, if any, should own this? `masterMindOwnerTriage`
(`review.ts`) sends the mission, the current roster, tasks, PRs, and the locked Orvix Map to a
Qwen call (`routeOwnerRequestJson`) and gets back:

```ts
{
  summary: string;
  assignments: Array<{ agentId: string; instruction: string }>;
  newAgents?: Array<{ name: string; role: string; instruction: string; files?: string[] }>;
}
```

For each valid assignment, MasterMind posts a `contract` entry addressed to that agent
(`"MasterMind routing the owner's request to you: <instruction>"`) and reopens their PR the
same way step 1 would have. **If no existing agent fits, MasterMind hires one** —
`hireAgentForOwnerRequest` creates a new agent (slugified name, `status: "queued"`) and a new
task (with a branch, `acceptanceCriteria` seeded from the instruction, and an empty
`dependsOnAgentIds`), posts it a welcome `contract` entry, and republishes `AGENTS.md`
(`publishAgentsMd`) so the new agent is visible to every other agent's context immediately —
not just added to internal state. Up to 3 new agents per request.

## Step 3: how this actually gets *worked on* — no special-casing required

This is the part worth being explicit about: **reopening a PR is the entire mechanism.**
Nothing in the owner-channel code directly launches an agent session. It simply sets
`pr.status = "Changes requested"` and, if the agent had been `"completed"`, resets it to
`"queued"`. The regular scheduler loop in `runMissionPool` (`scheduler.ts`) already scans every
PR each round:

```ts
for (const pr of run.state.pullRequests) {
  if (pr.status !== "Changes requested") continue;
  if (busyAgents.has(pr.ownerAgentId)) continue;
  // ...launch a revision session for this PR's owner
}
```

An owner-reopened PR is indistinguishable, to the scheduler, from a PR a reviewer just sent
back — it's picked up by the exact same revision-job code path on the very next round. The
`void runAutopilot(...)` call in the server route exists only to make sure the pool is actually
running if it had gone idle after mission completion; if the mission was already executing, the
next round would have picked it up regardless.

The same logic applies to a hired agent: it's created with `status: "queued"` and a real task,
so it's picked up by the normal execution loop (not the revision loop) the same way any
originally-planned agent would be.

## Step 4: re-verifying after the change

If an owner change reopens work on a mission that had already passed runtime acceptance,
`hasRuntimeGatePassed` (used by `shouldRunRuntimeAcceptance` in `acceptance.ts`) compares the
timestamp of the last acceptance pass against the timestamp of the last owner decision — an
owner change always invalidates a stale "already accepted" result, so the mission re-runs the
full build + smoke-test + Qwen-judge gate before it's allowed to complete again. This is also
what produces a new versioned mission debrief (see [`architecture/`](../architecture/)) rather
than silently leaving the first one in place.

## Why route through the Book instead of calling the agent directly

Every owner instruction is a Book entry before it's anything else. That means: it's visible in
the mission's permanent record (`.orvix/runs/<id>/book.jsonl`), it participates in the same
signal/routing mechanics every other coordination message does (see
[`orvix-book/`](../orvix-book/)), and an agent picks it up through the exact same
`getBookContext` call it uses for peer-to-peer coordination — there's no separate "owner
message" code path inside the agent runtime to keep in sync.

## Related docs

[`orvix-book/`](../orvix-book/) · [`collaboration/`](../collaboration/) ·
[`cli/`](../cli/) · [`architecture/`](../architecture/)
