import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  writeStateSnapshot,
  type PullRequest,
  type PullRequestReviewDecision,
  type SimulationState
} from "@orvix/core";
import { isQwenConfigured, QwenClient } from "@orvix/qwen";
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
  if (run.mode === "qwen" && !isNonBlockingReviewerPr(run, pr) && implementationTaskRequiresSource(task) && markdownOnly && sourceLike.length === 0) {
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
  const decision = run.mode === "qwen" && isQwenConfigured()
    ? await new QwenClient().reviewWorkspacePullRequestJson({
      mission: run.mission,
      pr,
      diff: diff.output,
      files,
      reviewAttempt: attemptCount + 1,
      reviewAttemptLimit,
      organization: run.state.organization,
      agents: run.state.agents,
      tasks: run.state.tasks,
      pullRequests: run.state.pullRequests,
      orvixMap: orvixMapContext(run),
      orvixBook: {
        entries: run.state.bookEntries.slice(-40),
        signals: run.state.agentSignals.slice(-40),
        ownershipIndex: run.state.ownershipIndex
      }
    })
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
    syncOpenBranchesAfterMerge(run, pr);
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
  const agent = run.state.agents.find((candidate) => candidate.id === pr.ownerAgentId);
  const text = `${agent?.name ?? ""} ${agent?.role ?? ""} ${pr.ownerName} ${pr.title}`.toLowerCase();
  return /runtime qa|qa reviewer|quality|critic|reviewer|validator|test reviewer/.test(text);
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

export function syncOpenBranchesAfterMerge(run: MissionRun, mergedPr: PullRequest) {
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

