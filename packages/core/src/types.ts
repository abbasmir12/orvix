export type AgentStatus = "queued" | "active" | "blocked" | "completed";

export type PullRequestStatus =
  | "Queued"
  | "In progress"
  | "Changes requested"
  | "Approved";

export type Agent = {
  id: string;
  name: string;
  role: string;
  currentActivity: string;
  status: AgentStatus;
  progress: number;
  confidence: number;
};

export type AgentCallStatus = "waiting" | "calling" | "running" | "blocked" | "returned";

export type AgentCall = {
  id: string;
  from: string;
  to: string;
  intent: string;
  signal: string;
  status: AgentCallStatus;
};

export type Task = {
  id: string;
  title: string;
  ownerAgentId: string;
  branch: string;
  dependencies: string[];
  filesLikelyAffected: string[];
  acceptanceCriteria: string[];
  status: AgentStatus;
};

export type PullRequest = {
  id: number;
  title: string;
  branch: string;
  ownerAgentId: string;
  ownerName: string;
  summary: string;
  changedFiles: string[];
  acceptanceCriteria: string[];
  status: PullRequestStatus;
  reviewerStatus: "Pending" | "Reviewing" | "Requested changes" | "Approved";
  comments: string[];
};

export type TimelineEvent = {
  id: string;
  time: string;
  message: string;
  severity: "info" | "success" | "warning";
};

export type ReasoningArtifact = {
  id: string;
  kind: "mission_analysis" | "orvix_map" | "organization_design" | "review_rubric" | "final_report" | "agent_execution" | "pr_review";
  status: "completed" | "failed";
  content?: string;
  reasoningContent?: string;
  error?: string;
  createdAt: string;
  artifactPath?: string;
};

export type QwenMissionAnalysis = {
  summary: string;
  projectType: string;
  complexity: "Low" | "Medium" | "High";
  features: string[];
  risks: string[];
  requiredRoles: string[];
  successCriteria: string[];
  approvalGates: string[];
};

export type OrganizationAgentDesign = {
  id: string;
  name: string;
  role: string;
  goal: string;
  tools: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
};

export type OrganizationDesign = {
  organizationName: string;
  agents: OrganizationAgentDesign[];
};

export type ReviewRubric = {
  status: string;
  decision: string;
  missingRequirements: string[];
  risks: string[];
  requestedChanges: string[];
  approvalConditions: string[];
};

export type FinalReportDraft = {
  missionStatus: string;
  completedFeatures: string[];
  openIssues: string[];
  mergedPRs: string[];
  releaseRecommendation: string;
  nextSteps: string[];
};

export type AgentToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "delete_file"
  | "create_branch"
  | "checkout_branch"
  | "commit_changes"
  | "get_diff"
  | "open_pr"
  | "research_web"
  | "fetch_url"
  | "complete_task"
  | "post_book_entry"
  | "read_book"
  | "answer_book_entry"
  | "read_signals"
  | "mark_signal_read";

export type AgentToolCall = {
  tool: AgentToolName;
  path?: string;
  content?: string;
  branch?: string;
  message?: string;
  baseBranch?: string;
  title?: string;
  summary?: string;
  entryId?: string;
  signalId?: string;
  query?: string;
  url?: string;
  entryType?: OrvixBookEntryType;
  scope?: OrvixBookScope;
  visibility?: OrvixBookVisibility;
  toAgentIds?: string[];
  topics?: string[];
  priority?: OrvixBookPriority;
};

export type AgentExecutionPlan = {
  summary: string;
  agentMessages?: string[];
  transcript?: Array<{
    type: "thought" | "observation" | "decision" | "handoff" | "tool_intent" | "review_note";
    text: string;
    beforeToolIndex?: number;
    tool?: AgentToolName;
    path?: string;
  }>;
  toolCalls: AgentToolCall[];
};

export type PullRequestReviewDecision = {
  decision: "approve" | "request_changes";
  summary: string;
  comments: string[];
  risks: string[];
};

export type OrvixBookEntryType =
  | "question"
  | "answer"
  | "note"
  | "assumption"
  | "proposal"
  | "decision"
  | "conflict"
  | "contract"
  | "handoff"
  | "review_note";

export type OrvixBookScope = "mission" | "team" | "agent" | "task" | "pr";
export type OrvixBookVisibility = "private" | "parent_tree" | "team" | "mentioned" | "global";
export type OrvixBookStatus = "open" | "answered" | "resolved" | "final";
export type OrvixBookPriority = "low" | "normal" | "high" | "urgent";

export type OrvixBookEntry = {
  id: string;
  type: OrvixBookEntryType;
  scope: OrvixBookScope;
  visibility: OrvixBookVisibility;
  fromAgentId: string;
  toAgentIds: string[];
  parentAgentId?: string;
  teamId?: string;
  taskId?: string;
  prId?: number;
  threadId?: string;
  replyTo?: string;
  topics: string[];
  message: string;
  status: OrvixBookStatus;
  priority: OrvixBookPriority;
  createdAt: string;
};

export type AgentSignal = {
  id: string;
  toAgentId: string;
  fromAgentId: string;
  bookEntryId: string;
  type: "mention" | "answer" | "conflict" | "decision" | "review" | "contract_update";
  message: string;
  status: "unread" | "read";
  createdAt: string;
};

export type OwnershipIndex = Record<string, string[]>;

export type OrvixBookContext = {
  entries: OrvixBookEntry[];
  unreadSignals: AgentSignal[];
  ownershipIndex: OwnershipIndex;
};

export type MissionAnalysis = {
  id: string;
  request: string;
  projectType: string;
  complexity: "Low" | "Medium" | "High";
  primaryGoal: string;
  strategy: string;
  features: string[];
  risks: string[];
  successCriteria: string[];
};

export type OrganizationNode = {
  id: string;
  name: string;
  role: string;
  children?: OrganizationNode[];
};

export type SimulationState = {
  phase: "loading" | "briefing" | "organizing" | "executing" | "final";
  analysis: MissionAnalysis;
  organization: OrganizationNode;
  agents: Agent[];
  agentCalls: AgentCall[];
  tasks: Task[];
  pullRequests: PullRequest[];
  events: TimelineEvent[];
  eventSequence: number;
  bookEntries: OrvixBookEntry[];
  agentSignals: AgentSignal[];
  ownershipIndex: OwnershipIndex;
  isComplete: boolean;
};
