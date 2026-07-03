import { writeStateSnapshot, type AgentSignal, type OrvixBookEntry, type PullRequestReviewDecision } from "@orvix/core";
import { isQwenConfigured, QwenClient, withQwenUsageRun } from "@orvix/qwen";
import {
  appendEvent,
  broadcast,
  reviewAttemptLimit,
  runSummary,
  schedulerConcurrency,
  stopScriptedTimers,
  usesQwenReasoning,
  type MissionRun
} from "./run.js";
import { agentName, getBookContext, markSignalRead, postBookEntry } from "./book.js";
import { executeAgentTask, getCompletedTaskIds, getExecutableTasks, getExecutedBranches } from "./agentRuntime.js";
import { escalatePullRequestReview, getReviewAttemptCount, isNonBlockingReviewerPr, reviewPullRequest } from "./review.js";
import { runIncrementalBuildGate, runRuntimeAcceptanceGate, shouldRunRuntimeAcceptance } from "./acceptance.js";

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += Math.max(1, concurrency)) {
    const batch = items.slice(index, index + Math.max(1, concurrency));
    results.push(...await Promise.all(batch.map((item) => worker(item))));
  }
  return results;
}

export async function runSchedulerTurn(run: MissionRun) {
  if (!run.workspace) {
    return {
      ok: true,
      kind: "planning_in_progress",
      result: { reason: "Mission workspace is not created yet; planning pipeline is still running" }
    };
  }

  stopScriptedTimers(run);
  const executedBranches = getExecutedBranches(run);
  const combinedResults: unknown[] = [];
  const combinedKinds: string[] = [];
  const shouldRunAcceptance = shouldRunRuntimeAcceptance(run);
  if (shouldRunAcceptance && !run.state.isComplete) {
    const acceptance = await runRuntimeAcceptanceGate(run);
    if (!acceptance.ok) {
      return {
        ok: true,
        kind: "runtime_acceptance_failed",
        result: acceptance
      };
    }

    run.state = {
      ...run.state,
      phase: "final",
      isComplete: true,
      agents: run.state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 }))
    };
    run.metrics.completedAt = Date.now();
    appendEvent(run, "Scheduler completed mission: required implementation PRs approved and runtime acceptance passed", "success");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "complete", {
      missionId: run.id,
      status: "completed_scheduler"
    });
    return {
      ok: true,
      kind: "complete",
      result: { missionId: run.id }
    };
  }

  const revisionPrs = run.state.pullRequests
    .filter((pr) => pr.status === "Changes requested" && !isNonBlockingReviewerPr(run, pr) && getReviewAttemptCount(run, pr.id) < reviewAttemptLimit)
    .slice(0, 8);
  if (revisionPrs.length > 0) {
    const concurrency = schedulerConcurrency(run, "revision");
    appendEvent(run, `Parallel revision wave (${concurrency}x): ${revisionPrs.map((pr) => `PR #${pr.id}`).join(", ")}`, "info");
    const results = await mapWithConcurrency(revisionPrs, concurrency, async (revisionPr) => {
      const task = run.state.tasks.find((candidate) => candidate.branch === revisionPr.branch && candidate.ownerAgentId === revisionPr.ownerAgentId);
      if (!task) {
        return {
          ok: false,
          error: "revision_task_not_found",
          pr: revisionPr
        };
      }

      appendEvent(run, `MasterMind routed PR #${revisionPr.id} back to ${revisionPr.ownerName} for revision`, "info");
      return executeAgentTask(run, revisionPr.ownerAgentId, {
        taskId: task.id,
        revision: true
      });
    });
    combinedResults.push(...results);
    combinedKinds.push("revision");
  }

  const signals = combinedResults.length > 0 ? [] : run.state.agentSignals.filter((candidate) => candidate.status === "unread").slice(0, 6);
  if (signals.length > 0) {
    appendEvent(run, `Parallel signal wave: ${signals.length} Orvix Book signal${signals.length === 1 ? "" : "s"}`, "info");
    const handled = await Promise.all(signals.map((signal) => handleAgentSignal(run, signal)));
    return {
      ok: true,
      kind: "signal_wave",
      result: handled
    };
  }

  const exhaustedPrs = run.state.pullRequests.filter((pr) =>
    pr.status === "Changes requested" && getReviewAttemptCount(run, pr.id) >= reviewAttemptLimit
  );
  if (exhaustedPrs.length > 0) {
    for (const exhaustedPr of exhaustedPrs) {
      escalatePullRequestReview(run, exhaustedPr, getReviewAttemptCount(run, exhaustedPr.id));
    }
  }

  const reviewablePrs = combinedResults.length > 0 ? [] : run.state.pullRequests
    .filter((pr) =>
      pr.status === "In progress" &&
      executedBranches.has(pr.branch) &&
      getReviewAttemptCount(run, pr.id) < reviewAttemptLimit
    )
    .slice(0, 8);
  if (reviewablePrs.length > 0) {
    const concurrency = schedulerConcurrency(run, "review");
    appendEvent(run, `Parallel review wave (${concurrency}x): ${reviewablePrs.map((pr) => `PR #${pr.id}`).join(", ")}`, "info");
    const results = await mapWithConcurrency(reviewablePrs, concurrency, (pr) => reviewPullRequest(run, pr.id));
    const mergedPrIds = results
      .filter((result): result is typeof result & { approved: boolean; pr: { id: number } } =>
        Boolean((result as { approved?: boolean }).approved && (result as { pr?: { id?: number } }).pr?.id))
      .map((result) => result.pr.id);
    if (mergedPrIds.length > 0) {
      await runIncrementalBuildGate(run, mergedPrIds);
    }
    return {
      ok: results.every((result) => Boolean(result.ok)) || results.some(isRecoverableReviewFailure),
      kind: "review_wave",
      result: results
    };
  }

  const executedTaskIds = getCompletedTaskIds(run);
  const executableTasks = getExecutableTasks(run, executedTaskIds, 8);
  if (executableTasks.length > 0) {
    const concurrency = schedulerConcurrency(run, "execution");
    appendEvent(run, `Parallel execution wave (${concurrency}x): ${executableTasks.map((task) => agentName(run, task.ownerAgentId)).join(", ")}`, "info");
    const results = await mapWithConcurrency(executableTasks, concurrency, (task) => executeAgentTask(run, task.ownerAgentId, { taskId: task.id }));
    combinedResults.push(...results);
    combinedKinds.push("execution");
  }

  if (combinedResults.length > 0) {
    return {
      ok: combinedResults.every((result) => Boolean((result as { ok?: boolean }).ok)),
      kind: `${combinedKinds.join("_")}_wave`,
      result: combinedResults
    };
  }

  const hasUnexecutedTask = run.state.tasks.some((task) => !executedTaskIds.has(task.id));
  if (hasUnexecutedTask) {
    return {
      ok: true,
      kind: "blocked_waiting_dependencies",
      result: { reason: "Remaining tasks are waiting on dependencies or blocked PRs" }
    };
  }

  const allPrsApproved = run.state.pullRequests.length > 0 && run.state.pullRequests.every((pr) => pr.status === "Approved");
  if (allPrsApproved && !run.state.isComplete) {
    const acceptance = await runRuntimeAcceptanceGate(run);
    if (!acceptance.ok) {
      return {
        ok: true,
        kind: "runtime_acceptance_failed",
        result: acceptance
      };
    }

    run.state = {
      ...run.state,
      phase: "final",
      isComplete: true,
      agents: run.state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 }))
    };
    run.metrics.completedAt = Date.now();
    appendEvent(run, "Scheduler completed mission: all executable work approved", "success");
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "complete", {
      missionId: run.id,
      status: "completed_scheduler"
    });
    return {
      ok: true,
      kind: "complete",
      result: { missionId: run.id }
    };
  }

  return {
    ok: true,
    kind: "idle",
    result: { reason: "No pending signals, reviews, or executable tasks" }
  };
}

export function isRecoverableReviewFailure(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return record.error === "merge_failed";
}

export function startAutomaticAutopilot(run: MissionRun) {
  if (run.autoAutopilotStarted) return;
  run.autoAutopilotStarted = true;
  setTimeout(() => {
    void runAutopilot(run, 300, "automatic").catch((error) => {
      appendEvent(run, `Automatic autopilot failed: ${error instanceof Error ? error.message : "Unknown error"}`, "warning");
    });
  }, 250);
}

export async function runAutopilot(run: MissionRun, cycles = 300, source: "manual" | "automatic" = "manual") {
  if (usesQwenReasoning(run) && !run.qwenPlanningComplete) {
    return {
      ok: true,
      cycles: 0,
      turns: [],
      message: "Qwen planning is still running; automatic autopilot will start after planning completes.",
      summary: runSummary(run)
    };
  }

  if (run.autopilotActive) {
    return {
      ok: true,
      cycles: 0,
      turns: [],
      message: "Autopilot is already running",
      summary: runSummary(run)
    };
  }

  run.autopilotActive = true;
  appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot scheduler started`, "info");
  const turns = [];
  try {
    for (let index = 0; index < cycles; index += 1) {
      const turn = await runSchedulerTurn(run);
      turns.push(turn);
      if (turn.kind === "idle" || turn.kind === "complete" || turn.kind === "blocked_waiting_dependencies") {
        break;
      }
    }

    appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot completed ${turns.length} scheduler wave${turns.length === 1 ? "" : "s"}`, "success");
    return {
      ok: true,
      cycles: turns.length,
      turns,
      summary: runSummary(run)
    };
  } finally {
    run.autopilotActive = false;
  }
}

export function isRecoverableSchedulerTurn(turn: { kind?: string; result?: unknown }) {
  if (turn.kind?.includes("execution") || turn.kind?.includes("revision")) return true;
  if (turn.kind !== "review_wave") return false;
  const results = Array.isArray(turn.result) ? turn.result : [];
  return results.some(isRecoverableReviewFailure);
}

export async function handleAgentSignal(run: MissionRun, signal: AgentSignal) {
  const entry = run.state.bookEntries.find((candidate) => candidate.id === signal.bookEntryId);
  if (!entry) {
    markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
    appendEvent(run, `${agentName(run, signal.toAgentId)} ignored stale signal ${signal.id}`, "warning");
    return {
      ok: false,
      signal,
      error: "book_entry_not_found"
    };
  }

  if (entry.type === "question") {
    const answer = await createSignalAnswer(run, signal.toAgentId, entry);
    markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
    if (answer) {
      appendEvent(run, `${agentName(run, signal.toAgentId)} answered ${agentName(run, entry.fromAgentId)} in Orvix Book`, "success");
    }
    return {
      ok: Boolean(answer),
      signal,
      answer
    };
  }

  markSignalRead(run, { signalId: signal.id }, signal.toAgentId);
  appendEvent(run, `${agentName(run, signal.toAgentId)} acknowledged ${entry.type} from Orvix Book`, "info");
  return {
    ok: true,
    signal,
    acknowledged: entry
  };
}

/**
 * Answers a teammate's Orvix Book question as the receiving agent. In qwen
 * mode the answer comes from Qwen with the agent's persona and context; if
 * that fails the question stays open — Orvix does not fabricate answers.
 * Mock mode keeps a deterministic answer for local demos.
 */
export async function createSignalAnswer(run: MissionRun, agentId: string, question: OrvixBookEntry) {
  const agent = run.state.agents.find((candidate) => candidate.id === agentId);
  const ownedTask = run.state.tasks.find((task) => task.ownerAgentId === agentId) ?? null;

  let message: string;
  if (usesQwenReasoning(run) && isQwenConfigured()) {
    try {
      const answer = await withQwenUsageRun(run.id, () => new QwenClient().answerBookQuestionJson({
        mission: run.mission,
        agent: agent ?? { id: agentId, name: agentId, role: "specialist", currentActivity: "", status: "active", progress: 0, confidence: 0.7 },
        ownedTask,
        question,
        bookContext: getBookContext(run, agentId, question.taskId)
      }));
      message = answer.message?.trim() ?? "";
      if (!message) throw new Error("empty_answer");
    } catch (error) {
      appendEvent(
        run,
        `${agent?.name ?? agentId} could not answer ${agentName(run, question.fromAgentId)} yet (${error instanceof Error ? error.message : "Qwen unavailable"}); the question stays open`,
        "warning"
      );
      return null;
    }
  } else {
    const topicText = question.topics.join(", ") || "the requested contract";
    const criteria = ownedTask?.acceptanceCriteria.slice(0, 3).join("; ") || "my acceptance contract";
    message = [
      `${agent?.name ?? agentId} answer for ${topicText}: proceed with your current assumption.`,
      `My owned workstream is ${ownedTask?.title ?? "my assigned task"}.`,
      `Contract I will publish/maintain: ${criteria}.`,
      "If your branch depends on my output, code against this contract now and I will reconcile details in my PR."
    ].join(" ");
  }

  return postBookEntry(run, {
    type: "answer",
    fromAgentId: agentId,
    toAgentIds: [question.fromAgentId],
    message,
    scope: question.scope,
    visibility: "mentioned",
    taskId: question.taskId,
    prId: question.prId,
    replyTo: question.id,
    topics: question.topics,
    priority: question.priority,
    status: "answered"
  });
}

