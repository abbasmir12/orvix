import {
  writeStateSnapshot,
  type Agent,
  type AgentExecutionPlan,
  type AgentToolCall,
  type AgentToolName,
  type SimulationState
} from "@orvix/core";
import { isQwenConfigured, QwenClient } from "@orvix/qwen";
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
  syncWorkspaceBranch,
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
  type MissionRun
} from "./run.js";
import { getBookContext, inferTopics, markSignalRead, normalizeBookEntryType, postBookEntry } from "./book.js";
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
      return getGitStatus(run.workspace);
    case "create_branch":
      return createGitBranch(run.workspace, body.branch ?? "", body.baseBranch ?? "main");
    case "checkout_branch":
      return checkoutGitBranch(run.workspace, body.branch ?? "");
    case "commit_changes":
      return commitWorkspaceChanges(run.workspace, body.message ?? "chore: agent workspace update");
    case "get_diff":
      return getWorkspaceDiff(run.workspace, body.baseBranch ?? "main");
    case "merge_branch":
      return mergeWorkspaceBranch(run.workspace, body.branch ?? "", body.targetBranch ?? "main");
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
    const sync = syncWorkspaceBranch(workspace, task.branch, "main");
    if (sync.ok) {
      appendEvent(run, `MasterMind synced ${task.branch} with main before revision`, "success");
    } else {
      appendEvent(run, `MasterMind could not pre-sync ${task.branch} before revision: ${sync.error}`, "warning");
    }
  }

  const workspaceFiles = listWorkspaceFiles(workspace);
  postSpeculativeDependencyNotes(run, agent, task);
  const bookContext = getBookContext(run, agent.id, task.id);
  const reviewFeedback = reviewFeedbackForTask(run, task);
  let rawPlan = createMockAgentPlan(agent, task);
  let qwenPlanContent: string | undefined;
  let qwenReasoningContent: string | undefined;
  if (run.mode === "qwen" && isQwenConfigured()) {
    try {
      const qwen = new QwenClient();
      const detailedPlan = await qwen.planAgentExecutionDetailedJson({
        mission: run.mission,
        agent,
        task,
        allowedTools,
        workspaceFiles,
        bookContext,
        organization: run.state.organization,
        agents: run.state.agents,
        tasks: run.state.tasks,
        pullRequests: run.state.pullRequests,
        reviewFeedback,
        orvixMap: orvixMapContext(run),
        mapWorkPacket: mapWorkPacketForAgent(run, agent.id, task.id)
      });
      rawPlan = detailedPlan.plan;
      qwenPlanContent = detailedPlan.content;
      qwenReasoningContent = detailedPlan.reasoningContent;

      if (!hasImplementationToolCall(rawPlan)) {
        appendEvent(run, `MasterMind asked ${agent.name} to revise a coordination-only plan into concrete workspace tool calls`, "info");
        const repairedPlan = await qwen.planAgentExecutionDetailedJson({
          mission: run.mission,
          agent,
          task,
          allowedTools,
          workspaceFiles,
          bookContext,
          organization: run.state.organization,
          agents: run.state.agents,
          tasks: run.state.tasks,
          pullRequests: run.state.pullRequests,
          reviewFeedback,
          orvixMap: orvixMapContext(run),
          mapWorkPacket: mapWorkPacketForAgent(run, agent.id, task.id),
          planRepair: {
            reason: "The previous plan contained no write_file or delete_file tool calls, so it could not produce reviewable workspace evidence.",
            instruction: "Return a corrected plan for the same task. Keep useful coordination calls only if they directly support implementation, but include concrete write_file or delete_file calls before commit/open_pr."
          }
        });
        rawPlan = repairedPlan.plan;
        qwenPlanContent = repairedPlan.content;
        qwenReasoningContent = repairedPlan.reasoningContent;
      }
    } catch (error) {
      if (run.mode === "qwen") {
        const message = `${agent.name} Qwen plan failed; no deterministic implementation fallback was applied: ${error instanceof Error ? error.message : "Unknown error"}`;
        updateAgentTaskState(run, agent.id, task.id, "blocked", "Qwen planning failed");
        appendEvent(run, message, "warning");
        writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
        broadcast(run, "state", run.state);
        return {
          ok: false,
          agent,
          task,
          error: "qwen_plan_failed"
        };
      }
      appendEvent(
        run,
        `${agent.name} Qwen plan failed; using deterministic ${options.revision ? "revision" : "execution"} plan: ${error instanceof Error ? error.message : "Unknown error"}`,
        "warning"
      );
    }
  }
  const revisionNumber = getExecutedTaskRevisionCount(run, task.id) + (options.revision ? 1 : 0);
  if (run.mode === "qwen" && !hasImplementationToolCall(rawPlan)) {
    const retryCount = getNoImplementationRetryCount(run, task.id);
    if (retryCount < 1) {
      const message = `${agent.name} returned no write_file or delete_file tool calls after MasterMind repair; MasterMind is requeuing one concrete implementation retry with an explicit Orvix Map contract.`;
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
          `Your previous plan for ${task.title} did not include write_file or delete_file after repair.`,
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

    const message = `${agent.name} returned no write_file or delete_file tool calls after MasterMind repair and retry; Orvix will not synthesize implementation fallback in Qwen mode.`;
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

  const plan = normalizeAgentExecutionPlan(rawPlan, agent, task, {
    revision: Boolean(options.revision),
    revisionNumber,
    allowFallbackEvidence: run.mode !== "qwen"
  });

  const results = [];
  appendEvent(
    run,
    `${agent.name} started ${options.revision ? "revision" : "real workspace execution"} for ${task.title}`,
    "info"
  );
  updateAgentTaskState(run, agent.id, task.id, "active", options.revision ? "Applying reviewer changes" : "Executing workspace tools");

  const executableToolCalls = plan.toolCalls.slice(0, agentExecutionToolCallLimit);
  if (plan.toolCalls.length > executableToolCalls.length) {
    appendEvent(
      run,
      `${agent.name} execution plan was capped at ${agentExecutionToolCallLimit} tool calls; remaining calls were skipped`,
      "warning"
    );
  }

  for (const toolCall of executableToolCalls) {
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

    if (!result.ok) {
      updateAgentTaskState(run, agent.id, task.id, "blocked", `Blocked on ${toolCall.tool}`);
      break;
    }
  }

  const failed = results.some((entry) => !entry.result.ok);
  const evidence = hasReviewableBranchEvidence(run, task.branch);
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
      qwen: {
        content: qwenPlanContent,
        reasoningContent: qwenReasoningContent
      },
      plan,
      results
    }),
    reasoningContent: qwenReasoningContent
  });
  writeStateSnapshot(run.store, run.state, run.reasoningArtifacts);
  broadcast(run, "state", run.state);

  return {
    ok: !failed && evidence.ok && evidence.reviewable,
    agent,
    task,
    allowedTools,
    plan,
    results,
    workspace,
    git: getGitStatus(workspace)
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
      return true;
    })
    .filter((task) => {
      if (selectedOwners.has(task.ownerAgentId)) return false;
      selectedOwners.add(task.ownerAgentId);
      return true;
    })
    .slice(0, limit);
}

export function postSpeculativeDependencyNotes(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number]
) {
  const completedTaskIds = getCompletedTaskIds(run);
  const missingDependencies = task.dependencies.filter((dependency) => !completedTaskIds.has(dependency));
  if (missingDependencies.length === 0) return;

  const alreadyPosted = run.state.bookEntries.some((entry) =>
    entry.fromAgentId === agent.id &&
    entry.taskId === task.id &&
    entry.type === "question" &&
    entry.topics.includes("dependency")
  );
  if (alreadyPosted) return;

  const dependencyOwners = missingDependencies
    .map((dependency) => run.state.tasks.find((candidate) => candidate.id === dependency)?.ownerAgentId)
    .filter((ownerId): ownerId is string => Boolean(ownerId && ownerId !== agent.id));

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

export function normalizeAgentExecutionPlan(
  plan: AgentExecutionPlan,
  agent: Agent,
  task: SimulationState["tasks"][number],
  options: { revision?: boolean; revisionNumber?: number; allowFallbackEvidence?: boolean } = {}
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
  const allowFallbackEvidence = options.allowFallbackEvidence ?? true;
  const implementationCalls = allowFallbackEvidence ? createImplementationEvidenceCalls(agent, task, options) : [];
  const hasImplementationEvidence = writeCalls.some((call) => isImplementationEvidencePath(call.path));
  if (allowFallbackEvidence && !hasImplementationEvidence && !options.revision) {
    writeCalls.push(...implementationCalls);
  }

  if (allowFallbackEvidence && writeCalls.length === 0 && !options.revision) {
    const safeAgentName = agent.name.replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Agent";
    writeCalls.push({
      tool: "write_file",
      path: `docs/${task.id}.md`,
      content: [
        `# ${task.title}`,
        "",
        `Owner: ${safeAgentName}`,
        `Branch: ${task.branch}`,
        "",
        "## Acceptance Criteria",
        "",
        ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        "",
        "## Delivery Evidence",
        "",
        "This delivery note was added by Orvix because the agent turn did not create file evidence before review.",
        ""
      ].join("\n")
    });
  }

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

export function isImplementationEvidencePath(path?: string) {
  if (!path) return false;
  if (/^docs\//i.test(path) || /^work\//i.test(path)) return false;
  return /\.(ts|tsx|js|jsx|sql|json|yaml|yml|test\.ts|spec\.ts|mdx)$/i.test(path);
}

export function hasImplementationToolCall(plan: AgentExecutionPlan) {
  return plan.toolCalls.some((call) => call.tool === "write_file" || call.tool === "delete_file");
}

export function createImplementationEvidenceCalls(
  agent: Agent,
  task: SimulationState["tasks"][number],
  options: { revision?: boolean; revisionNumber?: number } = {}
): AgentToolCall[] {
  const text = `${agent.name} ${agent.role} ${task.title} ${task.acceptanceCriteria.join(" ")} ${task.filesLikelyAffected.join(" ")}`.toLowerCase();
  const revisionSuffix = options.revision ? `\n// Revision ${options.revisionNumber ?? 1}: responds to reviewer feedback with concrete implementation evidence.\n` : "";

  if (/auth|oauth|sso|credential|password|session|token|argon2|rbac|security/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/auth/tenantAuth.ts",
        content: [
          "export type AuthProvider = \"password\" | \"okta\" | \"auth0\" | \"google\" | \"microsoft\";",
          "",
          "export type TenantSession = {",
          "  userId: string;",
          "  tenantId: string;",
          "  roles: string[];",
          "  provider: AuthProvider;",
          "  issuedAt: string;",
          "  expiresAt: string;",
          "};",
          "",
          "export function assertTenantBoundary(session: TenantSession, tenantId: string) {",
          "  if (!session.tenantId || session.tenantId !== tenantId) {",
          "    throw new Error(\"tenant_boundary_violation\");",
          "  }",
          "}",
          "",
          "export function createPasswordHashPolicy(tenantPepperId: string) {",
          "  if (!tenantPepperId.trim()) throw new Error(\"tenant_pepper_required\");",
          "  return { algorithm: \"argon2id\", memoryKiB: 19456, iterations: 2, parallelism: 1, tenantPepperId };",
          "}",
          "",
          "export function createPasswordResetPolicy(now = new Date()) {",
          "  return {",
          "    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),",
          "    singleUse: true,",
          "    tokenEntropyBits: 256",
          "  };",
          "}",
          "",
          "export const oauth21Requirements = {",
          "  pkceRequired: true,",
          "  implicitFlowAllowed: false,",
          "  redirectUriExactMatch: true,",
          "  supportedProviders: [\"okta\", \"auth0\"] satisfies AuthProvider[]",
          "};",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/auth/sso.ts",
        content: [
          "import { oauth21Requirements, type AuthProvider } from \"./tenantAuth\";",
          "",
          "export type SsoCallback = { provider: AuthProvider; code: string; state: string; tenantId: string };",
          "",
          "export function validateSsoCallback(callback: SsoCallback) {",
          "  if (!oauth21Requirements.supportedProviders.includes(callback.provider)) throw new Error(\"unsupported_provider\");",
          "  if (!callback.code || !callback.state) throw new Error(\"invalid_oauth_callback\");",
          "  if (!callback.tenantId) throw new Error(\"tenant_required\");",
          "  return {",
          "    provider: callback.provider,",
          "    tenantId: callback.tenantId,",
          "    tokenExchange: \"authorization_code_with_pkce\"",
          "  };",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "db/policies/tenant_rls.sql",
        content: [
          "create table if not exists tenants (",
          "  id uuid primary key,",
          "  name text not null",
          ");",
          "",
          "create table if not exists users (",
          "  id uuid primary key,",
          "  tenant_id uuid not null references tenants(id),",
          "  email text not null,",
          "  password_hash text,",
          "  roles text[] not null default '{}',",
          "  unique (tenant_id, email)",
          ");",
          "",
          "alter table users enable row level security;",
          "",
          "create policy tenant_isolation_users on users",
          "  using (tenant_id::text = current_setting('app.tenant_id', true))",
          "  with check (tenant_id::text = current_setting('app.tenant_id', true));",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/auth-tenancy.spec.ts",
        content: [
          "import { assertTenantBoundary, createPasswordHashPolicy, createPasswordResetPolicy, oauth21Requirements } from \"../src/auth/tenantAuth\";",
          "import { validateSsoCallback } from \"../src/auth/sso\";",
          "",
          "const session = {",
          "  userId: \"user_1\",",
          "  tenantId: \"tenant_a\",",
          "  roles: [\"admin\"],",
          "  provider: \"password\" as const,",
          "  issuedAt: new Date(0).toISOString(),",
          "  expiresAt: new Date(3600000).toISOString()",
          "};",
          "",
          "assertTenantBoundary(session, \"tenant_a\");",
          "const hashPolicy = createPasswordHashPolicy(\"pepper_tenant_a_v1\");",
          "if (hashPolicy.algorithm !== \"argon2id\") throw new Error(\"argon2id_required\");",
          "const reset = createPasswordResetPolicy(new Date(0));",
          "if (!reset.singleUse || reset.tokenEntropyBits < 256) throw new Error(\"weak_reset_policy\");",
          "if (!oauth21Requirements.pkceRequired || oauth21Requirements.implicitFlowAllowed) throw new Error(\"oauth21_policy_failed\");",
          "validateSsoCallback({ provider: \"okta\", code: \"code\", state: \"state\", tenantId: \"tenant_a\" });",
          ""
        ].join("\n")
      }
    ];
  }

  if (/tenant|isolation|branding|onboarding|segregation|purge/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/tenancy/tenantIsolation.ts",
        content: [
          "export type TenantContext = { tenantId: string; userId: string; roles: string[] };",
          "export type TenantResource = { tenantId: string; id: string };",
          "",
          "export function requireTenantAccess(context: TenantContext, resource: TenantResource) {",
          "  if (!context.tenantId || context.tenantId !== resource.tenantId) {",
          "    throw new Error(\"cross_tenant_access_denied\");",
          "  }",
          "  return true;",
          "}",
          "",
          "export function tenantRoute(path: string, tenantId: string) {",
          "  if (!tenantId.trim()) throw new Error(\"tenant_required\");",
          "  return `/t/${tenantId}${path.startsWith(\"/\") ? path : `/${path}`}`;",
          "}",
          "",
          "export function tenantDeletionPlan(tenantId: string) {",
          "  return [\"notes\", \"contacts\", \"users\", \"branding\", \"tenants\"].map((table) => ({ table, tenantId, hardDelete: true, auditRetained: true }));",
          "}",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/tenancy/branding.ts",
        content: [
          "export type TenantBranding = { tenantId: string; logoUrl: string; theme: \"light\" | \"dark\" | \"system\" };",
          "",
          "export function injectTenantBranding(branding: TenantBranding) {",
          "  if (!branding.logoUrl.startsWith(\"/\")) throw new Error(\"unsafe_logo_url\");",
          "  return {",
          "    cacheKey: `tenant-branding:${branding.tenantId}`,",
          "    maxRenderLatencyMs: 5000,",
          "    variables: { logo: branding.logoUrl, theme: branding.theme }",
          "  };",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/tenant-isolation.spec.ts",
        content: [
          "import { requireTenantAccess, tenantDeletionPlan, tenantRoute } from \"../src/tenancy/tenantIsolation\";",
          "import { injectTenantBranding } from \"../src/tenancy/branding\";",
          "",
          "requireTenantAccess({ tenantId: \"tenant_a\", userId: \"u1\", roles: [\"admin\"] }, { tenantId: \"tenant_a\", id: \"contact_1\" });",
          "",
          "try {",
          "  requireTenantAccess({ tenantId: \"tenant_a\", userId: \"u1\", roles: [] }, { tenantId: \"tenant_b\", id: \"contact_2\" });",
          "  throw new Error(\"expected_cross_tenant_denial\");",
          "} catch (error) {",
          "  if (!(error instanceof Error) || error.message !== \"cross_tenant_access_denied\") throw error;",
          "}",
          "",
          "if (!tenantRoute(\"/dashboard\", \"tenant_a\").startsWith(\"/t/tenant_a\")) throw new Error(\"tenant_route_failed\");",
          "if (tenantDeletionPlan(\"tenant_a\").some((step) => !step.hardDelete || !step.auditRetained)) throw new Error(\"purge_plan_failed\");",
          "if (injectTenantBranding({ tenantId: \"tenant_a\", logoUrl: \"/logo.svg\", theme: \"dark\" }).maxRenderLatencyMs > 5000) throw new Error(\"branding_latency_failed\");",
          ""
        ].join("\n")
      }
    ];
  }

  if (/database|schema|migration|rls|model/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "db/schema.sql",
        content: [
          "create table if not exists contacts (",
          "  id uuid primary key,",
          "  tenant_id uuid not null,",
          "  owner_user_id uuid not null,",
          "  name text not null,",
          "  email text,",
          "  created_at timestamptz not null default now()",
          ");",
          "",
          "create table if not exists notes (",
          "  id uuid primary key,",
          "  tenant_id uuid not null,",
          "  contact_id uuid not null references contacts(id),",
          "  body text not null,",
          "  created_at timestamptz not null default now()",
          ");",
          "",
          "alter table contacts enable row level security;",
          "alter table notes enable row level security;",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/schema-contract.spec.ts",
        content: "export const requiredTables = [\"contacts\", \"notes\", \"users\", \"tenants\"];\n"
      }
    ];
  }

  if (/api|route|endpoint|contacts|notes|crud/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "src/api/contacts.ts",
        content: [
          "export type ContactInput = { tenantId: string; ownerUserId: string; name: string; email?: string };",
          "",
          "export function validateContactInput(input: ContactInput) {",
          "  if (!input.tenantId) throw new Error(\"tenant_required\");",
          "  if (!input.ownerUserId) throw new Error(\"owner_required\");",
          "  if (!input.name.trim()) throw new Error(\"name_required\");",
          "  return input;",
          "}",
          "",
          "export const contactRoutes = {",
          "  list: \"GET /api/contacts\",",
          "  create: \"POST /api/contacts\",",
          "  update: \"PATCH /api/contacts/:id\",",
          "  remove: \"DELETE /api/contacts/:id\"",
          "};",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/contacts-api.spec.ts",
        content: "import { contactRoutes } from \"../src/api/contacts\";\nif (!contactRoutes.create.includes(\"POST\")) throw new Error(\"missing_create_route\");\n"
      }
    ];
  }

  if (/dashboard|ui|frontend|component|page|responsive/.test(text)) {
    return [
      {
        tool: "write_file",
        path: "app/page.tsx",
        content: [
          "const contacts = [",
          "  { name: \"Alice Smith\", company: \"Acme Inc.\", stage: \"Qualified\", notes: 4 },",
          "  { name: \"Bob Jones\", company: \"Northstar Labs\", stage: \"Proposal\", notes: 2 },",
          "  { name: \"Mina Patel\", company: \"Vertex Studio\", stage: \"Onboarding\", notes: 7 }",
          "];",
          "",
          "export default function Home() {",
          "  return (",
          "    <main className=\"product-shell\">",
          "      <aside className=\"sidebar\">",
          "        <strong>Orvix CRM</strong>",
          "        <nav>",
          "          <a href=\"/dashboard\">Dashboard</a>",
          "          <a href=\"/contacts\">Contacts</a>",
          "          <a href=\"/notes\">Notes</a>",
          "          <a href=\"/login\">Login</a>",
          "        </nav>",
          "      </aside>",
          "      <section className=\"workspace\">",
          "        <p className=\"eyebrow\">Production CRM MVP</p>",
          "        <h1>Customer operations dashboard</h1>",
          "        <p className=\"lede\">Authentication, dashboard metrics, contacts, and notes are organized into one reviewable operator workflow.</p>",
          "        <div className=\"metric-grid\">",
          "          <article><span>Contacts</span><strong>248</strong><small>42 need follow-up</small></article>",
          "          <article><span>Notes</span><strong>1,284</strong><small>Synced to customer records</small></article>",
          "          <article><span>Pipeline</span><strong>$186K</strong><small>Open opportunities</small></article>",
          "        </div>",
          "        <section className=\"table-card\">",
          "          <h2>Priority contacts</h2>",
          "          {contacts.map((contact) => <div className=\"row\" key={contact.name}><span>{contact.name}</span><span>{contact.company}</span><span>{contact.stage}</span><span>{contact.notes} notes</span></div>)}",
          "        </section>",
          "      </section>",
          "    </main>",
          "  );",
          "}",
          revisionSuffix
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "app/dashboard/page.tsx",
        content: "export default function DashboardPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Dashboard</p><h1>CRM Dashboard</h1><p className=\"lede\">Revenue, contact health, notes, and team workload in one command view.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/contacts/page.tsx",
        content: "export default function ContactsPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Contacts</p><h1>Contacts</h1><p className=\"lede\">Search, segment, and manage tenant-scoped customer records.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/notes/page.tsx",
        content: "export default function NotesPage() {\n  return <main className=\"route-shell\"><p className=\"eyebrow\">Notes</p><h1>Notes</h1><p className=\"lede\">Capture relationship context, follow-ups, and account history.</p></main>;\n}\n"
      },
      {
        tool: "write_file",
        path: "app/globals.css",
        content: [
          ":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #14110d; color: #f5efe4; }",
          "* { box-sizing: border-box; }",
          "body { margin: 0; min-height: 100vh; background: #14110d; }",
          "a { color: inherit; text-decoration: none; }",
          ".product-shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; background: linear-gradient(135deg, #17130f 0%, #20170e 54%, #11100e 100%); }",
          ".sidebar { border-right: 1px solid rgba(245,239,228,.12); padding: 28px 22px; background: rgba(255,255,255,.035); }",
          ".sidebar strong { display: block; margin-bottom: 28px; color: #f7c873; font-size: 1.05rem; }",
          ".sidebar nav { display: grid; gap: 8px; }",
          ".sidebar a { border-radius: 8px; padding: 10px 12px; color: #d8cbbb; }",
          ".workspace, .route-shell { width: min(1180px, 100%); padding: 56px; }",
          ".eyebrow { margin: 0 0 12px; color: #f7c873; text-transform: uppercase; letter-spacing: .08em; font-size: .78rem; font-weight: 700; }",
          "h1 { margin: 0; font-size: clamp(2.2rem, 6vw, 4.8rem); line-height: 1; letter-spacing: 0; }",
          ".lede { color: #d8cbbb; font-size: clamp(1rem, 2vw, 1.25rem); max-width: 760px; line-height: 1.6; }",
          ".metric-grid, .module-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-top: 28px; }",
          "article, .table-card { border: 1px solid rgba(245,239,228,.12); border-radius: 8px; padding: 18px; background: rgba(255,255,255,.055); }",
          "article span { display: block; color: #f7c873; font-size: .82rem; font-weight: 700; }",
          "article strong { display: block; margin-top: 10px; font-size: 2rem; }",
          "article small, article p { color: #c7b8a4; line-height: 1.5; }",
          ".table-card { margin-top: 18px; }",
          ".row { display: grid; grid-template-columns: 1.2fr 1fr 1fr auto; gap: 12px; padding: 12px 0; border-top: 1px solid rgba(245,239,228,.1); color: #d8cbbb; }",
          "@media (max-width: 760px) { .product-shell { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid rgba(245,239,228,.12); } .workspace, .route-shell { padding: 28px; } .row { grid-template-columns: 1fr; } }",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "src/ui/dashboardShell.tsx",
        content: [
          "type DashboardShellProps = { userName: string; contactCount: number; noteCount: number };",
          "",
          "export function DashboardShell(props: DashboardShellProps) {",
          "  return (",
          "    <main aria-label=\"CRM dashboard\">",
          "      <header>Welcome {props.userName}</header>",
          "      <section aria-label=\"Pipeline summary\">",
          "        <span>Contacts: {props.contactCount}</span>",
          "        <span>Notes: {props.noteCount}</span>",
          "      </section>",
          "    </main>",
          "  );",
          "}",
          ""
        ].join("\n")
      },
      {
        tool: "write_file",
        path: "tests/dashboard-shell.spec.ts",
        content: "export const dashboardA11yContract = { landmarks: [\"main\", \"header\"], responsive: true };\n"
      }
    ];
  }

  return [
    {
      tool: "write_file",
      path: `src/delivery/${task.id}.ts`,
      content: [
        `export const deliveryPacket = ${JSON.stringify({
          taskId: task.id,
          owner: agent.name,
          acceptanceCriteria: task.acceptanceCriteria,
          revision: options.revision ? options.revisionNumber ?? 1 : 0
        }, null, 2)} as const;`,
        ""
      ].join("\n")
    }
  ];
}

export function hasReviewableBranchEvidence(run: MissionRun, branch: string) {
  const exists = branchExists(run.workspace, branch);
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

  const diff = getBranchDiff(run.workspace, branch, "main");
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
  const worktree = ensureAgentWorktree(run.workspace, agent.id, task.branch, "main");
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

export async function executeAgentToolCall(
  run: MissionRun,
  agent: Agent,
  task: SimulationState["tasks"][number],
  toolCall: AgentToolCall,
  allowedTools: AgentToolName[],
  workspace: Workspace = run.workspace
) {
  if (!allowedTools.includes(toolCall.tool)) {
    return {
      ok: false,
      tool: toolCall.tool,
      code: "tool_not_allowed",
      error: `${agent.name} is not allowed to use ${toolCall.tool}`
    };
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

