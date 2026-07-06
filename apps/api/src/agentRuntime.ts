import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  writeStateSnapshot,
  type Agent,
  type AgentExecutionPlan,
  type AgentToolCall,
  type AgentToolName,
  type SimulationState
} from "@orvix/core";
import { createAgentSessionMessages, isQwenConfigured, QwenClient, withQwenUsageRun, type ChatMessage } from "@orvix/qwen";
import {
  branchExists,
  checkoutGitBranch,
  commitWorkspaceChanges,
  createGitBranch,
  deleteWorkspacePath,
  ensureAgentWorktree,
  getBranchDiff,
  getGitStatus,
  getWorkspaceDiff,
  listWorkspaceFiles,
  mergeWorkspaceBranch,
  readWorkspaceFile,
  beginOwnerConflictedSync,
  writeWorkspaceFile,
  type Workspace
} from "@orvix/workspace";
import {
  addReasoningArtifact,
  agentExecutionToolCallLimit,
  appendEvent,
  broadcast,
  mapWorkPacketForAgent,
  orvixMapContext,
  stopScriptedTimers,
  usesQwenReasoning,
  workspaceOf,
  type MissionRun
} from "./run.js";
import { deriveAgentSkills } from "./agentSkills.js";
import { getBookContext, inferTopics, markSignalRead, normalizeBookEntryType, postBookEntry } from "./book.js";
import { envPositiveInt } from "./envConfig.js";
import { fetchUrlForAgent, researchWeb } from "./research.js";

export function executeGitTool(
  run: MissionRun,
  body: {
    tool?: "git_status" | "create_branch" | "checkout_branch" | "commit_changes" | "get_diff" | "merge_branch";
    branch?: string;
    message?: string;
    baseBranch?: string;
    targetBranch?: string;
  }
) {
  switch (body.tool) {
    case "git_status":
      return getGitStatus(workspaceOf(run));
    case "create_branch":
      return createGitBranch(workspaceOf(run), body.branch ?? "", body.baseBranch ?? "main");
    case "checkout_branch":
      return checkoutGitBranch(workspaceOf(run), body.branch ?? "");
    case "commit_changes":
      return commitWorkspaceChanges(workspaceOf(run), body.message ?? "chore: agent workspace update");
    case "get_diff":
      return getWorkspaceDiff(workspaceOf(run), body.baseBranch ?? "main");
    case "merge_branch":
      return mergeWorkspaceBranch(workspaceOf(run), body.branch ?? "", body.targetBranch ?? "main");
    default:
      return {
        ok: false as const,
        tool: body.tool ?? "unknown",
        error: "Unsupported Git workspace tool"
      };
  }
}

export type ExecuteAgentTaskOptions = {
  taskId?: string;
  revision?: boolean;
};

export async function executeAgentTask(run: MissionRun, agentId: string, options: ExecuteAgentTaskOptions = {}) {
  stopScriptedTimers(run);
  const agent = run.state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return {
      ok: false,
      error: "agent_not_found"
    };
  }

  const executedTaskIds = getExecutedTaskIds(run);
  const task = options.taskId
    ? run.state.tasks.find((candidate) => candidate.ownerAgentId === agent.id && candidate.id === options.taskId)
    : run.state.tasks.find((candidate) =>
      candidate.ownerAgentId === agent.id && !executedTaskIds.has(candidate.id)
    );
  if (!task) {
    return {
      ok: false,
      error: "task_not_found"
    };
  }

  if (!options.revision && executedTaskIds.has(task.id)) {
    return {
      ok: false,
      error: "task_already_executed"
    };
  }

  const allowedTools = allowedToolsForAgent(agent);
  const taskWorkspace = agentTaskWorkspace(run, agent, task);
  if ("ok" in taskWorkspace && !taskWorkspace.ok) {
    updateAgentTaskState(run, agent.id, task.id, "blocked", "Could not create agent worktree");
    appendEvent(run, `${agent.name} could not create worktree for ${task.branch}: ${taskWorkspace.error}`, "warning");
    return {
      ok: false,
      agent,
      task,
      error: taskWorkspace.error
    };
  }

  const workspace = taskWorkspace as Workspace;
  if (options.revision) {
    // Owner revision: a conflicted merge is left in the tree with <<<<<<<
    // markers so THIS agent (the owner) resolves it in-session; its commit
    // completes the merge. Non-owner syncs elsewhere still fail-safe.
    const sync = beginOwnerConflictedSync(workspace, task.branch, "main");
    if (!sync.ok) {
      appendEvent(run, `MasterMind could not pre-sync ${task.branch} before revision: ${sync.error}`, "warning");
    } else if (sync.conflictedFiles.length === 0) {
      appendEvent(run, `MasterMind synced ${task.branch} with main before revision`, "success");
    } else {
      appendEvent(run, `MasterMind staged a conflicted sync of ${task.branch}; ${agent.name} must resolve ${sync.conflictedFiles.length} file(s)`, "warning");
      postBookEntry(run, {
        type: "conflict",
        fromAgentId: "mastermind-agent",
        toAgentIds: [agent.id],
        taskId: task.id,
        scope: "task",
        visibility: "mentioned",
        topics: ["merge-conflict", "resolve-markers", task.branch],
        priority: "urgent",
        status: "open",
        message: [
          `Your branch ${task.branch} conflicts with main. The merge is staged in your worktree and these files contain <<<<<<< conflict markers:`,
          ...sync.conflictedFiles.map((file) => `- ${file}`),
          "FIRST read each listed file, rewrite it with the markers resolved (keep main's contracts, preserve your feature work), then commit_changes — your commit completes the merge. Do this before any other revision work."
        ].join("\n")
      });
    }
  }

  const workspaceListing = listWorkspaceFiles(workspace);
  const workspaceFiles = workspaceListing.ok && "files" in workspaceListing && Array.isArray(workspaceListing.files) && workspaceListing.files.length > 200
    ? { ...workspaceListing, files: workspaceListing.files.slice(0, 200), truncated: true }
    : workspaceListing;
  postSpeculativeDependencyNotes(run, agent, task);
  const bookContext = getBookContext(run, agent.id, task.id);
  const reviewFeedback = reviewFeedbackForTask(run, task);
  const revisionNumber = getExecutedTaskRevisionCount(run, task.id) + (options.revision ? 1 : 0);

  appendEvent(
    run,
    `${agent.name} started ${options.revision ? "revision session" : "interactive workspace session"} for ${task.title}`,
    "info"
  );
  updateAgentTaskState(run, agent.id, task.id, "active", options.revision ? "Applying reviewer changes" : "Working in agent session");

  let outcome: AgentSessionOutcome;
  if (usesQwenReasoning(run) && isQwenConfigured()) {
    try {
      outcome = await withQwenUsageRun(run.id, () => runAgentSession(run, agent, task, workspace, allowedTools, {
        workspaceFiles,
        bookContext,
        reviewFeedback,
        revision: Boolean(options.revision)
      }));
    } catch (error) {
      const message = `${agent.name} Qwen session failed; no deterministic implementation fallback was applied: ${error instanceof Error ? error.message : "Unknown error"}`;
      updateAgentTaskState(run, agent.id, task.id, "blocked", "Qwen agent session failed");
      appendEvent(run, message, "warning");
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      return {
        ok: false,
        agent,
        task,
        error: "qwen_session_failed"
      };
    }
  } else {
    outcome = await runMockAgentPlan(run, agent, task, workspace, allowedTools, {
      revision: Boolean(options.revision),
      revisionNumber
    });
  }

  const results = outcome.results;
  const hasImplementation = results.some((entry) =>
    entry.result.ok && (entry.toolCall.tool === "write_file" || entry.toolCall.tool === "delete_file")
  );

  // A session without writes is only a failure when the branch itself has
  // nothing to review. A revision session that inspects the branch and finds
  // it already correct (e.g. the reviewer misread a small diff, or another
  // agent landed the packet on main) legitimately writes nothing — treat the
  // existing branch diff as the implementation and hand it back to review.
  const evidence = hasReviewableBranchEvidence(run, task.branch);
  const branchAlreadyReviewable = evidence.ok && evidence.reviewable;

  if (usesQwenReasoning(run) && !hasImplementation && !branchAlreadyReviewable && implementationTaskRequiresEvidence(task)) {
    const retryCount = getNoImplementationRetryCount(run, task.id);
    if (retryCount < 1) {
      const message = `${agent.name} finished the session without successful write_file or delete_file calls; MasterMind is requeuing one concrete implementation retry with an explicit Orvix Map contract.`;
      postBookEntry(run, {
        type: "contract",
        fromAgentId: "mastermind-agent",
        toAgentIds: [agent.id],
        taskId: task.id,
        scope: "task",
        visibility: "mentioned",
        topics: ["no-implementation-tools", "orvix-map", "implementation", task.id],
        priority: "urgent",
        status: "final",
        message: [
          `Your previous session for ${task.title} produced no successful write_file or delete_file calls.`,
          "Retry this task once with concrete source/config/test changes.",
          "Use the Orvix Map and your mapWorkPacket as the build contract.",
          "Do not submit only markdown, planning notes, or Orvix Book coordination unless the task is explicitly review-only."
        ].join(" ")
      });
      updateAgentTaskState(run, agent.id, task.id, "queued", "Requeued for concrete implementation retry");
      appendEvent(run, message, "warning");
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      return {
        ok: false,
        agent,
        task,
        recoverable: true,
        error: "no_agent_implementation_tools_requeued"
      };
    }

    const message = `${agent.name} produced no implementation tool calls after retry; Orvix will not synthesize implementation fallback in Qwen mode.`;
    updateAgentTaskState(run, agent.id, task.id, "blocked", "No reviewable agent-authored implementation");
    appendEvent(run, message, "warning");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: false,
      agent,
      task,
      error: "no_agent_implementation_tools"
    };
  }

  const failed = outcome.failed;
  if (!failed && !hasImplementation && branchAlreadyReviewable) {
    appendEvent(run, `${agent.name} made no new writes but ${task.branch} already carries a reviewable diff; routing the existing branch to review`, "info");
  }
  if (!failed && evidence.ok && evidence.reviewable) {
    updateAgentTaskState(run, agent.id, task.id, "completed", "Workspace execution complete");
    updatePullRequestFromTask(run, task, "In progress", "Reviewing");
    const changedPaths = results
      .map((entry) => entry.toolCall.path)
      .filter((path): path is string => Boolean(path))
      .slice(0, 4);
    appendEvent(
      run,
      `${agent.name} produced workspace changes for review${changedPaths.length ? `: ${changedPaths.join(", ")}` : ""}`,
      "success"
    );
  } else if (!failed) {
    updateAgentTaskState(run, agent.id, task.id, "blocked", `Missing branch evidence for review: ${evidence.reason}`);
    appendEvent(run, `${agent.name} finished without reviewable branch evidence: ${evidence.reason}`, "warning");
  } else {
    updateAgentTaskState(run, agent.id, task.id, "blocked", `Session ended: ${outcome.endedBy}`);
  }

  addReasoningArtifact(run, {
    kind: "agent_execution",
    status: failed || !evidence.ok || !evidence.reviewable ? "failed" : "completed",
    content: JSON.stringify({
      agent,
      task,
      revision: Boolean(options.revision),
      revisionNumber,
      allowedTools,
      bookContext,
      session: {
        turns: outcome.turns,
        endedBy: outcome.endedBy
      },
      plan: {
        summary: outcome.summary,
        transcript: outcome.transcript,
        toolCalls: results.map((entry) => entry.toolCall)
      },
      results
    }),
    reasoningContent: outcome.reasoningContent
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);

  return {
    ok: !failed && evidence.ok && evidence.reviewable,
    agent,
    task,
    allowedTools,
    plan: {
      summary: outcome.summary,
      transcript: outcome.transcript,
      toolCalls: results.map((entry) => entry.toolCall)
    },
    results,
    workspace,
    git: getGitStatus(workspace)
  };
}

type AgentToolResult = Awaited<ReturnType<typeof executeAgentToolCall>>;

type AgentSessionOutcome = {
  results: Array<{ toolCall: AgentToolCall; result: AgentToolResult; harness?: boolean }>;
  transcript: NonNullable<AgentExecutionPlan["transcript"]>;
  summary: string;
  turns: number;
  endedBy: "open_pr" | "complete_task" | "turn_limit" | "no_more_tools" | "tool_failures" | "plan_complete";
  reasoningContent?: string;
  failed: boolean;
};

function broadcastAgentTurn(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  turn: number,
  payload: {
    kind: "note" | "tool" | "harness" | "compaction";
    tool?: string;
    path?: string;
    ok?: boolean;
    detail?: string;
    context?: { promptTokens: number; windowTokens: number; percent: number };
  }
) {
  const event = {
    missionId: run.id,
    agentId: agent.id,
    agentName: agent.name,
    taskId: task.id,
    branch: task.branch,
    turn,
    at: new Date().toISOString(),
    ...payload
  };
  broadcast(run, "agent_turn", event);
  // Persisted so a resumed CLI can restore the live-turns feed, not just
  // the state snapshot. Failure to append must never break a session.
  try {
    appendFileSync(resolve(run.store.runDir, "turns.jsonl"), `${JSON.stringify(event)}\n`);
  } catch {
    // best-effort telemetry
  }
}

/** Compact, model-facing serialization of a tool result (no giant diffs or file bodies beyond caps). */
function toolResultForModel(result: AgentToolResult): string {
  const record = result as Record<string, unknown>;
  if (!record || typeof record !== "object") {
    return JSON.stringify({ ok: false, error: "no_result" });
  }
  const compact: Record<string, unknown> = { ok: record.ok, tool: record.tool };
  if (record.error) compact.error = record.error;
  if (typeof record.path === "string") compact.path = record.path;
  if (typeof record.branch === "string") compact.branch = record.branch;
  if (typeof record.content === "string") compact.content = truncateForModel(record.content, 6000);
  if (typeof record.output === "string") compact.output = truncateForModel(record.output, 4000);
  if (typeof record.bytes === "number") compact.bytes = record.bytes;
  if (typeof record.additions === "number") {
    compact.additions = record.additions;
    compact.removals = record.removals;
  }
  if (typeof record.existedBefore === "boolean") compact.existedBefore = record.existedBefore;
  if (typeof record.exists === "boolean") compact.exists = record.exists;
  if (typeof record.entryId === "string") compact.entryId = record.entryId;
  if (Array.isArray(record.files)) {
    compact.files = (record.files as Array<{ path?: string; type?: string }>)
      .slice(0, 150)
      .map((file) => `${file.type === "directory" ? "dir " : "file "}${file.path ?? ""}`);
  }
  if (Array.isArray(record.results)) compact.results = record.results;
  return JSON.stringify(compact);
}

function truncateForModel(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... [truncated ${value.length - limit} characters]`;
}

function implementationTaskRequiresEvidence(task?: SimulationState["tasks"][number]) {
  if (!task) return true;
  const text = `${task.title} ${task.acceptanceCriteria.join(" ")}`.toLowerCase();
  return !/review-only|review only|audit only|advisory/.test(text);
}

/**
 * The multi-turn agent session: the model calls tools, Orvix executes them in
 * the agent's worktree, results go back as tool messages, and the loop runs
 * until the agent opens a PR, completes the task, or hits its budget.
 * Harness bookkeeping (auto-commit/auto-PR of the agent's own work) is
 * labelled as such; Orvix never writes implementation content itself.
 */
/**
 * Deterministic context compaction for a running agent session. Chat sessions
 * re-send the full message history every turn, and old read_file/diff tool
 * outputs (up to ~6k chars each) are the bulk of it. When context crosses the
 * compaction threshold, older turns' tool results and narration are truncated
 * to stubs in place — message structure (assistant tool_calls ↔ tool replies)
 * stays intact, so the API contract is preserved. The last `keepRecentTurns`
 * assistant turns are left untouched: that is the agent's working memory.
 */
export function compactSessionMessages(messages: ChatMessage[], keepRecentTurns = 2) {
  let assistantSeen = 0;
  let cutoff = messages.length;
  for (let index = messages.length - 1; index >= 2; index -= 1) {
    if (messages[index].role === "assistant") {
      assistantSeen += 1;
      if (assistantSeen >= keepRecentTurns) {
        cutoff = index;
        break;
      }
    }
  }

  let compacted = 0;
  for (let index = 2; index < cutoff; index += 1) {
    const message = messages[index];
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length <= 300) continue;
    if (message.role === "tool") {
      message.content = `${content.slice(0, 220)}… [compacted: full result was ${content.length} chars; re-read the file if you need it]`;
      compacted += 1;
    } else if (message.role === "assistant") {
      message.content = `${content.slice(0, 200)}… [compacted]`;
      compacted += 1;
    }
  }
  return compacted;
}

async function runAgentSession(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  workspace: Workspace,
  allowedTools: AgentToolName[],
  context: {
    workspaceFiles: unknown;
    bookContext: unknown;
    reviewFeedback: unknown;
    revision: boolean;
  }
): Promise<AgentSessionOutcome> {
  // Seeded per agent: parallel agents start on different chain models so
  // they drain separate quota buckets instead of stampeding the first one.
  const qwen = new QwenClient(undefined, agent.id);
  // Solo baseline owns the whole mission in one session, so it gets a larger
  // budget than a specialist agent owning one workstream in society mode.
  const maxTurns = run.mode === "solo"
    ? envPositiveInt("QWEN_SOLO_AGENT_MAX_TURNS", 40, 80)
    : envPositiveInt("QWEN_AGENT_MAX_TURNS", 10, 24);
  const maxToolCalls = run.mode === "solo"
    ? envPositiveInt("QWEN_SOLO_AGENT_MAX_TOOL_CALLS", 150, 400)
    : agentExecutionToolCallLimit;
  // Token diet: the whole opening message is re-sent on every session turn,
  // so full agent/task/PR objects (activity strings, comment history, other
  // agents' acceptance criteria) multiply across ~10 turns for zero signal.
  // The agent's own task/packet/feedback stay complete; the rest is roster.
  const slimAgents = run.state.agents.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    role: candidate.role,
    status: candidate.status
  }));
  const slimTasks = run.state.tasks.map((candidate) => candidate.id === task.id ? candidate : {
    id: candidate.id,
    title: candidate.title,
    status: candidate.status,
    branch: candidate.branch,
    ownerAgentId: candidate.ownerAgentId,
    dependsOnAgentIds: candidate.dependsOnAgentIds
  });
  const slimPullRequests = run.state.pullRequests.map((pr) => pr.ownerAgentId === agent.id ? pr : {
    id: pr.id,
    status: pr.status,
    ownerAgentId: pr.ownerAgentId,
    ownerName: pr.ownerName,
    branch: pr.branch
  });

  const messages: ChatMessage[] = createAgentSessionMessages({
    mission: run.mission,
    agent,
    task,
    allowedTools,
    workspaceFiles: context.workspaceFiles,
    bookContext: context.bookContext as never,
    organization: run.state.organization,
    agents: slimAgents as never,
    tasks: slimTasks as never,
    pullRequests: slimPullRequests as never,
    reviewFeedback: context.reviewFeedback,
    orvixMap: orvixMapContext(run),
    mapWorkPacket: mapWorkPacketForAgent(run, agent.id, task.id),
    agentSkills: deriveAgentSkills(run, agent, task.id).charter,
    revision: context.revision,
    maxTurns,
    maxToolCalls
  });

  const results: AgentSessionOutcome["results"] = [];
  const transcript: AgentSessionOutcome["transcript"] = [];
  let endedBy: AgentSessionOutcome["endedBy"] = "turn_limit";
  let reasoningContent: string | undefined;
  let totalToolCalls = 0;
  let consecutiveFailures = 0;
  let nudged = false;
  let wrapUpNudged = false;
  let turn = 0;
  const fallbackWindowTokens = envPositiveInt("QWEN_CONTEXT_WINDOW_TOKENS", 65536, 2097152);
  const compactAtPercent = envPositiveInt("QWEN_COMPACT_AT_PERCENT", 80, 99);

  for (; turn < maxTurns; turn += 1) {
    const response = await qwen.agentSessionTurn(messages, allowedTools, { requireTool: turn === 0 });
    reasoningContent = response.reasoningContent ?? reasoningContent;

    // Prefer the serving model's REAL window (from the provider's /models
    // metadata — e.g. DeepSeek v4 flash reports 1M) over the env fallback,
    // re-read every turn because chain fallbacks can switch models mid-session.
    const windowTokens = response.contextWindow ?? fallbackWindowTokens;
    const promptTokens = response.usage?.promptTokens ?? 0;
    const contextPercent = Math.min(999, Math.round((promptTokens / windowTokens) * 100));
    const contextInfo = { promptTokens, windowTokens, percent: contextPercent };
    if (contextPercent >= compactAtPercent) {
      const compacted = compactSessionMessages(messages);
      if (compacted > 0) {
        appendEvent(run, `${agent.name} context at ${contextPercent}% of ${windowTokens} tokens; compacted ${compacted} older session messages`, "info");
        broadcastAgentTurn(run, agent, task, turn, { kind: "compaction", detail: `compacted ${compacted} messages`, context: contextInfo });
      } else if (!wrapUpNudged && contextPercent >= 95) {
        wrapUpNudged = true;
        messages.push({
          role: "user",
          content: "Context window is nearly full and cannot be compacted further. Wrap up now: commit_changes and open_pr with what you have, noting any remaining gaps in the PR summary."
        });
      }
    }
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: Array.isArray(response.message?.tool_calls) ? response.message.tool_calls as unknown[] : undefined
    });

    const narration = response.content?.trim();
    if (narration) {
      transcript.push({ type: "observation", text: narration.slice(0, 500) });
      broadcastAgentTurn(run, agent, task, turn, { kind: "note", detail: narration.slice(0, 300), context: contextInfo });
    }

    const calls = response.nativeToolCalls ?? [];
    if (calls.length === 0) {
      const wroteSomething = results.some((entry) => entry.result.ok && (entry.toolCall.tool === "write_file" || entry.toolCall.tool === "delete_file"));
      if (!wroteSomething && !nudged) {
        nudged = true;
        messages.push({
          role: "user",
          content: "You have not produced any implementation evidence yet. Continue the session with concrete tool calls: read the files you need, then write_file the implementation, commit_changes, and open_pr. If this task is truly review-only, call complete_task."
        });
        continue;
      }
      endedBy = "no_more_tools";
      break;
    }

    let terminal: AgentSessionOutcome["endedBy"] | null = null;
    for (const [index, toolCall] of calls.entries()) {
      if (totalToolCalls >= maxToolCalls) {
        endedBy = "turn_limit";
        terminal = "turn_limit";
        break;
      }
      totalToolCalls += 1;

      let result = await executeAgentToolCall(run, agent, task, toolCall, allowedTools, workspace);
      if (isToolAccessDenied(result) && handleMasterMindToolAccessIntervention(run, agent, task, toolCall, allowedTools)) {
        result = await executeAgentToolCall(run, agent, task, toolCall, allowedTools, workspace);
      }
      results.push({ toolCall, result });

      const failureReason = !result.ok && "error" in result ? `: ${result.error}` : "";
      appendEvent(
        run,
        `${agent.name} ${result.ok ? "completed" : "failed"} tool ${toolCall.tool}${failureReason}`,
        result.ok ? "success" : "warning"
      );
      broadcastAgentTurn(run, agent, task, turn, {
        kind: "tool",
        tool: toolCall.tool,
        path: toolCall.path,
        ok: Boolean(result.ok),
        detail: !result.ok && "error" in result ? String(result.error).slice(0, 200) : undefined
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.callId ?? `call-${turn}-${index}`,
        content: toolResultForModel(result)
      });

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= 4) {
        terminal = "tool_failures";
        break;
      }
      if (result.ok && (toolCall.tool === "open_pr" || toolCall.tool === "complete_task")) {
        terminal = toolCall.tool;
      }
    }

    if (terminal) {
      endedBy = terminal;
      break;
    }
  }

  const wroteFiles = results.some((entry) => entry.result.ok && (entry.toolCall.tool === "write_file" || entry.toolCall.tool === "delete_file"));
  const committed = results.some((entry) => entry.result.ok && entry.toolCall.tool === "commit_changes");
  const openedPr = results.some((entry) => entry.result.ok && entry.toolCall.tool === "open_pr");

  if (wroteFiles && !committed) {
    const commitResult = commitWorkspaceChanges(workspace, `${context.revision ? "fix" : "feat"}: ${task.title}`.slice(0, 100));
    results.push({
      toolCall: { tool: "commit_changes", message: `${context.revision ? "fix" : "feat"}: ${task.title}` },
      result: commitResult,
      harness: true
    });
    appendEvent(run, `Orvix committed ${agent.name}'s session work (agent forgot commit_changes)`, "info");
    broadcastAgentTurn(run, agent, task, turn, { kind: "harness", tool: "commit_changes", ok: commitResult.ok });
  }

  if (wroteFiles && !openedPr) {
    updatePullRequestFromTask(run, task, "In progress", "Reviewing", {
      summary: `${agent.name} session work for ${task.title} (PR opened by Orvix bookkeeping).`
    });
    results.push({
      toolCall: { tool: "open_pr", title: task.title, summary: "Opened by Orvix bookkeeping after agent session." },
      result: { ok: true, tool: "open_pr", branch: task.branch, output: "Opened PR from session bookkeeping" } as AgentToolResult,
      harness: true
    });
    appendEvent(run, `Orvix opened the review packet for ${agent.name}'s session (agent forgot open_pr)`, "info");
    broadcastAgentTurn(run, agent, task, turn, { kind: "harness", tool: "open_pr", ok: true });
  }

  const summaryNarration = transcript.length > 0
    ? transcript[transcript.length - 1].text
    : `${agent.name} completed an interactive session (${endedBy}).`;

  return {
    results,
    transcript,
    summary: summaryNarration.slice(0, 300),
    turns: turn + 1,
    endedBy,
    reasoningContent,
    failed: endedBy === "tool_failures",
  };
}

/** Mock-mode execution keeps the deterministic doc-note plan for local demos. */
async function runMockAgentPlan(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  workspace: Workspace,
  allowedTools: AgentToolName[],
  options: { revision: boolean; revisionNumber: number }
): Promise<AgentSessionOutcome> {
  const plan = normalizeAgentExecutionPlan(createMockAgentPlan(agent, task), agent, task, options);
  const results: AgentSessionOutcome["results"] = [];

  for (const toolCall of plan.toolCalls.slice(0, agentExecutionToolCallLimit)) {
    const result = await executeAgentToolCall(run, agent, task, toolCall, allowedTools, workspace);
    results.push({ toolCall, result });
    if (!result.ok) {
      break;
    }
  }

  const failed = results.some((entry) => !entry.result.ok);
  return {
    results,
    transcript: plan.transcript ?? [],
    summary: plan.summary,
    turns: 1,
    endedBy: failed ? "tool_failures" : "plan_complete",
    failed
  };
}

export async function executeNextAgentTask(run: MissionRun) {
  const executedTaskIds = getCompletedTaskIds(run);
  const nextTask = getExecutableTasks(run, executedTaskIds, 1)[0] ??
    run.state.tasks.find((task) => !executedTaskIds.has(task.id));

  if (!nextTask) {
    return {
      ok: false,
      error: "no_unexecuted_tasks"
    };
  }

  return executeAgentTask(run, nextTask.ownerAgentId);
}

/** True once the given agent's owned PR (if any) has actually merged. No owned PR yet means nothing to depend on. */
export function isAgentDependencySatisfied(run: MissionRun, dependencyAgentId: string) {
  const ownedPr = run.state.pullRequests.find((pr) => pr.ownerAgentId === dependencyAgentId);
  return !ownedPr || ownedPr.status === "Approved";
}

/** Real scheduling gate: a task with unmet dependsOnAgentIds is not executable yet, full stop. */
export function taskDependenciesSatisfied(run: MissionRun, task: SimulationState["tasks"][number]) {
  return task.dependsOnAgentIds.every((dependencyAgentId) => isAgentDependencySatisfied(run, dependencyAgentId));
}

export function getExecutableTasks(run: MissionRun, executedTaskIds = getCompletedTaskIds(run), limit = 4) {
  const busyOwners = new Set(
    run.state.pullRequests
      .filter((pr) => pr.status === "In progress" || pr.status === "Changes requested")
      .map((pr) => pr.ownerAgentId)
  );
  const selectedOwners = new Set<string>();

  return run.state.tasks
    .filter((task) => {
      if (executedTaskIds.has(task.id)) return false;
      if (busyOwners.has(task.ownerAgentId)) return false;
      if (task.status === "blocked") return false;
      if (!taskDependenciesSatisfied(run, task)) return false;
      return true;
    })
    .filter((task) => {
      if (selectedOwners.has(task.ownerAgentId)) return false;
      selectedOwners.add(task.ownerAgentId);
      return true;
    })
    .slice(0, limit);
}

/**
 * By the time a task reaches execution, getExecutableTasks already enforced
 * its real dependsOnAgentIds — this only posts a coordination note for the
 * defensive case where a dependency later regresses (e.g. its PR gets sent
 * back to revision) after this agent already started speculatively.
 */
export function postSpeculativeDependencyNotes(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number]
) {
  const missingDependencies = task.dependsOnAgentIds.filter((dependencyAgentId) => !isAgentDependencySatisfied(run, dependencyAgentId));
  if (missingDependencies.length === 0) return;

  const alreadyPosted = run.state.bookEntries.some((entry) =>
    entry.fromAgentId === agent.id &&
    entry.taskId === task.id &&
    entry.type === "question" &&
    entry.topics.includes("dependency")
  );
  if (alreadyPosted) return;

  const dependencyOwners = missingDependencies.filter((ownerId) => ownerId !== agent.id);

  postBookEntry(run, {
    type: "question",
    fromAgentId: agent.id,
    toAgentIds: dependencyOwners,
    taskId: task.id,
    scope: "task",
    visibility: dependencyOwners.length > 0 ? "mentioned" : "team",
    topics: ["dependency", "contract", ...missingDependencies],
    priority: "high",
    message: `${agent.name} is starting ${task.title} speculatively while waiting for ${missingDependencies.join(", ")}. Please publish interface contracts or constraints in Orvix Book; I will proceed with explicit assumptions meanwhile.`
  });

  postBookEntry(run, {
    type: "assumption",
    fromAgentId: agent.id,
    taskId: task.id,
    scope: "task",
    visibility: "global",
    topics: ["speculative-execution", "dependency", ...missingDependencies],
    priority: "normal",
    message: `${agent.name} will not block on dependencies for ${task.title}; branch work continues with assumptions until dependent agents answer.`
  });
}

/**
 * Mock-mode only: orders the deterministic demo plan into the standard
 * branch -> write -> commit -> PR sequence. Qwen mode uses runAgentSession
 * and never rewrites the agent's tool calls.
 */
export function normalizeAgentExecutionPlan(
  plan: AgentExecutionPlan,
  agent: Agent,
  task: SimulationState["tasks"][number],
  options: { revision?: boolean; revisionNumber?: number } = {}
): AgentExecutionPlan {
  const coordinationCalls = plan.toolCalls.filter((call) =>
    call.tool === "post_book_entry" ||
    call.tool === "read_book" ||
    call.tool === "answer_book_entry" ||
    call.tool === "read_signals" ||
    call.tool === "mark_signal_read" ||
    call.tool === "research_web" ||
    call.tool === "fetch_url"
  );
  const writeCalls: AgentToolCall[] = plan.toolCalls
    .filter((call) => call.tool === "write_file")
    .map((call) => ({ ...call, branch: undefined }));
  const deleteCalls: AgentToolCall[] = plan.toolCalls
    .filter((call) => call.tool === "delete_file")
    .map((call) => ({ ...call, branch: undefined }));

  const toolCalls: AgentToolCall[] = [
    ...coordinationCalls,
    options.revision ? { tool: "checkout_branch", branch: task.branch } : { tool: "create_branch", branch: task.branch, baseBranch: "main" },
    ...deleteCalls,
    ...writeCalls,
    { tool: "commit_changes", message: `${options.revision ? "fix" : "feat"}: ${task.title}` },
    {
      tool: "open_pr",
      title: task.title,
      summary: `${agent.name} ${options.revision ? "revised" : "completed"} the workspace packet for ${task.title}.`
    }
  ];

  const existingTranscript = Array.isArray(plan.transcript) ? plan.transcript : [];
  const transcript = existingTranscript.length > 0
    ? existingTranscript
    : createDefaultTranscript(agent, task, toolCalls, options);

  return {
    ...plan,
    summary: plan.summary || `${agent.name} generated a normalized Orvix execution plan.`,
    transcript,
    toolCalls
  };
}

export function createDefaultTranscript(
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCalls: AgentToolCall[],
  options: { revision?: boolean; revisionNumber?: number } = {}
): NonNullable<AgentExecutionPlan["transcript"]> {
  const writeIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "write_file"));
  const commitIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "commit_changes"));
  const prIndex = Math.max(0, toolCalls.findIndex((call) => call.tool === "open_pr"));

  return [
    {
      type: "observation",
      text: `${agent.name} has a focused ownership slice: ${task.title}. The branch can move forward with explicit assumptions while sibling agents publish their contracts.`,
      beforeToolIndex: 0
    },
    {
      type: "decision",
      text: options.revision
        ? `This is revision ${options.revisionNumber ?? 1}, so the safest move is to update the existing branch evidence instead of opening a separate workstream.`
        : "Before writing files, the agent records the coordination assumption in Orvix Book so other agents can reconcile against it later.",
      beforeToolIndex: 0
    },
    {
      type: "tool_intent",
      tool: "write_file",
      path: toolCalls[writeIndex]?.path,
      text: "The implementation packet needs concrete evidence now. A small source artifact is better than a broad plan because Critic Council can review an actual diff.",
      beforeToolIndex: writeIndex
    },
    {
      type: "tool_intent",
      tool: "commit_changes",
      text: "The changed files are ready to become branch evidence, so the next step is committing them with the task scope in the message.",
      beforeToolIndex: commitIndex
    },
    {
      type: "tool_intent",
      tool: "open_pr",
      text: "With the branch committed, the agent can hand the packet to Critic Council for review instead of continuing to expand scope.",
      beforeToolIndex: prIndex
    }
  ];
}

export function hasReviewableBranchEvidence(run: MissionRun, branch: string) {
  const exists = branchExists(workspaceOf(run), branch);
  if (!exists.ok) {
    return {
      ok: false,
      reviewable: false,
      reason: exists.error
    };
  }

  if (exists.tool !== "branch_exists" || !exists.exists) {
    return {
      ok: true,
      reviewable: false,
      reason: "branch_missing"
    };
  }

  const diff = getBranchDiff(workspaceOf(run), branch, "main");
  if (!diff.ok || diff.tool !== "get_diff") {
    return {
      ok: false,
      reviewable: false,
      reason: diff.ok ? "unexpected_diff_result" : diff.error
    };
  }

  return {
    ok: true,
    reviewable: diff.output.trim().length > 0,
    reason: diff.output.trim().length > 0 ? "ready" : "empty_diff"
  };
}

export function agentTaskWorkspace(run: MissionRun, agent: Agent, task: SimulationState["tasks"][number]) {
  const worktree = ensureAgentWorktree(workspaceOf(run), agent.id, task.branch, "main");
  if ("ok" in worktree && !worktree.ok) {
    return worktree;
  }

  return worktree as Workspace;
}

export function getExecutedTaskIds(run: MissionRun) {
  const taskIds = new Set<string>();
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { id?: string } };
      if (parsed.task?.id) {
        taskIds.add(parsed.task.id);
      }
    } catch {
      continue;
    }
  }

  return taskIds;
}

export function getCompletedTaskIds(run: MissionRun) {
  const taskIds = getExecutedTaskIds(run);
  for (const task of run.state.tasks) {
    if (task.status === "completed") {
      taskIds.add(task.id);
    }
  }

  return taskIds;
}

export function getExecutedTaskRevisionCount(run: MissionRun, taskId: string) {
  let count = 0;
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { id?: string }; revision?: boolean };
      if (parsed.task?.id === taskId && parsed.revision) {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

export function getNoImplementationRetryCount(run: MissionRun, taskId: string) {
  return run.state.bookEntries.filter((entry) =>
    entry.taskId === taskId &&
    entry.topics.includes("no-implementation-tools") &&
    entry.fromAgentId === "mastermind-agent"
  ).length;
}

export function reviewFeedbackForTask(run: MissionRun, task: SimulationState["tasks"][number]) {
  const pr = run.state.pullRequests.find((candidate) =>
    candidate.branch === task.branch && candidate.ownerAgentId === task.ownerAgentId
  );
  if (!pr || pr.comments.length === 0) {
    return null;
  }

  return {
    prId: pr.id,
    status: pr.status,
    reviewerStatus: pr.reviewerStatus,
    comments: pr.comments.slice(-8)
  };
}

export function getExecutedBranches(run: MissionRun) {
  const branches = new Set<string>();
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "agent_execution" || artifact.status !== "completed" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { task?: { branch?: string } };
      if (parsed.task?.branch) {
        branches.add(parsed.task.branch);
      }
    } catch {
      continue;
    }
  }

  return branches;
}

/**
 * Real file-ownership enforcement from the Orvix Map work packets. A write to
 * a file that another agent's packet claims (and this agent's does not) is the
 * root cause of merge conflicts and post-merge build breaks, so it is blocked
 * at the tool level — the agent must coordinate through the Orvix Book
 * instead. Files no packet claims stay free-for-all, and missions whose map
 * has no packets keep the old unrestricted behavior.
 */
export function fileOwnershipConflict(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  path: string
) {
  // While main needs fix commits, the fixing agent may have to edit outside
  // its packet (e.g. a broken import in an integration file) — enforcing
  // ownership here would deadlock the build break against the turf rules.
  if (run.mainNeedsFixes) return null;

  const map = orvixMapContext(run);
  const packets = (map?.agentWorkPackets ?? []).filter((packet) => packet && typeof packet === "object");
  if (packets.length === 0) return null;

  const normalizePath = (value: unknown) => String(value ?? "").trim().replace(/^\.\//, "");
  const target = normalizePath(path);
  if (!target) return null;

  const ownPacket = mapWorkPacketForAgent(run, agent.id, task.id);
  if ((ownPacket?.mustCreateOrUpdate ?? []).some((file) => normalizePath(file) === target)) {
    return null;
  }

  // Safety valve: if the file is transparently named after THIS agent
  // (WeatherCard.tsx ← "WeatherCard Builder"), it is their file regardless
  // of what packet matching concluded — a mis-assigned packet must never
  // lock an agent out of its own component.
  const agentText = `${agent.id} ${agent.name} ${task.title} ${task.branch}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const baseName = (target.split("/").pop() ?? "").replace(/\.[a-z.]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (baseName.length > 3 && agentText.includes(baseName)) {
    return null;
  }

  for (const packet of packets) {
    if (ownPacket && packet.id === ownPacket.id) continue;
    if ((packet.mustCreateOrUpdate ?? []).some((file) => normalizePath(file) === target)) {
      return {
        packetId: String(packet.id ?? "unknown"),
        ownerRole: String(packet.suggestedAgentRole ?? "another agent")
      };
    }
  }
  return null;
}

export async function executeAgentToolCall(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCall: AgentToolCall,
  allowedTools: AgentToolName[],
  workspace: Workspace = workspaceOf(run)
) {
  if (!allowedTools.includes(toolCall.tool)) {
    return {
      ok: false,
      tool: toolCall.tool,
      code: "tool_not_allowed",
      error: `${agent.name} is not allowed to use ${toolCall.tool}`
    };
  }

  if (toolCall.tool === "write_file" || toolCall.tool === "delete_file") {
    const conflict = fileOwnershipConflict(run, agent, task, toolCall.path ?? "");
    if (conflict) {
      return {
        ok: false,
        tool: toolCall.tool,
        code: "file_owned_by_other_agent",
        error: [
          `${toolCall.path} is owned by ${conflict.ownerRole} (work packet ${conflict.packetId}) per the Orvix Map, and your packet does not list it.`,
          "Do not modify it. If you need a change there, post_book_entry a question or contract to the owner and code against the agreed interface in your own files."
        ].join(" ")
      };
    }
  }

  switch (toolCall.tool) {
    case "list_files":
      return listWorkspaceFiles(workspace);
    case "read_file":
      return readWorkspaceFile(workspace, toolCall.path ?? "");
    case "write_file":
      return writeWorkspaceFile(workspace, toolCall.path ?? "", toolCall.content ?? "");
    case "delete_file":
      return deleteWorkspacePath(workspace, toolCall.path ?? "");
    case "create_branch": {
      const status = getGitStatus(workspace);
      return status.ok && status.tool === "git_status"
        ? { ok: true as const, tool: "create_branch", branch: status.branch, output: status.output }
        : status;
    }
    case "checkout_branch": {
      const status = getGitStatus(workspace);
      return status.ok && status.tool === "git_status"
        ? { ok: true as const, tool: "checkout_branch", branch: status.branch, output: status.output }
        : status;
    }
    case "commit_changes":
      return commitWorkspaceChanges(workspace, toolCall.message ?? `feat: ${task.title}`);
    case "get_diff":
      return getWorkspaceDiff(workspace, toolCall.baseBranch ?? "main");
    case "research_web":
      return researchWeb(toolCall.query ?? toolCall.content ?? toolCall.summary ?? "");
    case "fetch_url":
      return fetchUrlForAgent(toolCall.url ?? toolCall.content ?? "");
    case "open_pr":
      updatePullRequestFromTask(run, task, "In progress", "Reviewing", {
        title: toolCall.title,
        summary: toolCall.summary
      });
      return {
        ok: true,
        tool: "open_pr",
        branch: task.branch,
        output: `Opened simulated PR for ${task.branch}`
      };
    case "complete_task":
      return {
        ok: true,
        tool: "complete_task",
        branch: task.branch,
        output: "Task marked ready for review"
      };
    case "post_book_entry": {
      const entry = postBookEntry(run, {
        type: normalizeBookEntryType(toolCall.entryType),
        fromAgentId: agent.id,
        message: toolCall.content ?? toolCall.summary ?? toolCall.message ?? "",
        toAgentIds: toolCall.toAgentIds,
        scope: toolCall.scope ?? "task",
        visibility: toolCall.visibility,
        taskId: task.id,
        topics: toolCall.topics,
        priority: toolCall.priority
      });
      return {
        ok: true,
        tool: "post_book_entry",
        entryId: entry.id,
        output: entry.message
      };
    }
    case "read_book":
      return {
        ok: true,
        tool: "read_book",
        output: JSON.stringify(getBookContext(run, agent.id, task.id))
      };
    case "answer_book_entry": {
      const target = run.state.bookEntries.find((entry) => entry.id === toolCall.entryId);
      const entry = postBookEntry(run, {
        type: "answer",
        fromAgentId: agent.id,
        message: toolCall.content ?? toolCall.summary ?? "",
        toAgentIds: target ? [target.fromAgentId] : toolCall.toAgentIds,
        scope: target?.scope ?? "task",
        visibility: "mentioned",
        taskId: target?.taskId ?? task.id,
        replyTo: toolCall.entryId,
        topics: target?.topics ?? toolCall.topics,
        priority: toolCall.priority ?? "normal",
        status: "answered"
      });
      return {
        ok: true,
        tool: "answer_book_entry",
        entryId: entry.id,
        output: entry.message
      };
    }
    case "read_signals":
      return {
        ok: true,
        tool: "read_signals",
        output: JSON.stringify(run.state.agentSignals.filter((signal) => signal.toAgentId === agent.id && signal.status === "unread"))
      };
    case "mark_signal_read":
      const marked = markSignalRead(run, { signalId: toolCall.signalId, entryId: toolCall.entryId }, agent.id);
      return {
        ok: true,
        tool: "mark_signal_read",
        output: marked > 0
          ? `Marked ${marked} signal${marked === 1 ? "" : "s"} read`
          : "No unread matching signals"
      };
  }
}

export function isToolAccessDenied(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return record.ok === false && record.code === "tool_not_allowed";
}

export function handleMasterMindToolAccessIntervention(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCall: AgentToolCall,
  allowedTools: AgentToolName[]
) {
  if (allowedTools.includes(toolCall.tool)) return false;
  if (!canMasterMindGrantTool(toolCall.tool)) return false;

  allowedTools.push(toolCall.tool);
  run.state = {
    ...run.state,
    agents: run.state.agents.map((candidate) =>
      candidate.id === "mastermind-agent"
        ? {
            ...candidate,
            status: "active",
            currentActivity: `Granted ${toolCall.tool} to ${agent.name}`,
            progress: Math.max(candidate.progress, 82)
          }
        : candidate.id === agent.id
          ? {
              ...candidate,
              status: "active",
              currentActivity: `Retrying ${toolCall.tool} after MasterMind grant`
            }
          : candidate
    )
  };

  postBookEntry(run, {
    type: "decision",
    fromAgentId: "mastermind-agent",
    toAgentIds: [agent.id],
    taskId: task.id,
    scope: "task",
    visibility: "mentioned",
    topics: ["tool-access", toolCall.tool, task.id],
    priority: "high",
    status: "final",
    message: `MasterMind detected that ${agent.name} requested ${toolCall.tool} for "${task.title}" without current access. The tool is safe for this owned task, so access is granted for this execution turn. Retry the tool now and continue the branch packet.`
  });
  appendEvent(run, `MasterMind granted ${toolCall.tool} to ${agent.name} and retried the blocked tool`, "success");
  return true;
}

export function canMasterMindGrantTool(tool: AgentToolName) {
  return [
    "list_files",
    "read_file",
    "write_file",
    "delete_file",
    "create_branch",
    "checkout_branch",
    "commit_changes",
    "get_diff",
    "research_web",
    "fetch_url",
    "open_pr",
    "complete_task",
    "post_book_entry",
    "read_book",
    "answer_book_entry",
    "read_signals",
    "mark_signal_read"
  ].includes(tool);
}

export function allowedToolsForAgent(agent: Agent): AgentToolName[] {
  return [
    "list_files",
    "read_file",
    "write_file",
    "delete_file",
    "create_branch",
    "checkout_branch",
    "commit_changes",
    "get_diff",
    "research_web",
    "fetch_url",
    "open_pr",
    "complete_task",
    "post_book_entry",
    "read_book",
    "answer_book_entry",
    "read_signals",
    "mark_signal_read"
  ];
}

export function createMockAgentPlan(agent: Agent, task: SimulationState["tasks"][number]): AgentExecutionPlan {
  const branch = task.branch || `feat/${agent.id}`;
  const safeAgentName = agent.name.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent";
  const docPath = `docs/${task.id}.md`;

	  return {
	    summary: `${safeAgentName} will coordinate through Orvix Book, continue in parallel with explicit assumptions, create branch evidence, and open a PR-style review packet.`,
	    transcript: [
	      {
	        type: "observation",
	        text: `${safeAgentName} is taking ownership of ${task.title}. The work can start now because unresolved contracts can be recorded in Orvix Book instead of blocking the branch.`,
	        beforeToolIndex: 0
	      },
	      {
	        type: "decision",
	        text: "The coordination note goes first, so sibling agents can see the assumption while this agent continues with implementation evidence.",
	        beforeToolIndex: 0
	      },
	      {
	        type: "tool_intent",
	        tool: "create_branch",
	        text: `Next the agent isolates the packet on ${branch}, matching the PR-style workflow.`,
	        beforeToolIndex: 1
	      },
	      {
	        type: "tool_intent",
	        tool: "write_file",
	        path: docPath,
	        text: "The smallest reviewable artifact is a delivery note with acceptance criteria and coordination context.",
	        beforeToolIndex: 2
	      },
	      {
	        type: "tool_intent",
	        tool: "open_pr",
	        text: "After commit, the agent hands the branch to review rather than continuing to grow the scope.",
	        beforeToolIndex: 4
	      }
	    ],
	    toolCalls: [
      {
        tool: "post_book_entry",
        entryType: task.title.toLowerCase().includes("database") || task.title.toLowerCase().includes("schema") ? "contract" : "assumption",
        scope: "task",
        visibility: "mentioned",
        topics: inferTopics(`${task.title} ${task.filesLikelyAffected.join(" ")}`),
        content: `${safeAgentName} is proceeding on ${task.title} in parallel with the rest of the Orvix organization. Any missing dependency is treated as an explicit assumption until another agent answers in Orvix Book. Branch evidence will be published for review.`
      },
      { tool: "create_branch", branch },
      {
        tool: "write_file",
        path: docPath,
        content: [
          `# ${task.title}`,
          "",
          `Owner: ${safeAgentName}`,
          `Branch: ${branch}`,
          "",
          "## Acceptance Criteria",
          "",
          ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
          "",
          "## Delivery Notes",
          "",
          "This file was generated by an Orvix-controlled agent execution loop.",
          "The agent is working in parallel and coordinating unresolved contracts through Orvix Book.",
          ""
        ].join("\n")
      },
      { tool: "commit_changes", message: `feat: ${task.title}` },
      {
        tool: "open_pr",
        title: task.title,
        summary: `${safeAgentName} completed the workspace packet for ${task.title}.`
      }
    ]
  };
}

export function updateAgentTaskState(
  run: MissionRun,
  agentId: string,
  taskId: string,
  status: SimulationState["tasks"][number]["status"],
  activity: string
) {
  run.state = {
    ...run.state,
    phase: "executing",
    tasks: run.state.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
    agents: run.state.agents.map((agent) => agent.id === agentId
      ? {
        ...agent,
        status,
        currentActivity: activity,
        progress: status === "completed" ? 100 : Math.max(agent.progress, status === "blocked" ? 64 : 48),
        confidence: Math.max(agent.confidence, status === "completed" ? 0.86 : 0.72)
      }
      : agent)
  };
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
}

export function updatePullRequestFromTask(
  run: MissionRun,
  task: SimulationState["tasks"][number],
  status: SimulationState["pullRequests"][number]["status"],
  reviewerStatus: SimulationState["pullRequests"][number]["reviewerStatus"],
  patch: Partial<Pick<SimulationState["pullRequests"][number], "title" | "summary">> = {}
) {
  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((pr) => pr.ownerAgentId === task.ownerAgentId && pr.branch === task.branch
      ? {
        ...pr,
        status,
        reviewerStatus,
        title: patch.title ?? pr.title,
        summary: patch.summary ?? pr.summary
      }
      : pr)
  };
}

