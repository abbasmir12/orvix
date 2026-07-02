import { analyzeMission, createOrganization } from "./missionAnalyzer.js";
import { createOwnershipIndex } from "./orchestrator.js";
import type {
  AgentCall,
  AgentCallStatus,
  Agent,
  AgentStatus,
  PullRequest,
  PullRequestStatus,
  SimulationState,
  Task,
  TimelineEvent
} from "./types.js";

type AgentPatch = Partial<Pick<Agent, "status" | "currentActivity" | "progress" | "confidence">>;
type AgentCallPatch = Partial<Pick<AgentCall, "status" | "signal">>;
type PrPatch = Partial<Pick<PullRequest, "status" | "reviewerStatus" | "comments">>;

type SimulationStep = {
  phase?: SimulationState["phase"];
  event?: Omit<TimelineEvent, "id" | "time">;
  agents?: Record<string, AgentPatch>;
  calls?: Record<string, AgentCallPatch>;
  prs?: Record<number, PrPatch>;
  tasks?: Record<string, Partial<Pick<Task, "status">>>;
};

const padTime = (seconds: number) => `00:${seconds.toString().padStart(2, "0")}`;

export function createInitialSimulation(mission: string): SimulationState {
  const analysis = analyzeMission(mission);
  const organization = createOrganization(analysis);
  const workPlan = createWorkPlan(analysis.projectType, analysis.features);

  const agents: Agent[] = [
    {
      id: "mastermind-agent",
      name: "MasterMind Agent",
      role: "Supervisor, planner, and final arbiter",
      currentActivity: "Reading mission intent",
      status: "active",
      progress: 12,
      confidence: 0.72
    },
    {
      id: "strategy-agent",
      name: "Strategy Weaver",
      role: "Designs the agent society",
      currentActivity: "Waiting for summons",
      status: "queued",
      progress: 0,
      confidence: 0.0
    },
    {
      id: "architect-agent",
      name: "Blueprint Architect",
      role: "Turns strategy into modules and contracts",
      currentActivity: "Waiting on org map",
      status: "queued",
      progress: 0,
      confidence: 0.0
    },
    {
      id: "frontend-manager",
      name: "Interface Guild Lead",
      role: "Coordinates UI agents",
      currentActivity: "Waiting on blueprint",
      status: "queued",
      progress: 0,
      confidence: 0.0
    },
    {
      id: "backend-manager",
      name: "Systems Guild Lead",
      role: "Coordinates data, auth, and APIs",
      currentActivity: "Waiting on data model",
      status: "queued",
      progress: 0,
      confidence: 0.0
    },
    {
      id: "qa-reviewer-agent",
      name: "Critic Council",
      role: "Reviews PRs and challenges assumptions",
      currentActivity: "Waiting for review packet",
      status: "queued",
      progress: 0,
      confidence: 0.0
    },
    {
      id: "release-agent",
      name: "Release Marshal",
      role: "Packages final delivery decision",
      currentActivity: "Waiting for approvals",
      status: "queued",
      progress: 0,
      confidence: 0.0
    }
  ];

  const agentCalls: AgentCall[] = [
    {
      id: "call-strategy",
      from: "MasterMind Agent",
      to: "Strategy Weaver",
      intent: "Design the right agent society",
      signal: "Mission intent pending",
      status: "waiting"
    },
    {
      id: "call-architect",
      from: "Strategy Weaver",
      to: "Blueprint Architect",
      intent: "Create architecture and branch map",
      signal: "Waiting for organization design",
      status: "waiting"
    },
    {
      id: "call-interface",
      from: "Blueprint Architect",
      to: "Interface Guild Lead",
      intent: "Spin up UI implementation lane",
      signal: "Waiting for blueprint",
      status: "waiting"
    },
    {
      id: "call-systems",
      from: "Blueprint Architect",
      to: "Systems Guild Lead",
      intent: "Spin up backend/data lane",
      signal: "Waiting for blueprint",
      status: "waiting"
    },
    {
      id: "call-critic",
      from: "MasterMind Agent",
      to: "Critic Council",
      intent: "Review PRs and reject weak work",
      signal: "Waiting for PR packet",
      status: "waiting"
    },
    {
      id: "call-release",
      from: "MasterMind Agent",
      to: "Release Marshal",
      intent: "Assemble delivery verdict",
      signal: "Waiting for approvals",
      status: "waiting"
    }
  ];

  const tasks: Task[] = [
    {
      id: "task-architecture-001",
      title: "Create project architecture blueprint",
      ownerAgentId: "architect-agent",
      branch: "blueprint/project-architecture",
      dependencies: [],
      filesLikelyAffected: ["docs/architecture.md", "docs/task-graph.json"],
      acceptanceCriteria: ["Tech stack selected", "Modules identified", "Review checkpoints defined"],
      status: "active"
    },
    {
      id: "task-auth-001",
      title: workPlan.primary.title,
      ownerAgentId: "backend-manager",
      branch: workPlan.primary.branch,
      dependencies: ["task-database-001"],
      filesLikelyAffected: workPlan.primary.files,
      acceptanceCriteria: workPlan.primary.criteria,
      status: "queued"
    },
    {
      id: "task-dashboard-001",
      title: workPlan.experience.title,
      ownerAgentId: "frontend-manager",
      branch: workPlan.experience.branch,
      dependencies: ["task-architecture-001"],
      filesLikelyAffected: workPlan.experience.files,
      acceptanceCriteria: workPlan.experience.criteria,
      status: "queued"
    },
    {
      id: "task-contacts-api-001",
      title: workPlan.service.title,
      ownerAgentId: "backend-manager",
      branch: workPlan.service.branch,
      dependencies: ["task-database-001"],
      filesLikelyAffected: workPlan.service.files,
      acceptanceCriteria: workPlan.service.criteria,
      status: "queued"
    },
    {
      id: "task-database-001",
      title: workPlan.foundation.title,
      ownerAgentId: "backend-manager",
      branch: workPlan.foundation.branch,
      dependencies: ["task-architecture-001"],
      filesLikelyAffected: workPlan.foundation.files,
      acceptanceCriteria: workPlan.foundation.criteria,
      status: "queued"
    }
  ];

  const pullRequests: PullRequest[] = [
    {
      id: 1,
      title: "Project architecture blueprint",
      branch: "blueprint/project-architecture",
      ownerAgentId: "architect-agent",
      ownerName: "Blueprint Architect",
      summary: "Initial system structure, modules, and release gates.",
      changedFiles: ["docs/architecture.md", "docs/task-graph.json"],
      acceptanceCriteria: tasks[0].acceptanceCriteria,
      status: "In progress",
      reviewerStatus: "Pending",
      comments: []
    },
    {
      id: 2,
      title: workPlan.primary.prTitle,
      branch: workPlan.primary.branch,
      ownerAgentId: "backend-manager",
      ownerName: workPlan.primary.owner,
      summary: workPlan.primary.summary,
      changedFiles: workPlan.primary.files,
      acceptanceCriteria: tasks[1].acceptanceCriteria,
      status: "Queued",
      reviewerStatus: "Pending",
      comments: []
    },
    {
      id: 3,
      title: workPlan.experience.prTitle,
      branch: workPlan.experience.branch,
      ownerAgentId: "frontend-manager",
      ownerName: workPlan.experience.owner,
      summary: workPlan.experience.summary,
      changedFiles: workPlan.experience.files,
      acceptanceCriteria: tasks[2].acceptanceCriteria,
      status: "Queued",
      reviewerStatus: "Pending",
      comments: []
    },
    {
      id: 4,
      title: workPlan.service.prTitle,
      branch: workPlan.service.branch,
      ownerAgentId: "backend-manager",
      ownerName: workPlan.service.owner,
      summary: workPlan.service.summary,
      changedFiles: workPlan.service.files,
      acceptanceCriteria: tasks[3].acceptanceCriteria,
      status: "Queued",
      reviewerStatus: "Pending",
      comments: []
    },
    {
      id: 5,
      title: workPlan.foundation.prTitle,
      branch: workPlan.foundation.branch,
      ownerAgentId: "backend-manager",
      ownerName: workPlan.foundation.owner,
      summary: workPlan.foundation.summary,
      changedFiles: workPlan.foundation.files,
      acceptanceCriteria: tasks[4].acceptanceCriteria,
      status: "Queued",
      reviewerStatus: "Pending",
      comments: []
    }
  ];

  return {
    phase: "loading",
    analysis,
    organization,
    agents,
    agentCalls,
    tasks,
    pullRequests,
    events: [],
    eventSequence: 0,
    bookEntries: [],
    agentSignals: [],
    ownershipIndex: createOwnershipIndex(agents, tasks),
    isComplete: false
  };
}

type WorkItemTemplate = {
  title: string;
  prTitle: string;
  branch: string;
  owner: string;
  summary: string;
  files: string[];
  criteria: string[];
};

function createWorkPlan(projectType: string, features: string[]): Record<
  "primary" | "experience" | "service" | "foundation",
  WorkItemTemplate
> {
  if (projectType === "Game / Interactive App") {
    return {
      primary: {
        title: "Implement gameplay workflow plan",
        prTitle: "Gameplay loop",
        branch: "feat/gameplay-loop",
        owner: "Gameplay Agent",
        summary: "Core loop, win condition, and player interaction plan.",
        files: ["src/gameplay/loop.ts", "src/gameplay/rules.ts"],
        criteria: ["Core loop is defined", "Player actions are listed", "Win and fail states are covered"]
      },
      experience: {
        title: "Build interactive shell plan",
        prTitle: "Interactive shell",
        branch: features.includes("Mobile app") ? "feat/mobile-shell" : "feat/game-ui",
        owner: features.includes("Mobile app") ? "Mobile Agent" : "UI Agent",
        summary: "Primary game screen, navigation, and responsive interaction shell.",
        files: ["src/ui/game-screen.tsx", "src/ui/hud.tsx"],
        criteria: ["Main play surface exists", "HUD states are defined", "Input states are covered"]
      },
      service: {
        title: "Design simulation service contract",
        prTitle: "Simulation contract",
        branch: "feat/simulation-contract",
        owner: "Physics Agent",
        summary: "Motion, collision, and state update contract.",
        files: ["src/physics/world.ts", "src/physics/collisions.ts"],
        criteria: ["Motion rules are listed", "Collision boundaries are defined", "Frame update contract exists"]
      },
      foundation: {
        title: "Approve runtime state model",
        prTitle: "Runtime state model",
        branch: "feat/runtime-state",
        owner: "Blueprint Architect",
        summary: "Entities, state transitions, and persistence boundaries.",
        files: ["docs/runtime-state.md", "src/state/game-state.ts"],
        criteria: ["Entities are defined", "State transitions are defined", "Persistence boundary is clear"]
      }
    };
  }

  if (features.includes("Mobile app")) {
    return {
      primary: {
        title: "Implement mobile authentication flow plan",
        prTitle: "Mobile auth flow",
        branch: "feat/mobile-auth",
        owner: "Auth Agent",
        summary: "Mobile login, signup, session handling, and protected navigation.",
        files: ["src/screens/login.tsx", "src/screens/signup.tsx", "src/lib/auth.ts"],
        criteria: ["Login screen exists", "Signup screen exists", "Protected navigation is specified"]
      },
      experience: {
        title: "Build mobile home shell plan",
        prTitle: "Mobile home shell",
        branch: "feat/mobile-home",
        owner: "Mobile Agent",
        summary: "Primary mobile shell, tabs, and core empty states.",
        files: ["src/screens/home.tsx", "src/navigation/tabs.tsx"],
        criteria: ["Home shell exists", "Navigation is defined", "Loading states are covered"]
      },
      service: {
        title: "Design mobile API client",
        prTitle: "Mobile API client",
        branch: "feat/mobile-api-client",
        owner: "API Agent",
        summary: "Typed client contract, retries, and error handling.",
        files: ["src/lib/api-client.ts", "src/lib/errors.ts"],
        criteria: ["Client contract is listed", "Retry policy is specified", "Error states are handled"]
      },
      foundation: {
        title: "Approve app data model",
        prTitle: "App data model",
        branch: "feat/app-data-model",
        owner: "Database Agent",
        summary: "User-owned entities, local cache, and sync boundaries.",
        files: ["docs/data-model.md", "src/lib/storage.ts"],
        criteria: ["User model defined", "Core entities defined", "Sync boundary is clear"]
      }
    };
  }

  return {
    primary: {
      title: "Implement authentication workflow plan",
      prTitle: "Authentication workflow",
      branch: "feat/auth",
      owner: "Auth Agent",
      summary: "Login, signup, protected-route plan, and session boundary.",
      files: ["app/login/page.tsx", "app/signup/page.tsx", "lib/auth.ts"],
      criteria: ["Login page exists", "Signup page exists", "Protected routes are specified"]
    },
    experience: {
      title: "Build dashboard shell plan",
      prTitle: "Dashboard shell",
      branch: "feat/dashboard",
      owner: "Dashboard Agent",
      summary: "Authenticated dashboard layout and navigation shell.",
      files: ["app/dashboard/page.tsx", "components/dashboard-shell.tsx"],
      criteria: ["Dashboard shell exists", "Navigation is defined", "Loading states are covered"]
    },
    service: {
      title: "Design contacts API",
      prTitle: "Contacts API",
      branch: "feat/contacts-api",
      owner: "API Agent",
      summary: "Contacts CRUD contract and validation surface.",
      files: ["app/api/contacts/route.ts", "lib/contacts.ts"],
      criteria: ["CRUD routes are listed", "Validation is specified", "Auth boundary is defined"]
    },
    foundation: {
      title: "Approve database schema",
      prTitle: "Database schema",
      branch: "feat/database-schema",
      owner: "Database Agent",
      summary: "Users, contacts, notes, and ownership relationships.",
      files: ["db/schema.sql", "db/migrations/001_initial.sql"],
      criteria: ["Users table defined", "Contacts table defined", "Notes table defined"]
    }
  };
}

export const simulationSteps: SimulationStep[] = [
  {
    phase: "briefing",
    event: { message: "MasterMind Agent parsed mission and opened planning loop", severity: "success" },
    agents: {
      "mastermind-agent": { status: "active", currentActivity: "Summoning Strategy Weaver", progress: 36, confidence: 0.82 },
      "strategy-agent": { status: "active", currentActivity: "Designing agent society", progress: 28, confidence: 0.64 }
    },
    calls: {
      "call-strategy": { status: "calling", signal: "Summoned with mission brief" }
    }
  },
  {
    phase: "organizing",
    event: { message: "Strategy Weaver returned dynamic organization map", severity: "success" },
    agents: {
      "strategy-agent": { status: "completed", currentActivity: "Agent society designed", progress: 100, confidence: 0.9 },
      "architect-agent": { status: "active", currentActivity: "Drafting blueprint", progress: 38, confidence: 0.72 }
    },
    calls: {
      "call-strategy": { status: "returned", signal: "Org map accepted" },
      "call-architect": { status: "calling", signal: "Blueprint request dispatched" }
    }
  },
  {
    phase: "executing",
    event: { message: "Blueprint Architect split work into UI and systems lanes", severity: "success" },
    agents: {
      "mastermind-agent": { status: "active", currentActivity: "Monitoring parallel lanes", progress: 54, confidence: 0.86 },
      "architect-agent": { status: "completed", currentActivity: "Blueprint returned", progress: 100, confidence: 0.88 },
      "frontend-manager": { status: "active", currentActivity: "Calling UI specialists", progress: 24, confidence: 0.66 },
      "backend-manager": { status: "active", currentActivity: "Calling data specialists", progress: 18, confidence: 0.57 }
    },
    calls: {
      "call-architect": { status: "returned", signal: "Blueprint approved" },
      "call-interface": { status: "running", signal: "UI lane active" },
      "call-systems": { status: "running", signal: "Systems lane active" }
    },
    prs: {
      1: { status: "Approved", reviewerStatus: "Approved" },
      3: { status: "In progress", reviewerStatus: "Pending" }
    },
    tasks: {
      "task-architecture-001": { status: "completed" },
      "task-dashboard-001": { status: "active" },
      "task-database-001": { status: "active" }
    }
  },
  {
    event: { message: "Interface Guild Lead called Dashboard Agent for workspace shell", severity: "info" },
    agents: {
      "frontend-manager": { status: "active", currentActivity: "Dashboard Agent executing", progress: 52, confidence: 0.73 }
    },
    calls: {
      "call-interface": { status: "running", signal: "Dashboard specialist active" }
    }
  },
  {
    event: { message: "Systems Guild Lead blocked: schema approval required", severity: "warning" },
    agents: {
      "backend-manager": { status: "blocked", currentActivity: "Blocked by schema approval", progress: 32, confidence: 0.49 }
    },
    calls: {
      "call-systems": { status: "blocked", signal: "Needs schema before auth/API" }
    },
    prs: {
      5: { status: "In progress", reviewerStatus: "Pending" }
    },
    tasks: {
      "task-auth-001": { status: "blocked" },
      "task-contacts-api-001": { status: "blocked" }
    }
  },
  {
    event: { message: "MasterMind Agent rerouted priority to Database Agent", severity: "info" },
    agents: {
      "mastermind-agent": { status: "active", currentActivity: "Resolving dependency conflict", progress: 72, confidence: 0.86 },
      "backend-manager": { status: "active", currentActivity: "Schema lane reprioritized", progress: 52, confidence: 0.69 }
    },
    calls: {
      "call-systems": { status: "running", signal: "Database Agent promoted" }
    }
  },
  {
    event: { message: "Database Agent returned schema PR and unblocked systems lane", severity: "info" },
    agents: {
      "backend-manager": { status: "active", currentActivity: "Auth/API agents resumed", progress: 64, confidence: 0.74 }
    },
    calls: {
      "call-systems": { status: "running", signal: "Schema approved, auth/API resumed" }
    },
    prs: {
      5: { status: "Approved", reviewerStatus: "Approved" },
      2: { status: "In progress", reviewerStatus: "Pending" },
      4: { status: "In progress", reviewerStatus: "Pending" }
    },
    tasks: {
      "task-database-001": { status: "completed" },
      "task-auth-001": { status: "active" },
      "task-contacts-api-001": { status: "active" }
    }
  },
  {
    event: { message: "Auth Agent opened PR #2; MasterMind called Critic Council", severity: "info" },
    agents: {
      "backend-manager": { status: "active", currentActivity: "Auth PR ready for review", progress: 76, confidence: 0.8 },
      "qa-reviewer-agent": { status: "active", currentActivity: "Reviewing PR #2", progress: 34, confidence: 0.7 }
    },
    calls: {
      "call-critic": { status: "calling", signal: "Review packet PR #2" }
    }
  },
  {
    event: { message: "Critic Council rejected PR #2: missing protected-route fallback", severity: "warning" },
    agents: {
      "backend-manager": { status: "active", currentActivity: "Fixing auth error states", progress: 82, confidence: 0.78 },
      "qa-reviewer-agent": { status: "active", currentActivity: "Changes requested", progress: 58, confidence: 0.78 }
    },
    calls: {
      "call-critic": { status: "running", signal: "Requested changes" }
    },
    prs: {
      2: {
        status: "Changes requested",
        reviewerStatus: "Requested changes",
        comments: ["Missing explicit auth error handling and protected route fallback."]
      }
    }
  },
  {
    event: { message: "Auth Agent patched review comments and resubmitted", severity: "success" },
    agents: {
      "backend-manager": { status: "active", currentActivity: "Resubmitted PR #2", progress: 92, confidence: 0.84 },
      "qa-reviewer-agent": { status: "active", currentActivity: "Re-reviewing PR #2", progress: 76, confidence: 0.82 }
    },
    calls: {
      "call-critic": { status: "running", signal: "Re-reviewing fixed PR" }
    },
    prs: {
      2: {
        status: "In progress",
        reviewerStatus: "Reviewing",
        comments: ["Auth error handling added. Protected route fallback documented."]
      }
    }
  },
  {
    event: { message: "Critic Council approved PR #2 and returned release signal", severity: "success" },
    agents: {
      "mastermind-agent": { status: "active", currentActivity: "Awaiting release verdict", progress: 92, confidence: 0.9 },
      "backend-manager": { status: "completed", currentActivity: "Backend plan approved", progress: 100, confidence: 0.89 },
      "frontend-manager": { status: "completed", currentActivity: "Dashboard shell approved", progress: 100, confidence: 0.87 },
      "qa-reviewer-agent": { status: "completed", currentActivity: "PR review passed", progress: 100, confidence: 0.9 },
      "release-agent": { status: "active", currentActivity: "Preparing delivery report", progress: 72, confidence: 0.82 }
    },
    calls: {
      "call-interface": { status: "returned", signal: "UI lane approved" },
      "call-systems": { status: "returned", signal: "Systems lane approved" },
      "call-critic": { status: "returned", signal: "Review gate passed" },
      "call-release": { status: "calling", signal: "Prepare release verdict" }
    },
    prs: {
      2: { status: "Approved", reviewerStatus: "Approved" },
      3: { status: "Approved", reviewerStatus: "Approved" },
      4: { status: "Approved", reviewerStatus: "Approved" }
    },
    tasks: {
      "task-auth-001": { status: "completed" },
      "task-dashboard-001": { status: "completed" },
      "task-contacts-api-001": { status: "completed" }
    }
  },
  {
    phase: "final",
    event: { message: "MasterMind Agent approved final release plan", severity: "success" },
    agents: {
      "mastermind-agent": { status: "completed", currentActivity: "Final delivery approved", progress: 100, confidence: 0.93 },
      "release-agent": { status: "completed", currentActivity: "Delivery report complete", progress: 100, confidence: 0.9 }
    },
    calls: {
      "call-release": { status: "returned", signal: "Delivery verdict complete" }
    }
  }
];

export function applySimulationStep(
  state: SimulationState,
  step: SimulationStep,
  stepIndex: number
): SimulationState {
  const updateAgent = (agent: Agent): Agent => ({
    ...agent,
    ...(step.agents?.[agent.id] ?? {})
  });

  const updateTask = (task: Task): Task => ({
    ...task,
    ...(step.tasks?.[task.id] ?? {})
  });

  const updatePr = (pr: PullRequest): PullRequest => ({
    ...pr,
    ...(step.prs?.[pr.id] ?? {})
  });

  const updateAgentCall = (call: AgentCall): AgentCall => ({
    ...call,
    ...(step.calls?.[call.id] ?? {})
  });

  const eventSequence = step.event ? state.eventSequence + 1 : state.eventSequence;
  const nextEvents = step.event
    ? [
        ...state.events,
        {
          id: `event-${stepIndex}`,
          time: padTime(eventSequence * 3 - 2),
          ...step.event
        }
      ]
    : state.events;

  return {
    ...state,
    phase: step.phase ?? state.phase,
    agents: state.agents.map(updateAgent),
    agentCalls: state.agentCalls.map(updateAgentCall),
    tasks: state.tasks.map(updateTask),
    pullRequests: state.pullRequests.map(updatePr),
	    events: nextEvents.slice(-240),
    eventSequence,
    isComplete: step.phase === "final"
  };
}

export function nudgeActiveProgress(state: SimulationState): SimulationState {
  const incrementStatus = (status: AgentStatus | PullRequestStatus, progress: number) => {
    if (status === "active" || status === "In progress" || status === "Changes requested") {
      return Math.min(96, progress + 2);
    }
    return progress;
  };

  return {
    ...state,
    agents: state.agents.map((agent) => ({
      ...agent,
      progress: incrementStatus(agent.status, agent.progress)
    }))
  };
}
