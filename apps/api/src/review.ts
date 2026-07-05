import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  writeStateSnapshot,
  type PullRequest,
  type PullRequestReviewDecision,
  type SimulationState
} from "@orvix/core";
import { isQwenConfigured, QwenClient, withQwenUsageRun } from "@orvix/qwen";
import {
  branchExists,
  getBranchDiff,
  getGitStatus,
  listWorkspaceFiles,
  mergeWorkspaceBranch,
  syncWorkspaceBranch,
  type Workspace
} from "@orvix/workspace";
import {
  addReasoningArtifact,
  appendEvent,
  broadcast,
  orvixMapContext,
  reviewAttemptLimit,
  usesQwenReasoning,
  workspaceOf,
  type MissionRun
} from "./run.js";
import { createAgentSignal, postBookEntry } from "./book.js";
import { agentTaskWorkspace } from "./agentRuntime.js";

export function changedFilesFromDiff(diff: string) {
  return Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)).map((match) => match[2]).filter(Boolean);
}

export function implementationTaskRequiresSource(task?: SimulationState["tasks"][number]) {
  if (!task) return true;
  const text = `${task.title} ${task.filesLikelyAffected.join(" ")} ${task.acceptanceCriteria.join(" ")}`.toLowerCase();
  return /src\/|app\/|component|ui|game|loop|state|style|css|test|config|package|route|api|implementation|playable|canvas/.test(text);
}

export function createStaticPrReviewDecision(
  run: MissionRun,
  pr: PullRequest,
  diff: string,
  task?: SimulationState["tasks"][number]
): PullRequestReviewDecision | null {
  const changedFiles = changedFilesFromDiff(diff);
  if (changedFiles.length === 0) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} has an empty diff.`,
      comments: ["The branch has no reviewable source/config/test/style changes. Re-run the task and write the files from the Orvix Map packet."],
      risks: ["Empty PRs cannot advance the generated product."]
    };
  }

  const sourceLike = changedFiles.filter((file) =>
    /^(src|app|components|lib|tests|test|styles|public)\//.test(file) ||
    /(^|\/)(package\.json|vite\.config\.[tj]s|tsconfig\.json|tailwind\.config\.[tj]s|next\.config\.[tj]s)$/.test(file)
  );
  const markdownOnly = changedFiles.every((file) => /\.(md|mdx|txt)$/i.test(file) || /^(docs|work)\//.test(file));
  if (usesQwenReasoning(run) && !isNonBlockingReviewerPr(run, pr) && implementationTaskRequiresSource(task) && markdownOnly && sourceLike.length === 0) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} only changes documentation/work notes, not implementation files.`,
      comments: [
        "Implementation packets must modify source, style, config, test, or route files.",
        "Use write_file/delete_file on the concrete files listed in the Orvix Map work packet before opening the PR."
      ],
      risks: ["Markdown-only work can look complete while leaving the runnable project unchanged."]
    };
  }

  if (workspaceOf(run).projectType === "react-vite") {
    const packagePath = resolve(workspaceOf(run).repoDir, "package.json");
    const packageJson = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
    const buildUsesTsc = /"build"\s*:\s*"[^"]*\btsc\b/.test(packageJson);
    const jsSourceFiles = changedFiles.filter((file) => /^src\/.+\.jsx?$/.test(file));
    const tsConfigExists = existsSync(resolve(workspaceOf(run).repoDir, "tsconfig.json"));
    if (buildUsesTsc && jsSourceFiles.length > 0 && !changedFiles.includes("package.json") && !tsConfigExists) {
      return {
        decision: "request_changes",
        summary: `PR #${pr.id} writes JavaScript files into a TypeScript Vite scaffold without aligning the build config.`,
        comments: [
          `Changed JS files: ${jsSourceFiles.join(", ")}.`,
          "Either use .ts/.tsx files that match the scaffold, restore/provide tsconfig.json, or update package.json build scripts coherently in the same PR."
        ],
        risks: ["The generated app can look playable in source but fail npm run build."]
      };
    }
  }

  return null;
}

export async function reviewPullRequest(run: MissionRun, prId: number) {
  const pr = run.state.pullRequests.find((candidate) => candidate.id === prId);
  if (!pr) {
    return {
      ok: false,
      error: "pr_not_found"
    };
  }

  if (pr.status !== "In progress") {
    return {
      ok: false,
      error: `pr_not_reviewable:${pr.status}`
    };
  }

  if (trySupersedeEmptyDiffPr(run, pr)) {
    return {
      ok: true,
      pr,
      approved: true,
      superseded: true
    };
  }

  const attemptCount = getReviewAttemptCount(run, pr.id);
  if (attemptCount >= reviewAttemptLimit) {
    const result = escalatePullRequestReview(run, pr, attemptCount);
    return {
      ok: false,
      pr,
      decision: result.decision,
      error: "review_attempt_limit_reached"
    };
  }

  const exists = branchExists(workspaceOf(run), pr.branch);
  if (!exists.ok || exists.tool !== "branch_exists" || !exists.exists) {
    const decision: PullRequestReviewDecision = {
      decision: "request_changes",
      summary: `PR #${pr.id} cannot be reviewed because branch ${pr.branch} does not exist.`,
      comments: ["Owner must create the task branch and commit reviewable evidence before requesting review."],
      risks: ["Review cannot inspect missing branch work."]
    };
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", decision);
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: missing branch ${pr.branch}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "failed",
      content: JSON.stringify({
        pr,
        decision
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: false,
      pr,
      decision,
      error: "branch_missing"
    };
  }

  const diff = getBranchDiff(workspaceOf(run), pr.branch, "main");
  if (!diff.ok) {
    appendEvent(run, `Critic Council could not diff ${pr.branch}: ${diff.error}`, "warning");
    return diff;
  }
  if (diff.tool !== "get_diff") {
    return {
      ok: false,
      error: "unexpected_diff_result"
    };
  }

  const ownerAgent = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
  const ownerTask = run.state.tasks.find((task) => task.branch === pr.branch && task.ownerAgentId === pr.ownerAgentId);
  const reviewWorkspace = ownerAgent && ownerTask ? agentTaskWorkspace(run, ownerAgent, ownerTask) : workspaceOf(run);
  const files = "ok" in reviewWorkspace && !reviewWorkspace.ok ? listWorkspaceFiles(workspaceOf(run)) : listWorkspaceFiles(reviewWorkspace as Workspace);
  const staticDecision = createStaticPrReviewDecision(run, pr, diff.output, ownerTask);
  if (staticDecision) {
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", staticDecision);
    run.state = {
      ...run.state,
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Addressing deterministic review gate", progress: Math.max(agent.progress, 70) }
        : agent)
    };
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: ${staticDecision.summary}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "completed",
      content: JSON.stringify({
        pr,
        diff: diff.output,
        decision: staticDecision,
        deterministic: true
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
    return {
      ok: true,
      pr,
      decision: staticDecision,
      approved: false,
      git: getGitStatus(workspaceOf(run))
    };
  }
  const decision = usesQwenReasoning(run) && isQwenConfigured()
    ? await withQwenUsageRun(run.id, () => new QwenClient().reviewWorkspacePullRequestJson({
      mission: run.mission,
      pr,
      diff: diff.output,
      files,
      reviewAttempt: attemptCount + 1,
      reviewAttemptLimit,
      organization: run.state.organization,
      // Token diet: the reviewer judges this PR's diff against the map and
      // its task; other agents/tasks/PRs only matter as a roster.
      agents: run.state.agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })) as never,
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? task : {
        id: task.id,
        title: task.title,
        status: task.status,
        branch: task.branch,
        ownerAgentId: task.ownerAgentId
      }) as never,
      pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id ? candidate : {
        id: candidate.id,
        status: candidate.status,
        ownerAgentId: candidate.ownerAgentId,
        branch: candidate.branch
      }) as never,
      orvixMap: orvixMapContext(run),
      orvixBook: {
        entries: run.state.bookEntries.slice(-15),
        signals: run.state.agentSignals.slice(-15),
        ownershipIndex: run.state.ownershipIndex
      }
    }))
    : createMockReviewDecision(pr, diff.output);

  const approved = decision.decision === "approve";
  if (approved) {
    const merge = mergeWorkspaceBranch(workspaceOf(run), pr.branch, "main");
    if (!merge.ok) {
      const conflictDecision: PullRequestReviewDecision = {
        decision: "request_changes",
        summary: `PR #${pr.id} was approved but could not merge cleanly.`,
        comments: [
          `Git merge failed for ${pr.branch}: ${merge.error}`,
          "Resolve conflicting files on the branch, preserve both useful changes, and reopen the PR for review."
        ],
        risks: ["A failed merge can leave the generated project inconsistent if it is not routed through revision."]
      };
      updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", conflictDecision);
      routeMergeFailureToMasterMind(run, pr, merge.error);
      addReasoningArtifact(run, {
        kind: "pr_review",
        status: "failed",
        content: JSON.stringify({
          pr,
          decision: conflictDecision,
          merge
        })
      });
      writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
      broadcast(run, "state", run.state);
      return {
        ok: false,
        pr,
        decision: conflictDecision,
        error: "merge_failed"
      };
    }

    updateReviewedPullRequest(run, pr, "Approved", "Approved", decision);
    appendEvent(run, `Critic Council approved and merged PR #${pr.id}: ${decision.summary}`, "success");
    syncOpenBranchesAfterMerge(run, pr, changedFilesFromDiff(diff.output));
  } else {
    updateReviewedPullRequest(run, pr, "Changes requested", "Requested changes", decision);
    run.state = {
      ...run.state,
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Addressing reviewer comments", progress: Math.max(agent.progress, 70) }
        : agent)
    };
    appendEvent(run, `Critic Council requested changes on PR #${pr.id}: ${decision.summary}`, "warning");
  }

  addReasoningArtifact(run, {
    kind: "pr_review",
    status: "completed",
    content: JSON.stringify({
      pr,
      diff: diff.output,
      decision
    })
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);

  return {
    ok: true,
    pr,
    decision,
    approved,
    git: getGitStatus(workspaceOf(run))
  };
}

export async function reviewNextPullRequest(run: MissionRun) {
  const nextPr = run.state.pullRequests.find((pr) => pr.status === "In progress" && getReviewAttemptCount(run, pr.id) < reviewAttemptLimit);

  if (!nextPr) {
    return {
      ok: false,
      error: "no_reviewable_pr"
    };
  }

  return reviewPullRequest(run, nextPr.id);
}

export function isNonBlockingReviewerPr(run: MissionRun, pr: PullRequest) {
  // Classify by the OWNER's identity only. PR titles are agent-written free
  // text — "fix: address reviewer feedback" once got an implementation PR
  // classified as a reviewer PR, making it invisible to revisions, reviews,
  // and supersede at once (a hard deadlock).
  const agent = run.state.agents.find((candidate) => candidate.id === pr.ownerAgentId);
  const text = `${agent?.name ?? ""} ${agent?.role ?? ""} ${pr.ownerName}`.toLowerCase();
  return /runtime qa|qa reviewer|quality gate|critic|reviewer|validator|test reviewer/.test(text);
}

export function createMockReviewDecision(pr: PullRequest, diff: string): PullRequestReviewDecision {
  if (!diff.trim()) {
    return {
      decision: "request_changes",
      summary: `PR #${pr.id} has no diff against main.`,
      comments: ["No workspace changes were found for review."],
      risks: ["Empty PR cannot satisfy acceptance criteria."]
    };
  }

  return {
    decision: "approve",
    summary: `PR #${pr.id} satisfies the current acceptance packet.`,
    comments: ["Diff contains committed workspace evidence.", "Acceptance criteria are represented in the delivery note."],
    risks: []
  };
}

/**
 * A PR whose branch has an empty diff against main is already fully
 * represented there — its work landed via earlier merges or branch syncs.
 * Re-reviewing or revising it can only loop (the agent has nothing left to
 * change), so MasterMind approves it as superseded instead of burning agent
 * sessions. Never applies while main needs fixes: after a failed build gate
 * or runtime acceptance, an empty-diff PR may belong to the owner who still
 * owes a fix commit, and superseding it would orphan the break.
 */
export function trySupersedeEmptyDiffPr(run: MissionRun, pr: PullRequest) {
  if (run.mainNeedsFixes) return false;
  // "Reviewed at least once" gate: attempt counts are parsed from artifact
  // content, which disk snapshots summarize away — after a resume they read
  // zero. PR comments survive snapshots, so either signal counts.
  if (getReviewAttemptCount(run, pr.id) < 1 && pr.comments.length === 0) return false;
  const exists = branchExists(workspaceOf(run), pr.branch);
  if (!exists.ok || exists.tool !== "branch_exists" || !exists.exists) return false;
  const diff = getBranchDiff(workspaceOf(run), pr.branch, "main");
  if (!diff.ok || diff.tool !== "get_diff") return false;
  if (changedFilesFromDiff(diff.output).length > 0) return false;

  const decision: PullRequestReviewDecision = {
    decision: "approve",
    summary: `PR #${pr.id} is superseded: its branch has no remaining diff against main, so this work already landed.`,
    comments: ["MasterMind approved this PR as superseded instead of requesting another revision of already-merged work."],
    risks: []
  };
  updateReviewedPullRequest(run, pr, "Approved", "Approved", decision);
  appendEvent(run, `MasterMind approved PR #${pr.id} as superseded (empty diff against a green main)`, "success");
  addReasoningArtifact(run, {
    kind: "pr_review",
    status: "completed",
    content: JSON.stringify({ pr, decision, superseded: true })
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return true;
}

/**
 * Routes a live instruction from the human owner into the organization.
 * The message lands in the Orvix Book as the `owner` identity with
 * MasterMind always included; each specifically mentioned agent that
 * already has a workstream gets its PR reopened as "Changes requested"
 * with the owner's words as the review comment, so the normal revision
 * loop applies the change. Agents without a PR yet simply see the entry
 * in their next session context.
 */
export function routeOwnerInstruction(run: MissionRun, message: string, mentionAgentIds: string[] = []) {
  const validMentions = mentionAgentIds.filter((id) => run.state.agents.some((agent) => agent.id === id) && id !== "mastermind-agent");
  const toAgentIds = Array.from(new Set(["mastermind-agent", ...validMentions]));
  const isQuestion = /\?\s*$/.test(message.trim());

  const entry = postBookEntry(run, {
    type: isQuestion ? "question" : "decision",
    fromAgentId: "owner",
    toAgentIds,
    scope: "mission",
    visibility: validMentions.length > 0 ? "mentioned" : "global",
    topics: ["owner", "user-guidance", ...validMentions],
    priority: "urgent",
    status: isQuestion ? "open" : "final",
    message: `Owner: ${message}`
  });

  const reopened: number[] = [];
  if (!isQuestion) {
    for (const agentId of validMentions) {
      const pr = run.state.pullRequests.find((candidate) =>
        candidate.ownerAgentId === agentId && candidate.status !== "Queued");
      if (!pr) continue;
      run.state = {
        ...run.state,
        pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
          ? {
            ...candidate,
            status: "Changes requested",
            reviewerStatus: "Requested changes",
            comments: [...candidate.comments, `Owner request: ${message}`].slice(-6)
          }
          : candidate),
        agents: run.state.agents.map((candidate) => candidate.id === agentId && candidate.status === "completed"
          ? { ...candidate, status: "queued", currentActivity: "Owner change request received", progress: Math.min(candidate.progress, 90) }
          : candidate)
      };
      reopened.push(pr.id);
    }
    if (reopened.length > 0 && run.state.isComplete) {
      run.state = { ...run.state, isComplete: false, phase: "executing" };
    }
  }

  appendEvent(
    run,
    `Owner posted ${isQuestion ? "a question" : "an instruction"} to ${validMentions.length > 0 ? validMentions.join(", ") : "the whole organization"}${reopened.length > 0 ? `; reopened PR${reopened.length === 1 ? "" : "s"} ${reopened.map((id) => `#${id}`).join(", ")}` : ""}`,
    "info"
  );
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return { entry, reopened, mentioned: validMentions };
}

/** Reopens one agent's workstream with an instruction as the review comment; returns the PR id or null. */
function reopenAgentWorkstream(run: MissionRun, agentId: string, instruction: string) {
  const pr = run.state.pullRequests.find((candidate) => candidate.ownerAgentId === agentId && candidate.status !== "Queued");
  if (!pr) return null;
  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
      ? {
        ...candidate,
        status: "Changes requested",
        reviewerStatus: "Requested changes",
        comments: [...candidate.comments, `Owner request via MasterMind: ${instruction}`].slice(-6)
      }
      : candidate),
    agents: run.state.agents.map((candidate) => candidate.id === agentId && candidate.status === "completed"
      ? { ...candidate, status: "queued", currentActivity: "Owner change request received", progress: Math.min(candidate.progress, 90) }
      : candidate)
  };
  return pr.id;
}

/**
 * Wakes MasterMind as a reasoning agent for an owner request that named no
 * specific agent — including on a completed mission, where the whole
 * organization is asleep. MasterMind reads the org state, decides which
 * agent(s) own the change, posts each a contract in the Orvix Book, and
 * reopens their workstreams so the scheduler pool revises them. If the
 * MasterMind call fails, the owner entry stays as global guidance.
 */
export async function masterMindOwnerTriage(run: MissionRun, ownerMessage: string) {
  if (!usesQwenReasoning(run) || !isQwenConfigured()) return { assignments: 0 };
  appendEvent(run, "MasterMind woke to triage the owner's request", "info");
  let routing: { summary: string; assignments: Array<{ agentId: string; instruction: string }> };
  try {
    routing = await withQwenUsageRun(run.id, () => new QwenClient().routeOwnerRequestJson({
      mission: run.mission,
      ownerMessage,
      agents: run.state.agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, status: agent.status })),
      tasks: run.state.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, branch: task.branch, ownerAgentId: task.ownerAgentId })),
      pullRequests: run.state.pullRequests.map((pr) => ({ id: pr.id, status: pr.status, ownerAgentId: pr.ownerAgentId, branch: pr.branch })),
      orvixMap: orvixMapContext(run)
    }));
  } catch (error) {
    appendEvent(run, `MasterMind triage failed (${error instanceof Error ? error.message : "unknown"}); owner request stays as global guidance`, "warning");
    return { assignments: 0 };
  }

  const valid = (routing.assignments ?? []).filter((assignment) =>
    run.state.agents.some((agent) => agent.id === assignment.agentId) && assignment.instruction?.trim());
  const reopened: number[] = [];
  for (const assignment of valid) {
    postBookEntry(run, {
      type: "contract",
      fromAgentId: "mastermind-agent",
      toAgentIds: [assignment.agentId],
      scope: "mission",
      visibility: "mentioned",
      topics: ["owner", "delegation", assignment.agentId],
      priority: "urgent",
      status: "final",
      message: `MasterMind routing the owner's request to you: ${assignment.instruction}`
    });
    const prId = reopenAgentWorkstream(run, assignment.agentId, assignment.instruction);
    if (prId !== null) reopened.push(prId);
  }

  if (reopened.length > 0 && run.state.isComplete) {
    run.state = { ...run.state, isComplete: false, phase: "executing" };
  }
  appendEvent(
    run,
    valid.length > 0
      ? `MasterMind routed the owner's request: ${routing.summary} (${valid.map((a) => a.agentId).join(", ")}${reopened.length > 0 ? `; reopened PR ${reopened.map((id) => `#${id}`).join(", ")}` : ""})`
      : `MasterMind triaged the owner's request: ${routing.summary || "no code change needed"}`,
    "success"
  );
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);
  return { assignments: valid.length, reopened };
}

export function updateReviewedPullRequest(
  run: MissionRun,
  pr: PullRequest,
  status: PullRequest["status"],
  reviewerStatus: PullRequest["reviewerStatus"],
  decision: PullRequestReviewDecision
) {
  run.state = {
    ...run.state,
    pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
      ? {
        ...candidate,
        status,
        reviewerStatus,
        comments: [...candidate.comments, decision.summary, ...decision.comments].slice(-6)
      }
      : candidate),
    tasks: run.state.tasks.map((task) => task.branch === pr.branch && status === "Approved"
      ? { ...task, status: "completed" }
      : task),
    agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId && status === "Approved"
      ? { ...agent, status: "completed", currentActivity: "PR approved and merged", progress: 100, confidence: Math.max(agent.confidence, 0.88) }
      : agent)
  };
}

export function routeMergeFailureToMasterMind(run: MissionRun, pr: PullRequest, error: string) {
  const owner = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
  const entry = postBookEntry(run, {
    type: "conflict",
    fromAgentId: "mastermind-agent",
    toAgentIds: owner ? [owner.id] : [],
    prId: pr.id,
    scope: "pr",
    visibility: owner ? "mentioned" : "global",
    topics: ["merge-conflict", "git", pr.branch],
    priority: "urgent",
    status: "open",
    message: [
      `Merge conflict detected on PR #${pr.id} (${pr.branch}).`,
      `Git reported: ${error}`,
      "MasterMind aborted the failed merge to keep main clean.",
      "Owner must revise the branch by reconciling conflicting files, especially shared config such as package.json, then request review again."
    ].join("\n")
  });

  if (owner) {
    createAgentSignal(run, {
      toAgentId: owner.id,
      fromAgentId: "mastermind-agent",
      bookEntryId: entry.id,
      type: "conflict",
      message: `Wake up: PR #${pr.id} has a merge conflict that must be resolved before final approval.`
    });
  }

  run.state = {
    ...run.state,
    tasks: run.state.tasks.map((task) => task.branch === pr.branch
      ? { ...task, status: "blocked" }
      : task),
    agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
      ? { ...agent, status: "blocked", currentActivity: "Resolving merge conflict", progress: Math.max(agent.progress, 82) }
      : agent.id === "mastermind-agent"
        ? { ...agent, status: "active", currentActivity: "Routing merge conflict", progress: Math.max(agent.progress, 88) }
        : agent)
  };

  appendEvent(run, `MasterMind routed merge conflict on PR #${pr.id} to ${pr.ownerName}`, "warning");
}

export function syncOpenBranchesAfterMerge(run: MissionRun, mergedPr: PullRequest, mergedFiles: string[] = []) {
  const openPrs = run.state.pullRequests.filter((pr) =>
    pr.id !== mergedPr.id &&
    pr.status !== "Approved" &&
    pr.branch !== mergedPr.branch
  );
  if (openPrs.length === 0) return;

  let synced = 0;
  for (const pr of openPrs) {
    const owner = run.state.agents.find((agent) => agent.id === pr.ownerAgentId);
    const task = run.state.tasks.find((candidate) => candidate.branch === pr.branch && candidate.ownerAgentId === pr.ownerAgentId);
    if (!owner || !task) continue;

    // Every merge used to trigger a sync of every open branch — N agents meant
    // N-1 extra merges per landing, cascading into conflict churn. Only sync
    // branches that actually consume the merged work: their task depends on
    // the merged agent, or they touch the same files (getBranchDiff is a
    // three-dot diff, so an unsynced branch still reviews correctly).
    if (mergedFiles.length > 0 && !task.dependsOnAgentIds.includes(mergedPr.ownerAgentId)) {
      const branchDiff = getBranchDiff(workspaceOf(run), pr.branch, "main");
      if (branchDiff.ok && branchDiff.tool === "get_diff") {
        const branchFiles = changedFilesFromDiff(branchDiff.output);
        if (!branchFiles.some((file) => mergedFiles.includes(file))) continue;
      }
    }

    const workspace = agentTaskWorkspace(run, owner, task);
    if ("ok" in workspace && !workspace.ok) {
      continue;
    }

    const sync = syncWorkspaceBranch(workspace as Workspace, pr.branch, "main");
    if (sync.ok) {
      synced += 1;
      postBookEntry(run, {
        type: "contract",
        fromAgentId: "mastermind-agent",
        toAgentIds: [owner.id],
        prId: pr.id,
        scope: "pr",
        visibility: "mentioned",
        topics: ["branch-sync", "main", pr.branch],
        priority: "normal",
        status: "final",
        message: `Main changed after PR #${mergedPr.id} merged. MasterMind synced ${pr.branch} with main so ${owner.name} can continue from the latest baseline.`
      });
      continue;
    }

    const entry = postBookEntry(run, {
      type: "conflict",
      fromAgentId: "mastermind-agent",
      toAgentIds: [owner.id],
      prId: pr.id,
      scope: "pr",
      visibility: "mentioned",
      topics: ["branch-sync", "main", "conflict", pr.branch],
      priority: "urgent",
      status: "open",
      message: [
        `Main changed after PR #${mergedPr.id} merged, but ${pr.branch} could not sync cleanly.`,
        `Git reported: ${sync.error}`,
        "Continue from the current branch, resolve conflicts against main, and reopen review when clean."
      ].join("\n")
    });
    createAgentSignal(run, {
      toAgentId: owner.id,
      fromAgentId: "mastermind-agent",
      bookEntryId: entry.id,
      type: "conflict",
      message: `Wake up: ${pr.branch} needs sync conflict resolution after main changed.`
    });
    run.state = {
      ...run.state,
      pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
        ? {
            ...candidate,
            status: "Changes requested",
            reviewerStatus: "Requested changes",
            comments: [...candidate.comments, "Branch sync conflict after main changed."].slice(-6)
          }
        : candidate),
      tasks: run.state.tasks.map((candidate) => candidate.branch === pr.branch ? { ...candidate, status: "blocked" } : candidate),
      agents: run.state.agents.map((candidate) => candidate.id === owner.id
        ? { ...candidate, status: "blocked", currentActivity: "Resolving branch sync conflict", progress: Math.max(candidate.progress, 78) }
        : candidate)
    };
  }

  if (synced > 0) {
    appendEvent(run, `MasterMind synced ${synced} open branch${synced === 1 ? "" : "es"} after PR #${mergedPr.id} updated main`, "success");
  }
}

export function escalatePullRequestReview(run: MissionRun, pr: PullRequest, attemptCount: number) {
  const alreadyEscalated = pr.comments.some((comment) => comment.includes("MasterMind escalation"));
  const decision: PullRequestReviewDecision = {
    decision: "request_changes",
    summary: `MasterMind escalation: PR #${pr.id} reached ${attemptCount} review attempts without approval.`,
    comments: [
      "The reviewer has coached this PR many times; MasterMind should now revise scope, split the task, or approve remaining gaps as follow-up work.",
      "A human or MasterMind conflict-resolution turn should decide whether to reduce scope, reassign ownership, or convert unresolved items into new tasks."
    ],
    risks: ["Continuing automatic review without a changed strategy can hide a real delivery issue."]
  };

  if (!alreadyEscalated) {
    run.state = {
      ...run.state,
      pullRequests: run.state.pullRequests.map((candidate) => candidate.id === pr.id
        ? {
          ...candidate,
          status: "Changes requested",
          reviewerStatus: "Requested changes",
          comments: [...candidate.comments, decision.summary, ...decision.comments].slice(-6)
        }
        : candidate),
      tasks: run.state.tasks.map((task) => task.branch === pr.branch ? { ...task, status: "blocked" } : task),
      agents: run.state.agents.map((agent) => agent.id === pr.ownerAgentId
        ? { ...agent, status: "blocked", currentActivity: "Escalated to MasterMind", progress: Math.max(agent.progress, 76) }
        : agent)
    };
    appendEvent(run, `MasterMind escalated PR #${pr.id} after ${attemptCount} review attempts: ${decision.comments[0]}`, "warning");
    addReasoningArtifact(run, {
      kind: "pr_review",
      status: "failed",
      content: JSON.stringify({
        pr,
        decision,
        escalated: true
      })
    });
    writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
    broadcast(run, "state", run.state);
  }

  return {
    ok: false,
    pr,
    decision,
    error: "review_attempt_limit_reached"
  };
}

export function getReviewAttemptCount(run: MissionRun, prId: number) {
  let count = 0;
  for (const artifact of run.reasoningArtifacts) {
    if (artifact.kind !== "pr_review" || !artifact.content) {
      continue;
    }

    try {
      const parsed = JSON.parse(artifact.content) as { pr?: { id?: number } };
      if (parsed.pr?.id === prId) {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

