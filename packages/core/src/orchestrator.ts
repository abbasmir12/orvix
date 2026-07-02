import type {
  Agent,
  AgentCall,
  MissionAnalysis,
  OrganizationDesign,
  OrganizationNode,
  OwnershipIndex,
  PullRequest,
  SimulationState,
  Task,
  TimelineEvent
} from "./types.js";

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "agent";

const eventId = () => `event-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const timelineHistoryLimit = 240;

export function appendTimelineEvent(
  state: SimulationState,
  message: string,
  severity: TimelineEvent["severity"] = "info"
): SimulationState {
  const eventSequence = state.eventSequence + 1;
  const seconds = eventSequence * 3 - 2;
  const event: TimelineEvent = {
    id: eventId(),
    time: `00:${seconds.toString().padStart(2, "0")}`,
    message,
    severity
  };

	  return {
	    ...state,
	    eventSequence,
	    events: [...state.events, event].slice(-timelineHistoryLimit)
	  };
	}

export function applyMissionAnalysis(
  state: SimulationState,
  analysis: Partial<MissionAnalysis>
): SimulationState {
  return {
    ...state,
    analysis: {
      ...state.analysis,
      ...analysis,
      id: state.analysis.id,
      request: state.analysis.request
    }
  };
}

function toAgent(design: OrganizationDesign["agents"][number], index: number): Agent {
  return {
    id: slug(design.id || design.name || `agent-${index + 1}`),
    name: design.name || `Agent ${index + 1}`,
    role: design.role || design.goal || "Owns assigned delivery work",
    currentActivity: "Waiting for assignment",
    status: "queued",
    progress: 0,
    confidence: 0.72
  };
}

function toOrganizationNode(agents: Agent[]): OrganizationNode {
  return {
    id: "mastermind-agent",
    name: "MasterMind Agent",
    role: "Supervisor, planner, and final arbiter",
    children: agents
      .filter((agent) => agent.id !== "mastermind-agent")
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role
      }))
  };
}

function toTask(design: OrganizationDesign["agents"][number], agent: Agent, index: number): Task {
  return {
    id: `task-${slug(agent.id)}-${String(index + 1).padStart(3, "0")}`,
    title: design.goal || `Complete ${agent.name} workstream`,
    ownerAgentId: agent.id,
    branch: `feat/${slug(agent.name)}`,
    dependencies: design.dependencies.map(slug),
    filesLikelyAffected: [`work/${slug(agent.name)}.md`],
    acceptanceCriteria: design.acceptanceCriteria.length > 0
      ? design.acceptanceCriteria
      : ["Workstream output is defined", "Acceptance criteria are satisfied", "Reviewer can inspect evidence"],
    status: "queued"
  };
}

function toPullRequest(task: Task, agent: Agent, index: number): PullRequest {
  return {
    id: index + 1,
    title: task.title,
    branch: task.branch,
    ownerAgentId: agent.id,
    ownerName: agent.name,
    summary: `${agent.name} delivery packet for ${task.title}.`,
    changedFiles: task.filesLikelyAffected,
    acceptanceCriteria: task.acceptanceCriteria,
    status: "Queued",
    reviewerStatus: "Pending",
    comments: []
  };
}

function toAgentCalls(agents: Agent[]): AgentCall[] {
  return agents
    .filter((agent) => agent.id !== "mastermind-agent")
    .map((agent, index) => ({
      id: `call-${slug(agent.id)}-${index + 1}`,
      from: "MasterMind Agent",
      to: agent.name,
      intent: `Delegate ${agent.role}`,
      signal: "Waiting for orchestration",
      status: "waiting"
    }));
}

export function createOwnershipIndex(agents: Agent[], tasks: Task[]): OwnershipIndex {
  const index: OwnershipIndex = {};
  const add = (topic: string, agentId: string) => {
    const normalized = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!normalized) return;
    index[normalized] = Array.from(new Set([...(index[normalized] ?? []), agentId]));
  };

  for (const agent of agents) {
    const text = `${agent.id} ${agent.name} ${agent.role}`.toLowerCase();
    add(agent.id, agent.id);
    for (const word of text.split(/[^a-z0-9]+/).filter((value) => value.length > 3)) {
      add(word, agent.id);
    }

    if (/database|schema|data|model|migration/.test(text)) {
      ["database", "schema", "users", "user-model", "contacts", "notes", "tenant"].forEach((topic) => add(topic, agent.id));
    }
    if (/auth|session|security|login|signup/.test(text)) {
      ["auth", "session", "login", "signup", "users", "security"].forEach((topic) => add(topic, agent.id));
    }
    if (/api|backend|route|service/.test(text)) {
      ["api", "routes", "contacts", "notes", "validation"].forEach((topic) => add(topic, agent.id));
    }
    if (/frontend|dashboard|interface|ui|page/.test(text)) {
      ["frontend", "dashboard", "ui", "pages", "components"].forEach((topic) => add(topic, agent.id));
    }
  }

  for (const task of tasks) {
    add(task.id, task.ownerAgentId);
    for (const word of `${task.title} ${task.filesLikelyAffected.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((value) => value.length > 3)) {
      add(word, task.ownerAgentId);
    }
  }

  return index;
}

export function applyOrganizationDesign(
  state: SimulationState,
  design: OrganizationDesign
): SimulationState {
  const designedAgents = design.agents.map(toAgent);
  const hasMasterMind = designedAgents.some((agent) => agent.id === "mastermind-agent");
  const agents: Agent[] = [
    ...(hasMasterMind ? [] : [{
      id: "mastermind-agent",
      name: "MasterMind Agent",
      role: "Supervisor, planner, and final arbiter",
      currentActivity: "Coordinating Qwen-designed organization",
      status: "active" as const,
      progress: 18,
      confidence: 0.86
    }]),
    ...designedAgents.slice(0, 20)
  ];

  const workerAgents = agents.filter((agent) => agent.id !== "mastermind-agent");
  const tasks = workerAgents.map((agent, index) => {
    const designAgent = design.agents.find((candidate) => slug(candidate.id || candidate.name) === agent.id) ?? design.agents[index];
    return toTask(designAgent, agent, index);
  });

  return appendTimelineEvent({
    ...state,
    phase: "organizing",
    organization: toOrganizationNode(agents),
    agents,
    agentCalls: toAgentCalls(agents),
    tasks,
    ownershipIndex: createOwnershipIndex(agents, tasks),
    pullRequests: tasks.map((task, index) => {
      const agent = agents.find((candidate) => candidate.id === task.ownerAgentId) ?? workerAgents[index];
      return toPullRequest(task, agent, index);
    })
  }, `Qwen designed ${design.organizationName || "a dynamic engineering organization"}`, "success");
}

export function advanceMissionState(state: SimulationState): SimulationState {
  if (state.phase === "loading") {
    return appendTimelineEvent({
      ...state,
      phase: "briefing",
      agents: state.agents.map((agent, index) => index <= 1
        ? { ...agent, status: "active", currentActivity: "Reading Qwen mission context", progress: Math.max(agent.progress, 24) }
        : agent)
    }, "MasterMind opened real orchestration loop", "success");
  }

  if (state.phase === "briefing" || state.phase === "organizing") {
    const firstTask = state.tasks[0];
    return appendTimelineEvent({
      ...state,
      phase: "executing",
      tasks: state.tasks.map((task, index) => index === 0 ? { ...task, status: "active" } : task),
      pullRequests: state.pullRequests.map((pr, index) => index === 0 ? { ...pr, status: "In progress", reviewerStatus: "Reviewing" } : pr),
      agents: state.agents.map((agent) => agent.id === firstTask?.ownerAgentId
        ? { ...agent, status: "active", currentActivity: "Executing assigned workstream", progress: Math.max(agent.progress, 35) }
        : agent),
      agentCalls: state.agentCalls.map((call, index) => index === 0 ? { ...call, status: "running", signal: "Delegation active" } : call)
    }, "Orchestrator started first Qwen-generated workstream", "success");
  }

  if (state.phase === "executing") {
    const activeTask = state.tasks.find((task) => task.status === "active" || task.status === "blocked");
    const queuedTask = state.tasks.find((task) => task.status === "queued");

    if (!activeTask && queuedTask) {
      return appendTimelineEvent({
        ...state,
        tasks: state.tasks.map((task) => task.id === queuedTask.id ? { ...task, status: "active" } : task),
        pullRequests: state.pullRequests.map((pr) => pr.ownerAgentId === queuedTask.ownerAgentId && pr.status === "Queued"
          ? { ...pr, status: "In progress", reviewerStatus: "Reviewing" }
          : pr),
        agents: state.agents.map((agent) => agent.id === queuedTask.ownerAgentId
          ? { ...agent, status: "active", currentActivity: "Executing assigned workstream", progress: Math.max(agent.progress, 42) }
          : agent)
      }, `Orchestrator assigned ${queuedTask.title}`, "info");
    }

    if (activeTask) {
      const activePr = state.pullRequests.find((pr) => pr.ownerAgentId === activeTask.ownerAgentId && pr.status !== "Approved");
      const shouldRequestChanges = activePr?.id === 2 && activePr.comments.length === 0;

      if (shouldRequestChanges && activePr) {
        return appendTimelineEvent({
          ...state,
          tasks: state.tasks.map((task) => task.id === activeTask.id ? { ...task, status: "blocked" } : task),
          pullRequests: state.pullRequests.map((pr) => pr.id === activePr.id
            ? {
              ...pr,
              status: "Changes requested",
              reviewerStatus: "Requested changes",
              comments: ["Qwen Critic Council requested clearer acceptance evidence before approval."]
            }
            : pr),
          agents: state.agents.map((agent) => agent.id === activeTask.ownerAgentId
            ? { ...agent, status: "blocked", currentActivity: "Addressing review comments", progress: Math.max(agent.progress, 64) }
            : agent)
        }, `Critic Council requested changes on PR #${activePr.id}`, "warning");
      }

      return appendTimelineEvent({
        ...state,
        tasks: state.tasks.map((task) => task.id === activeTask.id ? { ...task, status: "completed" } : task),
        pullRequests: state.pullRequests.map((pr) => pr.ownerAgentId === activeTask.ownerAgentId && pr.status !== "Approved"
          ? {
            ...pr,
            status: "Approved",
            reviewerStatus: "Approved",
            comments: pr.comments.length > 0 ? [...pr.comments, "Reviewer comments resolved."] : pr.comments
          }
          : pr),
        agents: state.agents.map((agent) => agent.id === activeTask.ownerAgentId
          ? { ...agent, status: "completed", currentActivity: "Workstream approved", progress: 100 }
          : agent)
      }, `Reviewer approved ${activeTask.title}`, "success");
    }

    const allDone = state.tasks.length > 0 && state.tasks.every((task) => task.status === "completed");
    if (allDone) {
      return appendTimelineEvent({
        ...state,
        phase: "final",
        isComplete: true,
        agents: state.agents.map((agent) => ({ ...agent, status: "completed", currentActivity: "Mission complete", progress: 100 })),
        agentCalls: state.agentCalls.map((call) => ({ ...call, status: "returned", signal: "Delivery approved" }))
      }, "MasterMind approved final Qwen-orchestrated delivery", "success");
    }
  }

  return state;
}
