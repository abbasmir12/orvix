# The Orvix Book

The Orvix Book is Orvix's answer to "how do 13 agents coordinate without one giant shared
context window." It's an append-only ledger of typed entries — questions, answers, decisions,
contracts, conflicts, proposals — that every agent reads a *filtered* slice of, not the whole
thing, every time it starts a session.

Implementation: `apps/api/src/book.ts`. On disk: `.orvix/runs/<missionId>/book.jsonl`.
In the CLI: the `book` activity tab.

## Entry types

```ts
type OrvixBookEntryType =
  "question" | "answer" | "note" | "assumption" | "proposal" |
  "decision" | "conflict" | "contract" | "handoff" | "review_note";
```

A few of these carry specific mechanical weight, not just labeling:

- **`question`** — created `status: "open"` until answered; `replyTo` on the answering entry
  flips it to `"answered"`. This is how one agent blocks on another's decision without
  actually blocking the scheduler — see below.
- **`contract`** and **`decision`** — always included in every agent's filtered context (see
  "What an agent actually sees"), regardless of who they were addressed to, because these are
  the entries that change what "correct" means for the mission.
- **`conflict`** — posted by MasterMind, never by an agent directly; used for build breaks,
  merge conflicts, and reviewer/agent disagreements that need explicit resolution.

## Visibility and routing

Every entry has a `scope` (`task` | `pr` | `mission`) and a `visibility`
(`mentioned` | `global` | `team`). `postBookEntry` (`book.ts`) computes who actually gets
notified:

- Explicit `toAgentIds` are always included.
- `routeBookEntry` additionally routes to any agent whose `ownershipIndex` entry matches one
  of the message's topics (inferred automatically via `inferTopics` if not supplied) — so a
  message about `"api.ts"` reaches whoever owns that file's surface in the Orvix Map, even if
  the poster didn't know their agent id.
- Every routed recipient gets an **`AgentSignal`** — a lightweight "you have mail" pointer
  (`toAgentId`, `bookEntryId`, `type`) that shows up as `unread` until the agent's session
  reads it. Signals are what the scheduler's signal-handling loop processes as its own job
  kind, separate from task execution (see [`architecture/`](../architecture/)).

## What an agent actually sees: `getBookContext`

An agent's session prompt never gets the full Book — it gets `getBookContext(run, agentId,
taskId)`, which filters to entries that are:

- globally visible, or
- from/to this agent, or
- tied to an unread signal addressed to this agent, or
- tied to this agent's current task, or
- **any `decision` or `contract`** (mission-wide, regardless of addressee), or
- still `status: "open"` (i.e., unanswered questions — visible to everyone in case anyone can
  answer them).

This list is capped to the most recent 15 entries plus the 8 most recent unread signals. That
cap is deliberate: it's a token-diet decision, not a bug — an agent needs *recent, relevant*
coordination context, not the mission's entire history re-read every turn.

## How this replaces a shared context window

Instead of every agent seeing every other agent's full transcript (which doesn't scale past a
handful of agents and burns tokens on irrelevant chatter), each agent gets a small, relevant,
freshly-filtered slice of shared state on every turn. The tradeoff: an agent can miss something
posted `mentioned` to someone else with no topic overlap. In practice this is mitigated by
`decision`/`contract` entries always propagating, and by MasterMind's wake-up pass and owner
triage explicitly re-posting anything a blocked or hired agent needs to know.

## Related docs

[`collaboration/`](../collaboration/) (how agents actually negotiate through the Book) ·
[`owner-channel/`](../owner-channel/) (how a human posts into the Book) ·
[`orvix-map/`](../orvix-map/) · [`architecture/`](../architecture/)
