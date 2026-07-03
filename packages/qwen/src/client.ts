import type {
  Agent,
  AgentExecutionPlan,
  AgentToolCall,
  AgentToolName,
  FinalReportDraft,
  MissionAnalysis,
  OrganizationDesign,
  OrganizationNode,
  OrvixBookContext,
  PullRequest,
  PullRequestReviewDecision,
  QwenMissionAnalysis,
  ReviewRubric,
  Task
} from "@orvix/core";

export type QwenProjectScaffoldDecision = {
  scaffoldType: "nextjs" | "react-vite" | "express-api" | "node-cli" | "python" | "generic";
  label: string;
  rationale: string;
  commands: string[];
};

export type QwenPlanningCouncilEntry = {
  type: "note" | "assumption" | "proposal" | "decision" | "contract" | "conflict";
  fromAgentId: string;
  message: string;
  topics: string[];
  priority?: "low" | "normal" | "high" | "urgent";
};

export type QwenPlanningCouncilDraft = {
  summary: string;
  entries: QwenPlanningCouncilEntry[];
};

export type QwenPlanningResearchRequest = {
  summary: string;
  queries: string[];
  fetchUrls?: string[];
  rationale: string;
};

export type OrvixMapSurface = {
  id: string;
  type: string;
  path?: string;
  name: string;
  purpose: string;
  sections?: Array<{
    id: string;
    name: string;
    purpose: string;
    position?: string;
    components?: Array<{
      id: string;
      name: string;
      fileHint?: string;
      purpose: string;
      elements?: Array<{
        id: string;
        type: string;
        testId?: string;
        contentRule?: string;
        behavior?: string;
        styleIntent?: string;
      }>;
    }>;
  }>;
};

export type OrvixMap = {
  version: string;
  status: "draft" | "locked";
  mission: string;
  productType: string;
  mapSummary: string;
  surfaces: OrvixMapSurface[];
  systems: Array<{
    id: string;
    name: string;
    purpose: string;
    fileHints?: string[];
    contracts?: string[];
  }>;
  designSystem?: {
    theme?: string;
    colors?: Record<string, string>;
    typography?: Record<string, string>;
    motion?: string[];
    layoutRules?: string[];
  };
  dataContracts?: Array<{
    id: string;
    name: string;
    fields?: string[];
    rules?: string[];
  }>;
  interactionContracts?: Array<{
    id: string;
    trigger: string;
    response: string;
    ownerHint?: string;
  }>;
  agentWorkPackets: Array<{
    id: string;
    suggestedAgentRole: string;
    owns: string[];
    mustCreateOrUpdate?: string[];
    acceptance: string[];
    coordinationNotes?: string[];
  }>;
  acceptanceGates: string[];
  forbiddenOutputs: string[];
  openQuestions?: string[];
};

export type OrvixMapReview = {
  decision: "approve" | "revise";
  summary: string;
  missingRequirements: string[];
  requestedChanges: string[];
  suggestions: string[];
  revisedMap?: OrvixMap;
};

export type QwenConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  plannerModel?: string;
  agentModel?: string;
  reviewModel?: string;
  maxConcurrentRequests: number;
};

export type QwenRole = "planner" | "agent" | "review";

export type QwenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type QwenUsageEvent = QwenUsage & {
  model: string;
  role: QwenRole;
  durationMs: number;
};

type QwenUsageListener = (event: QwenUsageEvent) => void;

let usageListener: QwenUsageListener | null = null;

export function setQwenUsageListener(listener: QwenUsageListener | null) {
  usageListener = listener;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Raw OpenAI-shaped tool_calls array echoed back on assistant turns. */
  tool_calls?: unknown[];
  /** Links a tool-role result message to the assistant tool call it answers. */
  tool_call_id?: string;
};

type QwenToolDefinition = {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
    };
  };
};

export type QwenChatResult = {
  content: string;
  reasoningContent?: string;
  nativeToolCalls?: AgentToolCall[];
  usage?: QwenUsage;
  message: Record<string, unknown>;
  raw: ChatCompletionResponse;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoningContent?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      [key: string]: unknown;
    };
  }>;
  [key: string]: unknown;
};

const defaultQwenTimeoutMs = 240000;

const agentToolDescriptions: Record<AgentToolName, string> = {
  list_files: "List workspace files before deciding what to change.",
  read_file: "Read an existing workspace file.",
  write_file: "Create or replace a concrete workspace file with implementation content.",
  delete_file: "Delete stale, wrong-domain, duplicate, or rejected workspace files.",
  create_branch: "Create a task branch for the agent's work packet.",
  checkout_branch: "Switch to an existing task branch.",
  commit_changes: "Commit the current workspace changes.",
  get_diff: "Inspect current branch changes against the base branch.",
  open_pr: "Open a PR-style review packet for completed branch work.",
  research_web: "Search the web for current docs, patterns, or constraints.",
  fetch_url: "Fetch a specific URL after research identifies a useful source.",
  complete_task: "Mark a review-only or non-code task complete.",
  post_book_entry: "Post a question, assumption, contract, decision, handoff, or note to Orvix Book.",
  read_book: "Read relevant Orvix Book entries.",
  answer_book_entry: "Answer a specific Orvix Book question.",
  read_signals: "Read unread Orvix Book mentions/signals for this agent.",
  mark_signal_read: "Mark an Orvix Book signal or entry as read."
};

const commonToolProperties: Record<string, unknown> = {
  path: { type: "string", description: "Workspace-relative path for file tools." },
  content: { type: "string", description: "File content or Orvix Book message content." },
  branch: { type: "string", description: "Git branch name for branch/PR tools." },
  message: { type: "string", description: "Commit message or Orvix Book message." },
  baseBranch: { type: "string", description: "Base branch, usually main." },
  title: { type: "string", description: "PR title." },
  summary: { type: "string", description: "PR summary or task summary." },
  entryId: { type: "string", description: "Orvix Book entry id." },
  signalId: { type: "string", description: "Agent signal id." },
  query: { type: "string", description: "Web research query." },
  url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
  entryType: {
    type: "string",
    enum: ["question", "answer", "note", "assumption", "proposal", "decision", "conflict", "contract", "handoff", "review_note"]
  },
  scope: {
    type: "string",
    enum: ["mission", "team", "agent", "task", "pr"]
  },
  visibility: {
    type: "string",
    enum: ["private", "parent_tree", "team", "mentioned", "global"]
  },
  toAgentIds: { type: "array", items: { type: "string" } },
  topics: { type: "array", items: { type: "string" } },
  priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
};

function requiredToolArgs(tool: AgentToolName) {
  if (tool === "write_file") return ["path", "content"];
  if (tool === "delete_file" || tool === "read_file") return ["path"];
  if (tool === "create_branch" || tool === "checkout_branch") return ["branch"];
  if (tool === "commit_changes") return ["message"];
  if (tool === "open_pr") return ["title", "summary"];
  if (tool === "research_web") return ["query"];
  if (tool === "fetch_url") return ["url"];
  if (tool === "answer_book_entry") return ["entryId", "content"];
  if (tool === "mark_signal_read") return [];
  if (tool === "post_book_entry") return ["entryType", "content"];
  return [];
}

function createAgentToolDefinitions(tools: AgentToolName[]): QwenToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool,
      description: agentToolDescriptions[tool],
      parameters: {
        type: "object",
        properties: commonToolProperties,
        required: requiredToolArgs(tool),
        additionalProperties: false
      }
    }
  }));
}

type ChatCompletionMessage = NonNullable<NonNullable<ChatCompletionResponse["choices"]>[number]["message"]>;

function parseNativeToolCalls(message?: ChatCompletionMessage): AgentToolCall[] {
  const record = message && typeof message === "object" ? message : {};
  const calls: AgentToolCall[] = [];
  for (const toolCall of record.tool_calls ?? []) {
    const name = toolCall.function?.name as AgentToolName | undefined;
    if (!name || !(name in agentToolDescriptions)) continue;
    const rawArgs = toolCall.function?.arguments ?? "{}";
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = {};
    }
    calls.push({
      tool: name,
      callId: typeof toolCall.id === "string" ? toolCall.id : undefined,
      path: typeof args.path === "string" ? args.path : undefined,
      content: typeof args.content === "string" ? args.content : undefined,
      branch: typeof args.branch === "string" ? args.branch : undefined,
      message: typeof args.message === "string" ? args.message : undefined,
      baseBranch: typeof args.baseBranch === "string" ? args.baseBranch : undefined,
      title: typeof args.title === "string" ? args.title : undefined,
      summary: typeof args.summary === "string" ? args.summary : undefined,
      entryId: typeof args.entryId === "string" ? args.entryId : undefined,
      signalId: typeof args.signalId === "string" ? args.signalId : undefined,
      query: typeof args.query === "string" ? args.query : undefined,
      url: typeof args.url === "string" ? args.url : undefined,
      entryType: typeof args.entryType === "string" ? args.entryType as AgentToolCall["entryType"] : undefined,
      scope: typeof args.scope === "string" ? args.scope as AgentToolCall["scope"] : undefined,
      visibility: typeof args.visibility === "string" ? args.visibility as AgentToolCall["visibility"] : undefined,
      toAgentIds: Array.isArray(args.toAgentIds) ? args.toAgentIds.map(String) : undefined,
      topics: Array.isArray(args.topics) ? args.topics.map(String) : undefined,
      priority: typeof args.priority === "string" ? args.priority as AgentToolCall["priority"] : undefined
    });
  }
  return calls;
}

const ORVIX_OPERATING_CONSTITUTION = [
  "Orvix is an autonomous AI engineering organization, not a single assistant.",
  "A MasterMind Agent analyzes the mission, designs the organization, assigns ownership, monitors progress, resolves conflicts, and decides readiness.",
  "Specialist agents work in parallel on separate branch-style work packets. Each agent owns its scope, produces concrete artifacts, and opens PR-style review packets.",
  "Agents must understand that other agents are working at the same time. They should not block on missing information when useful speculative progress is possible.",
  "Orvix Book is the shared company memory and negotiation board. Agents use it for questions, assumptions, contracts, handoffs, conflicts, decisions, and review notes.",
  "When an agent needs another agent, it mentions that agent in Orvix Book, states the requested contract, records an explicit assumption, and continues working.",
  "Agents may ask MasterMind, Runtime QA, or specialist reviewers for implementation inspection through Orvix Book. Mentions wake the target agent in the scheduler.",
  "When an agent receives a signal or mention, it should answer through Orvix Book and then continue its own task.",
  "All tool use is allowlisted. Agents cannot execute arbitrary shell commands. They can only request allowed tool calls in structured JSON.",
  "Reviewers inspect PR-style work packets against acceptance criteria, mission goals, security, architecture, and concrete diff evidence.",
  "Runtime QA verifies commands, pages, and visible mission behavior before final approval. A project is not complete if visible pages still show scaffold placeholder content.",
  "A rejected PR returns to the owner for revision. Repeated rejection escalates to MasterMind without stopping unrelated agents."
].join(" ");

const ORVIX_TOOL_MANUAL = [
  "Tool calling is declarative: return JSON toolCalls; Orvix executes allowed tools.",
  "Common implementation flow: post_book_entry or read_book if coordination is needed, create_branch, delete_file for stale or unrelated files when needed, write_file one or more concrete files, commit_changes, open_pr.",
  "Use post_book_entry with entryType question to ask another agent. Include toAgentIds, topics, priority, and content/message.",
  "Use read_signals to inspect your unread Orvix Book mentions. Use mark_signal_read with signalId after handling a specific signal; if you only have the book entry id, use entryId.",
  "Use delete_file to remove unrelated stale scaffold files, duplicate modules, wrong-domain app folders, or files reviewers explicitly ask to delete. Do not overwrite unwanted files with empty content.",
  "Use research_web when current documentation, unfamiliar frameworks, design inspiration, platform constraints, or deployment requirements would materially improve the work.",
  "Use fetch_url after research_web when a specific documentation URL is worth reading. Summarize the useful facts in transcript or Orvix Book; do not paste large pages into files.",
  "Example question: {\"tool\":\"post_book_entry\",\"entryType\":\"question\",\"toAgentIds\":[\"database-agent\"],\"topics\":[\"schema\",\"users\",\"tenant\"],\"priority\":\"high\",\"content\":\"I need the users table contract for auth. I will assume users.id and users.tenant_id until confirmed.\"}",
  "Example research: {\"tool\":\"research_web\",\"query\":\"Next.js App Router authentication middleware best practices 2026\"}",
  "Example fetch: {\"tool\":\"fetch_url\",\"url\":\"https://nextjs.org/docs/app\"}",
  "Example assumption: {\"tool\":\"post_book_entry\",\"entryType\":\"assumption\",\"topics\":[\"auth\",\"schema\"],\"content\":\"Proceeding with users(id, tenant_id, email, password_hash) until Database Agent confirms.\"}",
  "Example cleanup: {\"tool\":\"delete_file\",\"path\":\"app/crm/page.tsx\"}",
  "Do not return prose outside JSON. Do not claim completion without write_file artifacts."
].join(" ");

const ORVIX_AGENT_TRANSCRIPT_STYLE = [
  "Agent transcript style:",
  "Write like a skilled coding agent working in a terminal, not like a status robot.",
  "Vary sentence openings. Do not start every line with 'I am' or 'I will'.",
  "Use concise visible reasoning: what you noticed, what assumption you are making, what you are about to do, and why it matters.",
  "Good openings include: 'The workspace already has...', 'Before touching files...', 'This contract is still missing, so...', 'Next I need...', 'That gives me enough to...', 'I found...', 'The safer move is...'.",
  "Do not expose hidden chain-of-thought. Only write user-visible progress narration and engineering decisions.",
  "Transcript events should be 1 to 3 sentences when useful, not forced single-line slogans."
].join(" ");

const ORVIX_PRODUCT_QUALITY_BAR = [
  "Product quality bar:",
  "A generated project must be runnable, mission-specific, and visibly useful.",
  "For web apps, the primary route must look like the requested product, not a generic scaffold, placeholder, or disconnected component demo.",
  "Frontend/UI agents must update the visible entry points, such as app/page.tsx, app/dashboard/page.tsx, app/login/page.tsx, app/contacts/page.tsx, src/App.tsx, or route-level components.",
  "If a file imports a module, the same PR must create that module or use an existing one. Do not leave missing services, missing stores, missing config dependencies, or JSX inside .ts files.",
  "If reviewer feedback identifies unrelated files from a wrong product domain, remove them with delete_file and replace the visible route with mission-specific code.",
  "On revision turns, fix the requested source, route, config, or test files. Do not submit only docs/revisions or delivery notes unless the reviewer explicitly asked for documentation only.",
  "For SaaS/CRM/admin missions, include real operator surfaces: navigation, dashboard summary, contact list/search, notes/activity, authentication screen, empty/error/loading states, and responsive layout.",
  "A PR that only writes isolated helper files while the visible app remains generic is incomplete for frontend/product tasks.",
  "Use compact but coherent code. Prefer fewer files that build over many disconnected files."
].join(" ");

export type AgentSessionInput = {
  mission: string;
  agent: Agent;
  task: Task;
  allowedTools: AgentToolName[];
  workspaceFiles: unknown;
  bookContext: OrvixBookContext;
  organization?: unknown;
  agents?: unknown;
  tasks?: unknown;
  pullRequests?: unknown;
  reviewFeedback?: unknown;
  planRepair?: unknown;
  orvixMap?: unknown;
  mapWorkPacket?: unknown;
  revision?: boolean;
  maxTurns: number;
  maxToolCalls: number;
};

/**
 * Builds the opening messages for a multi-turn agent session. The orchestrator
 * loops: model emits native tool_calls -> Orvix executes them -> results come
 * back as tool-role messages -> model continues until open_pr/complete_task.
 */
export function createAgentSessionMessages(input: AgentSessionInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        ORVIX_OPERATING_CONSTITUTION,
        ORVIX_TOOL_MANUAL,
        ORVIX_AGENT_TRANSCRIPT_STYLE,
        ORVIX_PRODUCT_QUALITY_BAR,
        "You are now a specialist agent inside this Orvix organization, working in an INTERACTIVE session.",
        "Each of your turns should call one or more tools; Orvix executes them and returns real results as tool messages. React to those results.",
        "Investigate before you build: use list_files and read_file on existing files you plan to change or depend on, then write coherent code that matches what you actually read.",
        "If a tool fails or a file's content is not what you expected, adapt: fix the path, rewrite the file, or delete the stale file. Do not repeat a failing call unchanged.",
        "The Orvix Map is the locked source of truth. Your mapWorkPacket is your assigned slice; implement it and stay compatible with the full map.",
        "Alongside tool calls, write 1-2 short sentences of visible narration in your message content: what you found, what you are doing next, and why. This is streamed live to the user.",
        `Budget: at most ${input.maxTurns} turns and ${input.maxToolCalls} tool calls total. Spend them on concrete implementation, not repeated coordination.`,
        input.revision
          ? "This is a REVISION turn. Read the reviewer feedback, read the current files on your branch, and change the actual source/config/test files the review calls out. Documentation-only responses will be rejected."
          : "Your branch and worktree are already prepared; you do not need create_branch unless you want a different base.",
        "For an implementation task you must produce at least one write_file or delete_file with real content before finishing. A markdown status note is not implementation.",
        "Finish by calling open_pr with a title and summary once your work is committed (commit_changes first). Only use complete_task for explicitly review-only tasks.",
        "If information from a teammate is missing, post_book_entry with an explicit assumption and continue; never stall the session waiting."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        projectBrief: {
          productMission: input.mission,
          operatingModel: "Parallel multi-agent engineering organization using Orvix Book, branch packets, and PR review."
        },
        agentIdentity: {
          whoYouAre: input.agent,
          yourWork: input.task,
          instruction: "Own your domain. Coordinate through Orvix Book. Continue with explicit assumptions when contracts are missing."
        },
        organizationContext: {
          organization: input.organization,
          agents: input.agents,
          tasks: input.tasks,
          pullRequests: input.pullRequests,
          reviewFeedback: input.reviewFeedback,
          planRepair: input.planRepair,
          orvixMap: input.orvixMap,
          mapWorkPacket: input.mapWorkPacket
        },
        allowedTools: input.allowedTools,
        workspaceFiles: input.workspaceFiles,
        orvixBook: input.bookContext,
        sessionRules: [
          "Start by inspecting the workspace files relevant to your packet.",
          "Then write the concrete implementation files for your slice.",
          "Then commit_changes and open_pr.",
          "Narrate progress briefly in each message so the live feed shows your reasoning."
        ]
      })
    }
  ];
}

export function createQwenConfig(env: NodeJS.ProcessEnv = process.env): QwenConfig {
  const concurrency = Number(env.QWEN_MAX_CONCURRENT_REQUESTS ?? "");
  return {
    apiKey: env.DASHSCOPE_API_KEY ?? "",
    baseUrl: env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: env.QWEN_MODEL ?? "qwen-plus",
    plannerModel: env.QWEN_PLANNER_MODEL || undefined,
    agentModel: env.QWEN_AGENT_MODEL || undefined,
    reviewModel: env.QWEN_REVIEW_MODEL || undefined,
    maxConcurrentRequests: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 6
  };
}

// One shared queue for the whole process so 20 parallel agents cannot
// stampede the DashScope rate limits.
const requestQueue: Array<() => void> = [];
let activeRequests = 0;

async function withRequestSlot<T>(limit: number, work: () => Promise<T>): Promise<T> {
  if (activeRequests >= limit) {
    await new Promise<void>((release) => requestQueue.push(release));
  }
  activeRequests += 1;
  try {
    return await work();
  } finally {
    activeRequests -= 1;
    requestQueue.shift()?.();
  }
}

function retryDelayMs(attempt: number, retryAfterHeader?: string | null) {
  const retryAfter = Number(retryAfterHeader ?? "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30000, retryAfter * 1000);
  }
  const base = 1500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 500);
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function isQwenConfigured(config = createQwenConfig()) {
  return Boolean(config.apiKey);
}

export function normalizeOrvixMap(map: Partial<OrvixMap> | null | undefined, fallback: { mission?: string; productType?: string } = {}): OrvixMap {
  const record = map && typeof map === "object" ? map : {};
  const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

  return {
    version: typeof record.version === "string" && record.version ? record.version : "1.0",
    status: record.status === "locked" ? "locked" : "draft",
    mission: typeof record.mission === "string" && record.mission ? record.mission : fallback.mission ?? "",
    productType: typeof record.productType === "string" && record.productType ? record.productType : fallback.productType ?? "software-project",
    mapSummary: typeof record.mapSummary === "string" && record.mapSummary ? record.mapSummary : "Build contract summary unavailable; agents should follow mission analysis and Orvix Book decisions.",
    surfaces: asArray(record.surfaces),
    systems: asArray(record.systems),
    designSystem: record.designSystem && typeof record.designSystem === "object" ? record.designSystem : {},
    dataContracts: asArray(record.dataContracts),
    interactionContracts: asArray(record.interactionContracts),
    agentWorkPackets: asArray(record.agentWorkPackets),
    acceptanceGates: asArray(record.acceptanceGates),
    forbiddenOutputs: asArray(record.forbiddenOutputs),
    openQuestions: asArray(record.openQuestions)
  };
}

export function parseQwenJson<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const json = firstBrace >= 0 && lastBrace >= firstBrace
    ? candidate.slice(firstBrace, lastBrace + 1)
    : candidate;

  return JSON.parse(json) as T;
}

export type QwenChatOptions = {
  temperature?: number;
  thinking?: boolean;
  nativeTools?: AgentToolName[];
  requireNativeTool?: boolean;
  timeoutMs?: number;
  role?: QwenRole;
  json?: boolean;
};

const maxRequestAttempts = 3;

export class QwenClient {
  constructor(private readonly config = createQwenConfig()) {}

  private modelForRole(role: QwenRole = "planner") {
    if (role === "agent") return this.config.agentModel ?? this.config.model;
    if (role === "review") return this.config.reviewModel ?? this.config.model;
    return this.config.plannerModel ?? this.config.model;
  }

  async chatDetailed(messages: ChatMessage[], options: QwenChatOptions = {}): Promise<QwenChatResult> {
    if (!this.config.apiKey) {
      throw new Error("DASHSCOPE_API_KEY is required for Qwen calls.");
    }

    const timeoutMs = Math.max(5000, options.timeoutMs ?? Number(process.env.QWEN_TIMEOUT_MS ?? defaultQwenTimeoutMs));
    const thinkingEnabled = options.thinking === true && process.env.QWEN_ENABLE_THINKING === "true";
    const thinkingBudget = Number(process.env.QWEN_THINKING_BUDGET ?? "");
    const role = options.role ?? "planner";
    const model = this.modelForRole(role);
    // response_format and tools are mutually exclusive on DashScope; native
    // tool sessions rely on tool_calls, not JSON bodies.
    let useJsonFormat = options.json === true && !options.nativeTools?.length;

    for (let attempt = 0; attempt < maxRequestAttempts; attempt += 1) {
      const requestBody: Record<string, unknown> = {
        model,
        messages,
        temperature: options.temperature ?? 0.2
      };
      if (options.nativeTools?.length) {
        requestBody.tools = createAgentToolDefinitions(options.nativeTools);
        requestBody.tool_choice = options.requireNativeTool ? "required" : "auto";
      }
      if (useJsonFormat) {
        requestBody.response_format = { type: "json_object" };
      }
      if (thinkingEnabled) {
        requestBody.enable_thinking = true;
        if (Number.isFinite(thinkingBudget) && thinkingBudget > 0) {
          requestBody.thinking_budget = thinkingBudget;
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await withRequestSlot(this.config.maxConcurrentRequests, () =>
          fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          })
        );
      } catch (error) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          if (thinkingEnabled) {
            return this.chatDetailed(messages, { ...options, thinking: false });
          }
          throw new Error(`Qwen request timed out after ${timeoutMs}ms`);
        }
        if (attempt < maxRequestAttempts - 1) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw error;
      }
      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRequestAttempts - 1) {
          await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
          continue;
        }
        if (response.status === 400 && useJsonFormat) {
          useJsonFormat = false;
          continue;
        }
        if (response.status === 400 && options.nativeTools?.length) {
          return this.chatDetailed(messages, { ...options, nativeTools: undefined, requireNativeTool: undefined });
        }
        if (thinkingEnabled) {
          return this.chatDetailed(messages, { ...options, thinking: false });
        }
        throw new Error(`Qwen request failed with ${response.status}: ${body.slice(0, 600)}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const message = payload.choices?.[0]?.message;
      const content = message?.content ?? "";
      const nativeToolCalls = parseNativeToolCalls(message);
      if (!content && nativeToolCalls.length === 0) {
        throw new Error("Qwen response did not include message content.");
      }

      const rawUsage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
      const usage: QwenUsage = {
        promptTokens: Number(rawUsage.prompt_tokens ?? 0),
        completionTokens: Number(rawUsage.completion_tokens ?? 0),
        totalTokens: Number(rawUsage.total_tokens ?? 0)
      };
      usageListener?.({ ...usage, model, role, durationMs: Date.now() - startedAt });

      const reasoningContent = typeof message?.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message?.reasoningContent === "string"
          ? message.reasoningContent
          : undefined;

      return {
        content,
        reasoningContent,
        nativeToolCalls,
        usage,
        message: message as Record<string, unknown>,
        raw: payload
      };
    }

    throw new Error("Qwen request failed after retries.");
  }

  async chat(messages: ChatMessage[], options: QwenChatOptions = {}) {
    const result = await this.chatDetailed(messages, options);
    return result.content;
  }

  async draftPlanningResearch(input: { mission: string; analysis?: unknown }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Planning Research Scout, called before MasterMind finalizes the project plan.",
          "Decide what current external information would materially improve the first project plan.",
          "Return search queries and optional specific URLs to fetch. Keep research targeted and useful.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          earlyAnalysis: input.analysis,
          outputSchema: {
            summary: "short explanation of what needs research",
            queries: ["3 to 5 web search queries"],
            fetchUrls: ["optional specific documentation URLs if already known"],
            rationale: "why this research matters to MasterMind's plan"
          },
          rules: [
            "Always include at least three search queries.",
            "Prefer official docs and current best-practice queries.",
            "For software builds, include one query about runtime/build/deployment constraints.",
            "For software builds, include one query about relevant architecture patterns.",
            "Do not over-research. The goal is stronger planning, not a report."
          ]
        })
      }
    ], { temperature: 0.1, thinking: true, json: true, role: "planner", timeoutMs: Number(process.env.QWEN_ORVIX_MAP_TIMEOUT_MS ?? 75000) });
  }

  async draftPlanningResearchJson(input: { mission: string; analysis?: unknown }) {
    return parseQwenJson<QwenPlanningResearchRequest>(await this.draftPlanningResearch(input));
  }

  async analyzeMission(mission: string, planningResearch?: unknown) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix MasterMind Agent.",
          "This first analysis is the basic unit for the entire project: scaffold choice, agent design, task graph, review gates, and runtime QA all depend on it.",
          "Think creatively about the product and organization, but keep the plan buildable by specialist agents in one workspace.",
          "Use the supplied planning research as current external context. If research is thin, make explicit assumptions instead of becoming vague.",
          "Analyze software missions for a multi-agent engineering organization.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission,
          planningResearch,
          requiredOutputKeys: [
            "summary",
            "projectType",
            "complexity",
            "features",
            "risks",
            "requiredRoles",
            "successCriteria",
            "approvalGates"
          ],
          instructions: [
            "Make the summary specific enough that the rest of Orvix can build from it without reinterpreting the product.",
            "Features must describe visible product capabilities and core runtime systems.",
            "Risks must include wrong-domain/scaffold risk if relevant.",
            "Required roles must be concrete specialists, not generic assistants.",
            "Success criteria and approval gates must be testable by reviewers and runtime QA."
          ]
        })
      }
    ], { temperature: 0.1, thinking: true, json: true, role: "planner" });
  }

  async analyzeMissionJson(mission: string, planningResearch?: unknown) {
    return parseQwenJson<QwenMissionAnalysis>(await this.analyzeMission(mission, planningResearch));
  }

  async draftPlanningCouncil(input: { mission: string; analysis?: unknown; planningResearch?: unknown }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix MasterMind running the first internal planning council before scaffold and team creation.",
          "Create Orvix Book-style planning entries from specialist planner perspectives.",
          "The entries must clarify product domain, stack implications, acceptance gates, risks, and wrong-domain things to avoid.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          earlyAnalysis: input.analysis,
          planningResearch: input.planningResearch,
          plannerRoles: [
            "MasterMind Agent",
            "Product Strategy Planner",
            "Architecture Planner",
            "Runtime QA Planner",
            "Delivery Risk Planner"
          ],
          outputSchema: {
            summary: "short kickoff summary",
            entries: [
              {
                type: "note | assumption | proposal | decision | contract | conflict",
                fromAgentId: "planner-agent-id",
                message: "specific planning note written as an Orvix Book entry",
                topics: ["mission", "stack", "acceptance"],
                priority: "low | normal | high | urgent"
              }
            ]
          },
          rules: [
            "Make 4 to 7 entries.",
            "At least one entry must state the product/domain interpretation.",
            "At least one entry must state stack/scaffold implications.",
            "At least one entry must state runtime acceptance gates.",
            "At least one entry must incorporate a useful planning research finding or assumption.",
            "If the mission could be confused with another domain, explicitly name what not to build."
          ]
        })
      }
    ], { temperature: 0.1, thinking: true, json: true, role: "planner" });
  }

  async draftPlanningCouncilJson(input: { mission: string; analysis?: unknown; planningResearch?: unknown }) {
    return parseQwenJson<QwenPlanningCouncilDraft>(await this.draftPlanningCouncil(input));
  }

  async chooseProjectScaffold(input: { mission: string; analysis?: unknown; planningCouncil?: unknown; planningResearch?: unknown }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix MasterMind Agent choosing the initial runnable project scaffold.",
          "If the user explicitly names a stack, respect it when feasible.",
          "If the user does not name a stack, choose the best practical default for the requested product.",
          "Prefer Next.js App Router for SaaS, CRM, admin panels, auth-heavy web apps, and full-stack product prototypes.",
          "Prefer Vite React for 2D games, browser games, canvas apps, frontend-only sites, landing pages, visual demos, and dashboards with no backend requirement.",
          "Treat planning council entries as binding early company memory unless they contradict the user's explicit request.",
          "Prefer Express API for backend-only REST/API services.",
          "Prefer Node CLI for command-line tools.",
          "Prefer Python for data, ML, notebooks, FastAPI, Flask, or automation-heavy Python projects.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          missionAnalysis: input.analysis,
          planningCouncil: input.planningCouncil,
          planningResearch: input.planningResearch,
          allowedScaffoldTypes: ["nextjs", "react-vite", "express-api", "node-cli", "python", "generic"],
          outputSchema: {
            scaffoldType: "nextjs | react-vite | express-api | node-cli | python | generic",
            label: "human-readable stack label",
            rationale: "one concise sentence explaining why MasterMind chose this scaffold",
            commands: ["commands users should run to install, develop, build, or test"]
          }
        })
      }
    ], { temperature: 0.05, thinking: true, json: true, role: "planner" });
  }

  async chooseProjectScaffoldJson(input: { mission: string; analysis?: unknown; planningCouncil?: unknown; planningResearch?: unknown }) {
    return parseQwenJson<QwenProjectScaffoldDecision>(await this.chooseProjectScaffold(input));
  }

  async draftOrvixMap(input: {
    mission: string;
    analysis: MissionAnalysis;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Blueprint Architect.",
          "Create the Orvix Map: the shared build contract every implementation agent and reviewer will receive.",
          "The Orvix Map must be structured, explicit, and adaptive to the project type.",
          "For GUI products, surfaces are pages, routes, screens, panels, or sections. For APIs, surfaces are endpoints and schemas. For CLI tools, surfaces are commands and terminal outputs. For libraries, surfaces are public modules/functions. For data/ML, surfaces are pipeline stages and outputs.",
          "Include concrete names, ids, file hints, component/module boundaries, interaction contracts, styling or interface guidance, acceptance gates, and forbidden outputs.",
          "Do not make a vague plan. Do not overfit pixel-level CSS unless it affects coordination or testability.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          missionAnalysis: input.analysis,
          planningResearch: input.planningResearch,
          planningCouncil: input.planningCouncil,
          scaffold: input.scaffold,
          requiredSchema: {
            version: "1.0",
            status: "draft",
            mission: "original mission",
            productType: "project type",
            mapSummary: "precise summary of the build contract",
            surfaces: [
              {
                id: "stable surface id",
                type: "route | screen | endpoint | command | module | pipeline-stage | workflow | other",
                path: "route path, command name, endpoint path, or module export when relevant",
                name: "human name",
                purpose: "why this surface exists",
                sections: [
                  {
                    id: "stable section id",
                    name: "section name",
                    purpose: "section responsibility",
                    position: "layout/ordering guidance when relevant",
                    components: [
                      {
                        id: "stable component id",
                        name: "component/module/function name",
                        fileHint: "likely workspace-relative file path",
                        purpose: "component responsibility",
                        elements: [
                          {
                            id: "stable element id",
                            type: "button | input | canvas | table | text | function | schema | config | other",
                            testId: "recommended data-testid or equivalent",
                            contentRule: "what the element/function/output must say or contain",
                            behavior: "what it does",
                            styleIntent: "visual/interface intent when relevant"
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ],
            systems: [
              {
                id: "stable system id",
                name: "system/module name",
                purpose: "runtime responsibility",
                fileHints: ["likely files"],
                contracts: ["interfaces, events, state, API, or data contracts"]
              }
            ],
            designSystem: {
              theme: "visual or interface theme",
              colors: { primary: "#hex when relevant" },
              typography: { ui: "font guidance when relevant" },
              motion: ["animation/feedback rules when relevant"],
              layoutRules: ["responsive/layout rules"]
            },
            dataContracts: [
              {
                id: "stable contract id",
                name: "contract name",
                fields: ["field names/types"],
                rules: ["validation or persistence rules"]
              }
            ],
            interactionContracts: [
              {
                id: "stable interaction id",
                trigger: "user/system trigger",
                response: "expected behavior",
                ownerHint: "likely owning agent role"
              }
            ],
            agentWorkPackets: [
              {
                id: "stable packet id",
                suggestedAgentRole: "specialist role that should own this packet",
                owns: ["surface/system/component ids"],
                mustCreateOrUpdate: ["likely files"],
                acceptance: ["packet-specific acceptance checks"],
                coordinationNotes: ["handoffs or assumptions"]
              }
            ],
            acceptanceGates: ["global runtime/review gates"],
            forbiddenOutputs: ["wrong-domain, wrong-stack, placeholder, or unsafe outputs to reject"],
            openQuestions: ["only questions that do not block useful implementation"]
          },
          rules: [
            "Use the selected scaffold and its entry files. Do not invent a different framework layout.",
            "Every important visible surface, endpoint, command, module, or pipeline stage must appear in surfaces or systems.",
            "Every agentWorkPacket must reference ids from surfaces, systems, dataContracts, or interactionContracts.",
            "Include enough detail that a specialist agent can implement without guessing the product.",
            "Include no more than 20 agentWorkPackets."
          ]
        })
      }
    ], { temperature: 0.1, thinking: true, json: true, role: "planner" });
  }

  async draftOrvixMapJson(input: {
    mission: string;
    analysis: MissionAnalysis;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    return normalizeOrvixMap(parseQwenJson<Partial<OrvixMap>>(await this.draftOrvixMap(input)), {
      mission: input.mission,
      productType: input.analysis.projectType
    });
  }

  async draftCompactOrvixMap(input: {
    mission: string;
    analysis: MissionAnalysis;
    planningCouncil?: unknown;
    scaffold?: unknown;
    previousError?: string;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Blueprint Architect.",
          "Create a compact Orvix Map after the full blueprint attempt was too slow or unavailable.",
          "Keep it concise but complete enough for agents: surfaces, systems, designSystem, agentWorkPackets, acceptanceGates, forbiddenOutputs.",
          "Use stable ids and file hints. Limit to 2-5 surfaces, 3-8 systems, and 5-12 work packets.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          missionAnalysis: input.analysis,
          planningCouncil: input.planningCouncil,
          scaffold: input.scaffold,
          previousError: input.previousError,
          outputShape: {
            version: "1.0",
            status: "draft",
            mission: input.mission,
            productType: input.analysis.projectType,
            mapSummary: "specific build contract summary",
            surfaces: [{ id: "surface-id", type: "route | screen | endpoint | command | module", path: "optional", name: "name", purpose: "purpose", sections: [] }],
            systems: [{ id: "system-id", name: "name", purpose: "purpose", fileHints: ["src/file.ts"], contracts: ["contract"] }],
            designSystem: { theme: "theme", colors: {}, typography: {}, motion: [], layoutRules: [] },
            dataContracts: [],
            interactionContracts: [{ id: "interaction-id", trigger: "trigger", response: "response", ownerHint: "role" }],
            agentWorkPackets: [{ id: "packet-id", suggestedAgentRole: "role", owns: ["surface/system ids"], mustCreateOrUpdate: ["files"], acceptance: ["checks"], coordinationNotes: [] }],
            acceptanceGates: ["global checks"],
            forbiddenOutputs: ["wrong stack/domain/scaffold placeholders"],
            openQuestions: []
          }
        })
      }
    ], { temperature: 0.06, thinking: false, json: true, role: "planner", timeoutMs: Number(process.env.QWEN_COMPACT_MAP_TIMEOUT_MS ?? 60000) });
  }

  async draftCompactOrvixMapJson(input: {
    mission: string;
    analysis: MissionAnalysis;
    planningCouncil?: unknown;
    scaffold?: unknown;
    previousError?: string;
  }) {
    return normalizeOrvixMap(parseQwenJson<Partial<OrvixMap>>(await this.draftCompactOrvixMap(input)), {
      mission: input.mission,
      productType: input.analysis.projectType
    });
  }

  async reviewOrvixMap(input: {
    mission: string;
    analysis: MissionAnalysis;
    orvixMap: OrvixMap;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix MasterMind reviewing the Blueprint Architect's Orvix Map before organization design.",
          "Approve only if the map is coherent, complete enough to guide agents, compatible with the scaffold, and has clear ids/contracts/acceptance gates.",
          "If the map has small gaps, you may return a revisedMap yourself. If it has major gaps, request revision and list precise changes.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          missionAnalysis: input.analysis,
          planningResearch: input.planningResearch,
          planningCouncil: input.planningCouncil,
          scaffold: input.scaffold,
          orvixMap: input.orvixMap,
          outputSchema: {
            decision: "approve | revise",
            summary: "MasterMind verdict",
            missingRequirements: ["missing or weak map requirements"],
            requestedChanges: ["specific changes Blueprint Architect must make if revision is needed"],
            suggestions: ["optional improvements"],
            revisedMap: "optional complete Orvix Map if MasterMind can safely repair minor issues itself"
          },
          reviewRules: [
            "Check that surfaces/systems match the project type and scaffold.",
            "Check that ids are stable and useful for agent ownership and tests.",
            "Check that agentWorkPackets are actionable and do not exceed 20.",
            "Check that forbiddenOutputs cover likely wrong-domain or wrong-stack failures.",
            "If revisedMap is supplied, it must be a complete map, not a patch."
          ]
        })
      }
    ], { temperature: 0.05, thinking: true, json: true, role: "planner", timeoutMs: Number(process.env.QWEN_MAP_REVIEW_TIMEOUT_MS ?? 60000) });
  }

  async reviewOrvixMapJson(input: {
    mission: string;
    analysis: MissionAnalysis;
    orvixMap: OrvixMap;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    const review = parseQwenJson<OrvixMapReview>(await this.reviewOrvixMap(input));
    return {
      ...review,
      revisedMap: review.revisedMap
        ? normalizeOrvixMap(review.revisedMap, { mission: input.mission, productType: input.analysis.projectType })
        : undefined
    };
  }

  async reviseOrvixMap(input: {
    mission: string;
    analysis: MissionAnalysis;
    originalMap: OrvixMap;
    review: OrvixMapReview;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Blueprint Architect revising the Orvix Map after MasterMind review.",
          "Apply every requested change while preserving useful structure from the original map.",
          "Return the complete revised Orvix Map JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(input)
      }
    ], { temperature: 0.08, thinking: true, json: true, role: "planner", timeoutMs: Number(process.env.QWEN_MAP_REVIEW_TIMEOUT_MS ?? 60000) });
  }

  async reviseOrvixMapJson(input: {
    mission: string;
    analysis: MissionAnalysis;
    originalMap: OrvixMap;
    review: OrvixMapReview;
    planningResearch?: unknown;
    planningCouncil?: unknown;
    scaffold?: unknown;
  }) {
    return normalizeOrvixMap(parseQwenJson<Partial<OrvixMap>>(await this.reviseOrvixMap(input)), {
      mission: input.mission,
      productType: input.analysis.projectType
    });
  }

  async designOrganization(input: { analysis: MissionAnalysis; planningCouncil?: unknown; planningResearch?: unknown; orvixMap?: unknown }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Strategy Weaver, called by MasterMind to design the project-specific engineering organization.",
          "Create agents with clear ownership boundaries, not vague helpers.",
          "Each agent must know its owned domain, likely collaboration partners, acceptance criteria, and tool permissions.",
          "Prefer parallelizable workstreams. Dependencies should be treated as coordination contracts through Orvix Book, not hard waiting unless absolutely required.",
          "Treat planning council entries as company memory. Preserve their domain, stack, and acceptance decisions in the team design.",
          "Treat the Orvix Map as the locked source of truth for surfaces, systems, contracts, work packets, and acceptance gates.",
          "Create as many useful specialist agents as the project actually needs, from 5 up to 20. Do not hesitate to create 10, 12, 16, or 20 agents when that makes ownership clearer. Do not create filler agents.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Design an organization for this mission analysis.",
          missionAnalysis: input.analysis,
          planningCouncil: input.planningCouncil,
          planningResearch: input.planningResearch,
          orvixMap: input.orvixMap,
          outputSchema: {
            organizationName: "short organization name",
            agents: [
              {
                id: "stable-kebab-case-id",
                name: "clear specialist name",
                role: "specific ownership role",
                goal: "concrete deliverable owned by this agent",
                tools: ["allowed tool names"],
                acceptanceCriteria: ["reviewable criteria"],
                dependencies: ["agent or task ids for coordination only; do not overuse"]
              }
            ]
          },
          designRules: [
            "Create one MasterMind-equivalent only if needed; otherwise workers report to Orvix MasterMind.",
            "Make worker agents parallelizable.",
            "Use dependencies sparingly; prefer Orvix Book contracts.",
            "Reviewer/validator agents should not own implementation files.",
            "Implementation agents should produce code, schemas, tests, UI, or config evidence."
          ]
        })
      }
    ], { temperature: 0.1, thinking: true, json: true, role: "planner" });
  }

  async designOrganizationJson(input: MissionAnalysis | { analysis: MissionAnalysis; planningCouncil?: unknown; planningResearch?: unknown; orvixMap?: unknown }) {
    const normalized = "analysis" in input ? input : { analysis: input };
    return parseQwenJson<OrganizationDesign>(await this.designOrganization(normalized));
  }

  async reviewPullRequest(pr: PullRequest) {
    return this.chat([
      {
        role: "system",
        content: "You are Orvix Critic Council. Review PR-style work items. Return valid compact JSON only. No markdown."
      },
      {
        role: "user",
        content: `Review this PR and return JSON with status, decision, missingRequirements, risks, requestedChanges, approvalConditions.\n${JSON.stringify(pr, null, 2)}`
      }
    ], { json: true, role: "review" });
  }

  async reviewPullRequestJson(pr: PullRequest) {
    return parseQwenJson<ReviewRubric>(await this.reviewPullRequest(pr));
  }

  async createFinalReport(input: { mission: string; organization: OrganizationNode; approvedPrs: PullRequest[] }) {
    return this.chat([
      {
        role: "system",
        content: "You are Orvix Release Marshal. Produce final delivery reports for agentic engineering simulations. Return valid compact JSON only. No markdown."
      },
      {
        role: "user",
        content: `Create final report JSON with missionStatus, completedFeatures, openIssues, mergedPRs, releaseRecommendation, nextSteps.\n${JSON.stringify(input, null, 2)}`
      }
    ], { json: true, role: "planner" });
  }

  async createFinalReportJson(input: { mission: string; organization: OrganizationNode; approvedPrs: PullRequest[] }) {
    return parseQwenJson<FinalReportDraft>(await this.createFinalReport(input));
  }

  /** One turn of a multi-turn agent session; tool results are fed back as tool-role messages. */
  async agentSessionTurn(messages: ChatMessage[], tools: AgentToolName[], options: { requireTool?: boolean; timeoutMs?: number } = {}) {
    return this.chatDetailed(messages, {
      temperature: 0.15,
      role: "agent",
      nativeTools: tools,
      requireNativeTool: options.requireTool ?? false,
      timeoutMs: options.timeoutMs ?? Number(process.env.QWEN_AGENT_TURN_TIMEOUT_MS ?? 120000)
    });
  }

  async answerBookQuestion(input: {
    mission: string;
    agent: Agent;
    ownedTask?: Task | null;
    question: OrvixBookContext["entries"][number];
    bookContext: OrvixBookContext;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          `You are ${input.agent.name} (${input.agent.role}) answering a teammate's question in Orvix Book.`,
          "Answer from your real ownership perspective: state the contract, interface, decision, or constraint the asker needs.",
          "If you genuinely cannot answer yet, say what assumption the asker should proceed with and when you will confirm it.",
          "Be concrete and short (2-4 sentences). No markdown. Return valid compact JSON only."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          you: input.agent,
          yourTask: input.ownedTask,
          question: input.question,
          recentBook: input.bookContext.entries.slice(-12),
          outputSchema: { message: "your answer as one Orvix Book entry" }
        })
      }
    ], { temperature: 0.2, json: true, role: "agent" });
  }

  async answerBookQuestionJson(input: {
    mission: string;
    agent: Agent;
    ownedTask?: Task | null;
    question: OrvixBookContext["entries"][number];
    bookContext: OrvixBookContext;
  }) {
    return parseQwenJson<{ message: string }>(await this.answerBookQuestion(input));
  }

  async runtimeAcceptanceVerdict(input: {
    mission: string;
    productType: string;
    acceptanceGates: string[];
    forbiddenOutputs: string[];
    checks: Array<{ name: string; ok: boolean; output: string }>;
    pageSamples: Array<{ route: string; ok: boolean; textSnippet: string }>;
    sourceSample?: string;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          "You are Orvix Runtime QA delivering the final mission-fit verdict on a generated project.",
          "You receive real build/command outputs and real fetched page text from the running app.",
          "Pass only if the evidence shows the requested product working: build passes, pages respond, and the visible/callable output matches the mission and acceptance gates rather than generic scaffold content.",
          "Fail with precise, fixable findings when evidence shows placeholder content, missing mission behavior, or forbidden outputs.",
          "Do not fail for polish or production-hardening concerns; this is a working-prototype gate.",
          "Return valid compact JSON only. No markdown."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          mission: input.mission,
          productType: input.productType,
          acceptanceGates: input.acceptanceGates,
          forbiddenOutputs: input.forbiddenOutputs,
          commandChecks: input.checks.map((check) => ({ ...check, output: check.output.slice(0, 1500) })),
          pageSamples: input.pageSamples.map((page) => ({ ...page, textSnippet: page.textSnippet.slice(0, 2000) })),
          sourceSample: input.sourceSample?.slice(0, 6000),
          outputSchema: {
            pass: "true | false",
            summary: "one-sentence Runtime QA verdict",
            findings: ["specific fixable problems; empty array when passing"]
          }
        })
      }
    ], { temperature: 0.05, json: true, role: "review" });
  }

  async runtimeAcceptanceVerdictJson(input: {
    mission: string;
    productType: string;
    acceptanceGates: string[];
    forbiddenOutputs: string[];
    checks: Array<{ name: string; ok: boolean; output: string }>;
    pageSamples: Array<{ route: string; ok: boolean; textSnippet: string }>;
    sourceSample?: string;
  }) {
    const verdict = parseQwenJson<{ pass: boolean | string; summary?: string; findings?: string[] }>(
      await this.runtimeAcceptanceVerdict(input)
    );
    return {
      pass: verdict.pass === true || verdict.pass === "true",
      summary: verdict.summary ?? "",
      findings: Array.isArray(verdict.findings) ? verdict.findings.map(String) : []
    };
  }

  async reviewWorkspacePullRequest(input: {
    mission: string;
    pr: PullRequest;
    diff: string;
    files: unknown;
    reviewAttempt?: number;
    reviewAttemptLimit?: number;
    organization?: unknown;
    agents?: unknown;
    tasks?: unknown;
    pullRequests?: unknown;
    orvixBook?: unknown;
    orvixMap?: unknown;
  }) {
    return this.chat([
      {
        role: "system",
        content: [
          ORVIX_OPERATING_CONSTITUTION,
          ORVIX_PRODUCT_QUALITY_BAR,
          "You are Orvix Critic Council, but your primary role is instructor-reviewer and senior engineering coach.",
          "You review real workspace diffs with full mission, org, task, PR, and Orvix Book context.",
          "Use the Orvix Map as the primary review contract. A PR should be judged against its assigned map packet and the global map acceptance gates.",
          "Your job is not to block for perfection. Your job is to decide whether this PR is useful progress and provide precise coaching for the next revision.",
          "Return valid compact JSON only. No markdown.",
          "Return keys: decision, summary, comments, risks.",
          "decision must be either approve or request_changes.",
          "Approve if the PR is a coherent prototype packet: relevant files, concrete artifacts, meaningful progress, and no obviously dangerous nonsense.",
          "For frontend/UI/product PRs, do not approve if the diff only adds disconnected components and never updates a visible route or app entry point.",
          "For TypeScript/Next/React PRs, request changes if imports reference files that are not present in the submitted file list or diff.",
          "Request changes only when the diff is empty, wrong-domain, incoherent, unsafe, or missing the minimum artifact type needed for the task.",
          "When requesting changes, act like a prompter: give the owner exact next files/functions/tests/contracts to add.",
          "Do not repeatedly ask for vague production completeness. Convert broad concerns into small actionable next-step instructions.",
          "Remember other agents are working in parallel; use Orvix Book context to judge whether missing details can be handled by another agent or a follow-up task."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          projectBrief: {
            productMission: input.mission,
            reviewMode: "instructor_prototype_review",
            reviewAttempt: input.reviewAttempt,
            reviewAttemptLimit: input.reviewAttemptLimit
          },
          organizationContext: {
            organization: input.organization,
            agents: input.agents,
            tasks: input.tasks,
            pullRequests: input.pullRequests
          },
          pullRequest: input.pr,
          orvixMap: input.orvixMap,
          diff: input.diff.slice(0, 12000),
          files: input.files,
          orvixBook: input.orvixBook,
          reviewerPolicy: [
            "Be strict about empty or irrelevant diffs.",
            "Be generous about prototype completeness if the PR clearly advances its assigned task.",
            "Prefer actionable coaching over rejection.",
            "If requesting changes, list exact additions that the owner can implement in the next revision.",
            "If the PR is good enough as a prototype but has production gaps, approve and list risks/follow-up work.",
            "Frontend/product PRs must touch a visible app route or explicitly justify why another PR owns the route.",
            "Call out missing imports, missing package dependencies, JSX saved as .ts, and route files that will 404."
          ],
          outputSchema: {
            decision: "approve | request_changes",
            summary: "short instructor verdict",
            comments: ["concrete coaching comments or approval notes"],
            risks: ["risk or follow-up item, empty array allowed"]
          }
        })
      }
    ], { temperature: 0.1, json: true, role: "review" });
  }

  async reviewWorkspacePullRequestJson(input: {
    mission: string;
    pr: PullRequest;
    diff: string;
    files: unknown;
    reviewAttempt?: number;
    reviewAttemptLimit?: number;
    organization?: unknown;
    agents?: unknown;
    tasks?: unknown;
    pullRequests?: unknown;
    orvixBook?: unknown;
    orvixMap?: unknown;
  }) {
    return parseQwenJson<PullRequestReviewDecision>(await this.reviewWorkspacePullRequest(input));
  }
}
