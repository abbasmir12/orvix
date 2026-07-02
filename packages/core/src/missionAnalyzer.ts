import type { MissionAnalysis, OrganizationNode } from "./types.js";

const hasAny = (text: string, keywords: string[]) =>
  keywords.some((keyword) => text.includes(keyword));

const toMissionId = () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `mission_${suffix}`;
};

export function analyzeMission(request: string): MissionAnalysis {
  const normalized = request.toLowerCase();
  const features: string[] = [];

  if (hasAny(normalized, ["auth", "login", "signup", "user"])) features.push("Authentication");
  if (hasAny(normalized, ["dashboard", "analytics", "admin"])) features.push("Dashboard");
  if (hasAny(normalized, ["contact", "crm", "customer"])) features.push("Contacts");
  if (hasAny(normalized, ["note", "comment"])) features.push("Notes");
  if (hasAny(normalized, ["payment", "stripe", "billing"])) features.push("Payments");
  if (hasAny(normalized, ["mobile", "ios", "android"])) features.push("Mobile app");
  if (hasAny(normalized, ["game", "physics", "level"])) features.push("Gameplay");
  if (hasAny(normalized, ["data", "chart", "report", "visualization"])) features.push("Data visualization");

  const projectType = hasAny(normalized, ["game", "physics", "level"])
    ? "Game / Interactive App"
    : hasAny(normalized, ["mobile", "ios", "android"])
      ? "Mobile Product"
      : hasAny(normalized, ["data", "chart", "report", "visualization"])
        ? "Data Product"
        : "SaaS Web App";

  const complexity =
    features.length >= 6 || hasAny(normalized, ["enterprise", "multi-tenant", "realtime"])
      ? "High"
      : features.length <= 2
        ? "Low"
        : "Medium";

  return {
    id: toMissionId(),
    request,
    projectType,
    complexity,
    primaryGoal:
      projectType === "Game / Interactive App"
        ? "Coordinate a playable prototype delivery plan"
        : "Generate a production-ready MVP structure",
    strategy: "Dynamic organization + branch-based collaboration",
    features: features.length > 0 ? features : ["Core web experience", "Project structure"],
    risks: [
      "Unclear acceptance criteria may create reviewer churn",
      "Cross-agent dependencies can block implementation order",
      "Security and data model decisions need explicit review"
    ],
    successCriteria: [
      "Mission is decomposed into specialist-owned tasks",
      "At least one review cycle catches and resolves an issue",
      "MasterMind Agent approves a final release recommendation"
    ]
  };
}

export function createOrganization(analysis: MissionAnalysis): OrganizationNode {
  const request = analysis.request.toLowerCase();
  const frontendChildren: OrganizationNode[] = [];
  const backendChildren: OrganizationNode[] = [];
  const specialistNodes: OrganizationNode[] = [];

  if (hasAny(request, ["landing", "homepage", "marketing"])) {
    frontendChildren.push({
      id: "landing-page-agent",
      name: "Landing Page Agent",
      role: "Builds public product surfaces"
    });
  }

  if (hasAny(request, ["dashboard", "admin", "analytics"])) {
    frontendChildren.push({
      id: "dashboard-agent",
      name: "Dashboard Agent",
      role: "Builds authenticated workspace views"
    });
  }

  if (hasAny(request, ["auth", "login", "signup", "user"])) {
    backendChildren.push({
      id: "auth-agent",
      name: "Auth Agent",
      role: "Owns identity, sessions, and protected routes"
    });
  }

  if (hasAny(request, ["api", "contact", "crm", "customer", "note"])) {
    backendChildren.push({
      id: "api-agent",
      name: "API Agent",
      role: "Owns resource APIs and service contracts"
    });
  }

  if (hasAny(request, ["database", "schema", "crm", "contact", "note", "user"])) {
    backendChildren.push({
      id: "database-agent",
      name: "Database Agent",
      role: "Owns schema, migrations, and data relationships"
    });
  }

  if (hasAny(request, ["payment", "stripe", "billing"])) {
    specialistNodes.push({
      id: "payments-agent",
      name: "Payments Agent",
      role: "Owns billing workflow and payment provider integration"
    });
  }

  if (hasAny(request, ["mobile", "ios", "android"])) {
    specialistNodes.push({
      id: "mobile-agent",
      name: "Mobile Agent",
      role: "Owns native navigation and mobile UX"
    });
  }

  if (hasAny(request, ["game", "physics", "level"])) {
    specialistNodes.push(
      {
        id: "gameplay-agent",
        name: "Gameplay Agent",
        role: "Owns rules, loops, and player interactions"
      },
      {
        id: "physics-agent",
        name: "Physics Agent",
        role: "Owns motion, collision, and simulation constraints"
      }
    );
  }

  if (frontendChildren.length === 0) {
    frontendChildren.push({
      id: "ui-agent",
      name: "UI Agent",
      role: "Builds the primary user interface"
    });
  }

  if (backendChildren.length === 0) {
    backendChildren.push({
      id: "service-agent",
      name: "Service Agent",
      role: "Owns backend contracts and integration points"
    });
  }

  return {
    id: "mastermind-agent",
    name: "MasterMind Agent",
    role: "Owns mission strategy, delegation, and final approval",
    children: [
      { id: "strategy-agent", name: "Strategy Weaver", role: "Designs the agent society" },
      { id: "product-manager-agent", name: "Product Manager Agent", role: "Owns requirements and scope" },
      { id: "architect-agent", name: "Blueprint Architect", role: "Owns blueprint and technical plan" },
      {
        id: "frontend-manager",
        name: "Interface Guild Lead",
        role: "Coordinates UI implementation",
        children: frontendChildren
      },
      {
        id: "backend-manager",
        name: "Systems Guild Lead",
        role: "Coordinates services, data, and integration work",
        children: backendChildren
      },
      ...specialistNodes,
      { id: "qa-reviewer-agent", name: "Critic Council", role: "Reviews PRs and challenges weak assumptions" },
      { id: "release-agent", name: "Release Marshal", role: "Prepares final delivery report" }
    ]
  };
}
