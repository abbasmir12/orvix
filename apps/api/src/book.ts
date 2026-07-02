import {
  appendAgentSignal,
  appendBookEntry,
  writeStateSnapshot,
  type AgentSignal,
  type OrvixBookEntry,
  type OrvixBookEntryType,
  type OrvixBookPriority,
  type OrvixBookScope,
  type OrvixBookVisibility
} from "@orvix/core";
import { broadcast, type MissionRun } from "./run.js";

export function postBookEntry(run: MissionRun, input: {
  type: OrvixBookEntryType;
  fromAgentId: string;
  message: string;
  toAgentIds?: string[];
  scope?: OrvixBookScope;
  visibility?: OrvixBookVisibility;
  taskId?: string;
  prId?: number;
  replyTo?: string;
  topics?: string[];
  priority?: OrvixBookPriority;
  status?: OrvixBookEntry["status"];
}) {
  const topics = normalizeTopics(input.topics ?? inferTopics(input.message));
  const routedAgentIds = input.visibility === "global" && !input.toAgentIds?.length
    ? []
    : routeBookEntry(run, input.toAgentIds ?? [], topics, input.fromAgentId);
  const entry: OrvixBookEntry = {
    id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: input.type,
    scope: input.scope ?? (input.taskId ? "task" : "mission"),
    visibility: input.visibility ?? (routedAgentIds.length > 0 ? "mentioned" : "global"),
    fromAgentId: input.fromAgentId,
    toAgentIds: routedAgentIds,
    taskId: input.taskId,
    prId: input.prId,
    replyTo: input.replyTo,
    topics,
    message: input.message,
    status: input.status ?? (input.type === "question" ? "open" : input.type === "contract" || input.type === "decision" ? "final" : "resolved"),
    priority: input.priority ?? "normal",
    createdAt: new Date().toISOString()
  };

  run.state = {
    ...run.state,
    bookEntries: [...run.state.bookEntries, entry].slice(-200)
  };

  appendBookEntry(run.store, entry);
  for (const toAgentId of routedAgentIds) {
    createAgentSignal(run, {
      toAgentId,
      fromAgentId: input.fromAgentId,
      bookEntryId: entry.id,
      type: signalTypeForEntry(entry),
      message: `${agentName(run, input.fromAgentId)} posted ${entry.type}: ${entry.message.slice(0, 120)}`
    });
  }

  if (input.replyTo) {
    run.state = {
      ...run.state,
      bookEntries: run.state.bookEntries.map((candidate) => candidate.id === input.replyTo
        ? { ...candidate, status: "answered" }
        : candidate)
    };
  }

  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  broadcast(run, "book", entry);
  return entry;
}

export function normalizeBookEntryType(type: unknown): OrvixBookEntryType {
  const allowed: OrvixBookEntryType[] = [
    "question",
    "answer",
    "note",
    "assumption",
    "proposal",
    "decision",
    "conflict",
    "contract",
    "handoff",
    "review_note"
  ];

  return allowed.includes(type as OrvixBookEntryType) ? type as OrvixBookEntryType : "note";
}

export function createAgentSignal(run: MissionRun, input: Omit<AgentSignal, "id" | "status" | "createdAt">) {
  const signal: AgentSignal = {
    id: `signal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: "unread",
    createdAt: new Date().toISOString(),
    ...input
  };

  run.state = {
    ...run.state,
    agentSignals: [...run.state.agentSignals, signal].slice(-300)
  };
  appendAgentSignal(run.store, signal);
  broadcast(run, "signal", signal);
  return signal;
}

export function getBookContext(run: MissionRun, agentId: string, taskId?: string) {
  const unreadSignals = run.state.agentSignals.filter((signal) => signal.toAgentId === agentId && signal.status === "unread");
  const signalEntryIds = new Set(unreadSignals.map((signal) => signal.bookEntryId));
  const relevantEntries = run.state.bookEntries.filter((entry) =>
    entry.visibility === "global" ||
    entry.fromAgentId === agentId ||
    entry.toAgentIds.includes(agentId) ||
    signalEntryIds.has(entry.id) ||
    Boolean(taskId && entry.taskId === taskId) ||
    entry.type === "decision" ||
    entry.type === "contract" ||
    entry.status === "open"
  );

  return {
    entries: relevantEntries.slice(-25),
    unreadSignals: unreadSignals.slice(-12),
    ownershipIndex: run.state.ownershipIndex
  };
}

export function markSignalRead(run: MissionRun, input: { signalId?: string; entryId?: string }, agentId: string) {
  let changed = 0;
  run.state = {
    ...run.state,
    agentSignals: run.state.agentSignals.map((signal) => {
      const belongsToAgent = signal.toAgentId === agentId;
      const matchesSignal = Boolean(input.signalId && signal.id === input.signalId);
      const matchesEntry = Boolean(input.entryId && signal.bookEntryId === input.entryId);
      const matchesImplicitUnread = !input.signalId && !input.entryId && signal.status === "unread";
      if (belongsToAgent && signal.status !== "read" && (matchesSignal || matchesEntry || matchesImplicitUnread)) {
        changed += 1;
        return { ...signal, status: "read" };
      }
      return signal;
    })
  };
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return changed;
}

export function routeBookEntry(run: MissionRun, explicitAgentIds: string[], topics: string[], fromAgentId: string) {
  const routed = new Set(explicitAgentIds.filter((agentId) => agentId !== fromAgentId));
  for (const topic of topics) {
    for (const agentId of run.state.ownershipIndex[topic] ?? []) {
      if (agentId !== fromAgentId) {
        routed.add(agentId);
      }
    }
  }
  return Array.from(routed).slice(0, 6);
}

export function inferTopics(message: string) {
  return message
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((word) => word.length > 3)
    .slice(0, 8);
}

export function normalizeTopics(topics: string[]) {
  return Array.from(new Set(topics.map((topic) =>
    topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  ).filter(Boolean))).slice(0, 12);
}

export function signalTypeForEntry(entry: OrvixBookEntry): AgentSignal["type"] {
  if (entry.type === "answer") return "answer";
  if (entry.type === "conflict") return "conflict";
  if (entry.type === "decision") return "decision";
  if (entry.type === "review_note") return "review";
  if (entry.type === "contract") return "contract_update";
  return "mention";
}

export function normalizeBookPriority(value: unknown): OrvixBookPriority {
  const allowed: OrvixBookPriority[] = ["low", "normal", "high", "urgent"];
  return allowed.includes(value as OrvixBookPriority) ? value as OrvixBookPriority : "normal";
}

export function agentName(run: MissionRun, agentId: string) {
  return run.state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

export function planningBookContext(run: MissionRun) {
  return run.state.bookEntries
    .filter((entry) => entry.scope === "mission" && entry.createdAt)
    .slice(-20)
    .map((entry) => ({
      type: entry.type,
      fromAgentId: entry.fromAgentId,
      topics: entry.topics,
      message: entry.message,
      priority: entry.priority,
      status: entry.status
    }));
}

