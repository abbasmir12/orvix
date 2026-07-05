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
import { escalatePullRequestReview, getReviewAttemptCount, isNonBlockingReviewerPr, reviewPullRequest, trySupersedeEmptyDiffPr } from "./review.js";
import { runIncrementalBuildGate, runRuntimeAcceptanceGate, shouldRunRuntimeAcceptance } from "./acceptance.js";
import { envPositiveInt } from "./envConfig.js";

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

function completeMission(run: MissionRun, message: string) {
  run.state = {
    ...run.state,
    phase: "final",
    isComplete: true,
    agents: run.state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 }))
  };
  run.metrics.completedAt = Date.now();
  appendEvent(run, message, "success");
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "complete", {
    missionId: run.id,
    status: "completed_scheduler"
  });
}

type PoolJobKind = "execution" | "revision" | "review" | "signal" | "build";

interface PoolJob {
  key: string;
  kind: PoolJobKind;
  agentId?: string;
  promise: Promise<unknown>;
}

/**
 * Continuous work-pool scheduler. Unlike the wave scheduler (runSchedulerTurn,
 * kept for the manual /scheduler/tick endpoint), revisions, signals, reviews,
 * and executions are all in flight at the same time, and the moment any job
 * finishes its slot is refilled — one slow agent no longer stalls the company.
 *
 * Safety rules encoded here:
 * - one in-flight job per agent (an agent cannot execute and revise at once);
 * - merges stay safe because mergeWorkspaceBranch/syncOpenBranchesAfterMerge
 *   are fully synchronous git call chains (atomic w.r.t. the event loop);
 * - the incremental build gate never overlaps a review job: it waits for
 *   in-flight reviews to finish and blocks new ones while main is building;
 * - the runtime acceptance gate only runs when the pool is fully drained.
 */
export async function runMissionPool(run: MissionRun) {
  stopScriptedTimers(run);
  const inFlight = new Map<string, PoolJob>();
  const pendingBuildPrIds = new Set<number>();
  // Consecutive hard failures (e.g. Qwen unreachable) per job key. Without
  // this, a failing revision session relaunches forever because review
  // attempt counts only advance on completed reviews.
  const jobFailures = new Map<string, number>();
  const failureLimit = 3;
  // Wake-up passes per blocked task before the pool accepts "blocked".
  const wakeCounts = new Map<string, number>();
  const wakeLimit = envPositiveInt("QWEN_BLOCKED_WAKE_LIMIT", 2, 10);
  const totalLimit = envPositiveInt("QWEN_POOL_CONCURRENCY", 6, 16);
  let acceptanceAttempts = 0;
  let jobsCompleted = 0;
  let outcome = "idle";

  const launch = (key: string, kind: PoolJobKind, agentId: string | undefined, work: () => Promise<unknown>) => {
    const promise = (async () => {
      let outcomeOk = false;
      try {
        const result = await work();
        outcomeOk = Boolean((result as { ok?: boolean } | undefined)?.ok);
        return result;
      } catch (error) {
        appendEvent(run, `Scheduler ${kind} job failed: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
        return { ok: false, error };
      } finally {
        jobsCompleted += 1;
        inFlight.delete(key);
        if (outcomeOk) {
          jobFailures.delete(key);
        } else {
          const failures = (jobFailures.get(key) ?? 0) + 1;
          jobFailures.set(key, failures);
          if (failures === failureLimit) {
            appendEvent(run, `Scheduler paused ${key} after ${failures} consecutive failures; it will retry on the next autopilot start`, "warning");
          }
        }
      }
    })();
    inFlight.set(key, { key, kind, agentId, promise });
  };

  const failedOut = (key: string) => (jobFailures.get(key) ?? 0) >= failureLimit;

  const kindCount = (kind: PoolJobKind) => Array.from(inFlight.values()).filter((job) => job.kind === kind).length;

  for (let round = 0; round < 5000; round += 1) {
    if (run.state.isComplete) {
      outcome = "complete";
      break;
    }

    const busyAgents = new Set(Array.from(inFlight.values()).flatMap((job) => job.agentId ? [job.agentId] : []));
    const buildRunning = inFlight.has("build");

    for (const exhaustedPr of run.state.pullRequests.filter((pr) =>
      pr.status === "Changes requested" && getReviewAttemptCount(run, pr.id) >= reviewAttemptLimit
    )) {
      escalatePullRequestReview(run, exhaustedPr, getReviewAttemptCount(run, exhaustedPr.id));
    }

    // Revisions first: unblocking a stuck PR usually unblocks dependents too.
    const revisionCap = schedulerConcurrency(run, "revision");
    for (const pr of run.state.pullRequests) {
      if (inFlight.size >= totalLimit || kindCount("revision") >= revisionCap) break;
      if (pr.status !== "Changes requested") continue;
      // Supersede applies to every changes-requested PR — including
      // non-blocking reviewer PRs, whose approval unblocks tasks that
      // declared a dependency on their owner.
      if (busyAgents.has(pr.ownerAgentId)) continue;
      if (trySupersedeEmptyDiffPr(run, pr)) continue;
      if (isNonBlockingReviewerPr(run, pr)) continue;
      if (getReviewAttemptCount(run, pr.id) >= reviewAttemptLimit) continue;
      const key = `revision:${pr.id}`;
      if (inFlight.has(key) || failedOut(key)) continue;
      const task = run.state.tasks.find((candidate) => candidate.branch === pr.branch && candidate.ownerAgentId === pr.ownerAgentId);
      if (!task) continue;
      busyAgents.add(pr.ownerAgentId);
      appendEvent(run, `MasterMind routed PR #${pr.id} back to ${pr.ownerName} for revision`, "info");
      launch(key, "revision", pr.ownerAgentId, () => executeAgentTask(run, pr.ownerAgentId, { taskId: task.id, revision: true }));
    }

    for (const signal of run.state.agentSignals) {
      if (inFlight.size >= totalLimit || kindCount("signal") >= 4) break;
      if (signal.status !== "unread") continue;
      const key = `signal:${signal.id}`;
      if (inFlight.has(key) || busyAgents.has(signal.toAgentId)) continue;
      busyAgents.add(signal.toAgentId);
      launch(key, "signal", signal.toAgentId, () => handleAgentSignal(run, signal));
    }

    const executedBranches = getExecutedBranches(run);
    if (!buildRunning) {
      const reviewCap = schedulerConcurrency(run, "review");
      for (const pr of run.state.pullRequests) {
        if (inFlight.size >= totalLimit || kindCount("review") >= reviewCap) break;
        if (pr.status !== "In progress" || !executedBranches.has(pr.branch)) continue;
        if (getReviewAttemptCount(run, pr.id) >= reviewAttemptLimit) continue;
        const key = `review:${pr.id}`;
        if (inFlight.has(key) || failedOut(key)) continue;
        launch(key, "review", undefined, async () => {
          const result = await reviewPullRequest(run, pr.id) as { approved?: boolean; superseded?: boolean };
          if (result.approved && !result.superseded) {
            pendingBuildPrIds.add(pr.id);
          }
          return result;
        });
      }
    }

    const executionCap = schedulerConcurrency(run, "execution");
    for (const task of getExecutableTasks(run, getCompletedTaskIds(run), 16)) {
      if (inFlight.size >= totalLimit || kindCount("execution") >= executionCap) break;
      const key = `execution:${task.id}`;
      if (inFlight.has(key) || busyAgents.has(task.ownerAgentId) || failedOut(key)) continue;
      busyAgents.add(task.ownerAgentId);
      launch(key, "execution", task.ownerAgentId, () => executeAgentTask(run, task.ownerAgentId, { taskId: task.id }));
    }

    // Build gate on main runs only once merges have settled, and blocks new
    // reviews (and their merges) while npm builds the merged tree.
    if (pendingBuildPrIds.size > 0 && !buildRunning && kindCount("review") === 0) {
      const mergedIds = Array.from(pendingBuildPrIds);
      pendingBuildPrIds.clear();
      launch("build", "build", undefined, () => runIncrementalBuildGate(run, mergedIds));
    }

    if (inFlight.size > 0) {
      await Promise.race(Array.from(inFlight.values()).map((job) => job.promise));
      continue;
    }

    // Pool drained: nothing runnable right now. Decide whether the mission is
    // done, blocked, or ready for the runtime acceptance gate.
    if (shouldRunRuntimeAcceptance(run)) {
      acceptanceAttempts += 1;
      if (acceptanceAttempts > 6) {
        appendEvent(run, "Runtime acceptance failed repeatedly; stopping the scheduler pool for MasterMind/human review", "warning");
        outcome = "acceptance_exhausted";
        break;
      }
      const acceptance = await runRuntimeAcceptanceGate(run);
      if (acceptance.ok) {
        completeMission(run, "Scheduler completed mission: required implementation PRs approved and runtime acceptance passed");
        outcome = "complete";
        break;
      }
      // Findings were routed back as revisions; keep the pool running.
      continue;
    }

    // MasterMind wake-up pass: a blocked workstream must never silently
    // stall a live mission. Before concluding "blocked", give each blocked
    // task (whose PR has not landed) up to two fresh sessions: re-queue it,
    // tell the owner exactly why it was blocked and what evidence the next
    // session must produce, and go around the loop again.
    const executedTaskIds = getCompletedTaskIds(run);
    let wokenThisRound = 0;
    for (const task of run.state.tasks) {
      if (executedTaskIds.has(task.id) || task.status !== "blocked") continue;
      const ownedPr = run.state.pullRequests.find((pr) => pr.branch === task.branch && pr.ownerAgentId === task.ownerAgentId);
      if (ownedPr?.status === "Approved") continue;
      const wakes = wakeCounts.get(task.id) ?? 0;
      if (wakes >= wakeLimit) continue;
      wakeCounts.set(task.id, wakes + 1);
      jobFailures.delete(`execution:${task.id}`);
      const owner = run.state.agents.find((candidate) => candidate.id === task.ownerAgentId);
      const blockReason = owner?.currentActivity || "blocked without a recorded reason";
      postBookEntry(run, {
        type: "decision",
        fromAgentId: "mastermind-agent",
        toAgentIds: [task.ownerAgentId],
        taskId: task.id,
        scope: "task",
        visibility: "mentioned",
        topics: ["wake-up", "blocked-recovery", task.id],
        priority: "urgent",
        status: "final",
        message: [
          `Wake-up call (${wakes + 1}/${wakeLimit}): your workstream "${task.title}" was blocked (${blockReason}) and the rest of the organization has drained — you are the critical path.`,
          "Start this session with implementation, not investigation: your FIRST tool calls must write_file the concrete files from your work packet, then commit_changes and open_pr.",
          "If something genuinely prevents implementation, post_book_entry a question naming the exact blocker instead of ending the session empty."
        ].join(" ")
      });
      run.state = {
        ...run.state,
        tasks: run.state.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, status: "queued" } : candidate),
        agents: run.state.agents.map((candidate) => candidate.id === task.ownerAgentId && candidate.status !== "completed"
          ? { ...candidate, status: "queued", currentActivity: "Woken by MasterMind after block" }
          : candidate)
      };
      appendEvent(run, `MasterMind woke ${owner?.name ?? task.ownerAgentId} (wake ${wakes + 1}/${wakeLimit}): blocked workstream "${task.title}" re-queued`, "warning");
      wokenThisRound += 1;
    }
    if (wokenThisRound > 0) {
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      continue;
    }

    if (run.state.tasks.some((task) => !executedTaskIds.has(task.id))) {
      outcome = "blocked_waiting_dependencies";
      break;
    }
    outcome = "idle";
    break;
  }

  return { outcome, jobsCompleted };
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
  appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot started the continuous scheduler pool`, "info");
  try {
    const pool = await runMissionPool(run);
    appendEvent(run, `${source === "automatic" ? "Automatic" : "Manual"} autopilot pool finished (${pool.jobsCompleted} job${pool.jobsCompleted === 1 ? "" : "s"}, ${pool.outcome})`, "success");
    return {
      ok: true,
      cycles: pool.jobsCompleted,
      turns: [{ ok: true, kind: pool.outcome, result: pool }],
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

