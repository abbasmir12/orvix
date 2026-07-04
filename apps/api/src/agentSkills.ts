import { commitWorkspaceChanges, writeWorkspaceFile } from "@orvix/workspace";
import { appendEvent, mapWorkPacketForAgent, orvixMapContext, workspaceOf, type MissionRun } from "./run.js";
import type { Agent } from "@orvix/core";

/**
 * Deterministic per-agent skill charters. Skills are selected by matching the
 * agent's role and work packet against a small standards library — no LLM
 * call, so charters cost nothing to derive and are stable across sessions.
 * They are injected into each agent session (agentIdentity.yourSkills) and
 * published to the generated repo as AGENTS.md so the skill contract is
 * visible, reviewable, and part of the deliverable.
 */

type SkillBlock = { skill: string; rules: string[] };

const SKILL_LIBRARY: Array<{ match: RegExp; block: SkillBlock }> = [
  {
    match: /front|ui|interface|component|page|dashboard|form|list|view|react|next/i,
    block: {
      skill: "UI engineering",
      rules: [
        "Build small, typed, composable components; props express the data contract from the Orvix Map.",
        "Handle loading, empty, and error states for every data-driven view — no dead placeholders.",
        "Wire real interactions (submit, toggle, delete) to the state/storage layer, never local mock arrays.",
        "Match the design system tokens (colors, spacing, typography) defined in the Orvix Map."
      ]
    }
  },
  {
    match: /styl|css|design|theme|layout|responsive/i,
    block: {
      skill: "Styling and design systems",
      rules: [
        "Define tokens once (CSS variables or theme object) and reference them everywhere; no hardcoded hex values scattered in components.",
        "Mobile-first responsive layout; verify overflow and wrap behavior on narrow widths.",
        "Style states, not just structure: hover, focus-visible, disabled, and empty states.",
        "Never restructure another agent's component markup to make styling easier — request a hook/class via the Book."
      ]
    }
  },
  {
    match: /stor|data|persist|database|schema|model|state|hook/i,
    block: {
      skill: "State and data management",
      rules: [
        "Export every shared type/interface from the module that owns it; consumers import, never redeclare.",
        "The storage/state API is a published contract: post it to the Orvix Book early, then keep it stable.",
        "Handle corrupt/missing persisted data defensively (try/catch parse, fall back to defaults).",
        "Keep data operations pure and synchronous-looking from the consumer side; isolate side effects."
      ]
    }
  },
  {
    match: /api|backend|route|server|service|endpoint|auth|session/i,
    block: {
      skill: "API and backend engineering",
      rules: [
        "Validate every input at the boundary; return typed, consistent error shapes.",
        "Routes/handlers follow the Orvix Map dataContracts exactly — the frontend codes against them sight unseen.",
        "No secrets or environment-specific values hardcoded; read from configuration.",
        "Every endpoint you add must be reachable from the app the mission describes, not orphaned."
      ]
    }
  },
  {
    match: /orchestr|integrat|app shell|wiring|assembl|architect|lead|master/i,
    block: {
      skill: "Integration and orchestration",
      rules: [
        "You own the top-level composition (App/entry files): import teammates' real exports, never stub duplicates of their work.",
        "When a teammate's export does not exist yet, code against the Book contract and post the assumption.",
        "After integration, mentally trace the full user flow end-to-end: every mission-critical action must be wired.",
        "Prefer adapting your integration layer over asking teammates to change their published contracts."
      ]
    }
  },
  {
    match: /test|qa|quality|review|verif/i,
    block: {
      skill: "Verification",
      rules: [
        "Exercise the real user flow, not just types: does the primary mission action actually work?",
        "Findings must name the file, the expected behavior, and the observed behavior.",
        "Never sign off on placeholder or scaffold content reaching the user."
      ]
    }
  }
];

const UNIVERSAL_SKILL: SkillBlock = {
  skill: "Orvix engineering baseline",
  rules: [
    "Read before you write: inspect existing files you depend on so imports, names, and types line up.",
    "Stay inside your work packet's files; cross-boundary needs go through the Orvix Book as a question or contract.",
    "Small coherent commits with real messages; open your PR only after the code you wrote actually fits together.",
    "Deliver the mission's product, not a demo of effort: what the user sees must match what they asked for."
  ]
};

export function deriveAgentSkills(run: MissionRun, agent: Agent, taskId?: string) {
  const packet = mapWorkPacketForAgent(run, agent.id, taskId);
  const haystack = [
    agent.name,
    agent.role,
    String(packet?.suggestedAgentRole ?? ""),
    ...(packet?.owns ?? []).map(String),
    ...(packet?.mustCreateOrUpdate ?? []).map(String)
  ].join(" ");

  const matched = SKILL_LIBRARY.filter((entry) => entry.match.test(haystack)).map((entry) => entry.block);
  return {
    charter: [UNIVERSAL_SKILL, ...matched.slice(0, 2)],
    ownsFiles: packet?.mustCreateOrUpdate ?? [],
    packetId: packet?.id ?? null
  };
}

/** Publishes AGENTS.md into the generated repo: mission, roster, per-agent charters, and coordination rules. */
export function publishAgentsMd(run: MissionRun) {
  const map = orvixMapContext(run);
  const lines: string[] = [
    "# AGENTS.md — Orvix Agent Society",
    "",
    "## Mission",
    run.mission,
    "",
    map?.mapSummary ? `**Build contract:** ${map.mapSummary}\n` : "",
    "## Coordination rules",
    "- Each agent works on its own branch/worktree and owns the files in its work packet.",
    "- Cross-boundary changes are requested through the Orvix Book (questions, contracts, conflicts), never written directly.",
    "- Work lands through PRs reviewed by the Critic Council; main must always build.",
    "",
    "## Agents"
  ];

  for (const agent of run.state.agents) {
    const task = run.state.tasks.find((candidate) => candidate.ownerAgentId === agent.id);
    const skills = deriveAgentSkills(run, agent, task?.id);
    lines.push("", `### ${agent.name}`, `- **Role:** ${agent.role}`);
    if (task) lines.push(`- **Workstream:** ${task.title} (branch \`${task.branch}\`)`);
    if (skills.ownsFiles.length > 0) lines.push(`- **Owns:** ${skills.ownsFiles.map((file) => `\`${file}\``).join(", ")}`);
    for (const block of skills.charter) {
      lines.push(`- **Skill — ${block.skill}:**`);
      for (const rule of block.rules) lines.push(`  - ${rule}`);
    }
  }

  const content = `${lines.filter((line) => line !== undefined).join("\n")}\n`;
  const write = writeWorkspaceFile(workspaceOf(run), "AGENTS.md", content);
  if (!write.ok) {
    appendEvent(run, `Could not publish AGENTS.md: ${"error" in write ? write.error : "unknown error"}`, "warning");
    return false;
  }
  const commit = commitWorkspaceChanges(workspaceOf(run), "docs: publish AGENTS.md agent skill charters");
  appendEvent(run, `MasterMind published AGENTS.md with ${run.state.agents.length} agent skill charters${commit.ok ? "" : " (commit pending)"}`, "success");
  return true;
}
