import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";

export type Workspace = {
  missionId: string;
  rootDir: string;
  repoDir: string;
  docsDir: string;
  projectType?: ProjectScaffoldType;
  mainRepoDir?: string;
  worktreesDir?: string;
};

export type ProjectScaffoldType =
  | "nextjs"
  | "react-vite"
  | "express-api"
  | "node-cli"
  | "python"
  | "generic";

export type ProjectScaffold = {
  type: ProjectScaffoldType;
  label: string;
  files: string[];
  commands: string[];
};

export type WorkspaceFile = {
  path: string;
  type: "file" | "directory";
  size: number;
};

export type WorkspaceToolResult =
  | { ok: true; tool: "list_files"; files: WorkspaceFile[] }
  | { ok: true; tool: "read_file"; path: string; content: string }
  | {
      ok: true;
      tool: "write_file";
      path: string;
      bytes: number;
      existedBefore: boolean;
      beforeContent: string;
      afterContent: string;
      additions: number;
      removals: number;
      diff: string;
    }
  | { ok: true; tool: "delete_file"; path: string; existedBefore: boolean; output: string }
  | { ok: false; tool: string; error: string };

export type GitToolResult =
  | { ok: true; tool: "init_repo"; branch: string; commit?: string }
  | { ok: true; tool: "git_status"; branch: string; clean: boolean; output: string }
  | { ok: true; tool: "branch_exists"; branch: string; exists: boolean }
  | { ok: true; tool: "create_branch"; branch: string; output: string }
  | { ok: true; tool: "checkout_branch"; branch: string; output: string }
  | { ok: true; tool: "commit_changes"; branch: string; commit?: string; output: string }
  | { ok: true; tool: "get_diff"; branch: string; output: string }
  | { ok: true; tool: "merge_branch"; branch: string; output: string }
  | { ok: true; tool: "sync_branch"; branch: string; output: string }
  | { ok: false; tool: string; error: string };

const defaultWorkspaceRoot = () => resolve(process.cwd(), ".orvix", "workspaces");

const safeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "mission";

export function createMissionWorkspace(input: {
  missionId: string;
  mission: string;
  mode: string;
  root?: string;
  scaffoldType?: ProjectScaffoldType;
}): Workspace {
  const rootDir = resolve(input.root ?? process.env.ORVIX_WORKSPACE_ROOT ?? defaultWorkspaceRoot(), safeName(input.missionId));
  const repoDir = resolve(rootDir, "repo");
  const docsDir = resolve(repoDir, "docs");
  const worktreesDir = resolve(rootDir, "worktrees");
  const scaffoldType = input.scaffoldType ?? detectProjectScaffold(input.mission);

  mkdirSync(docsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  writeFileIfMissing(resolve(repoDir, "README.md"), [
    `# Orvix Mission Workspace`,
    "",
    `Mission ID: ${input.missionId}`,
    `Mode: ${input.mode}`,
    "",
    "This repository is the target workspace for Orvix agents.",
    "Agents may only modify it through allowlisted Orvix tools.",
    "",
    "## Mission",
    "",
    input.mission,
    ""
  ].join("\n"));
  const scaffold = scaffoldProject(repoDir, scaffoldType, input);
  writeFileIfMissing(resolve(docsDir, "orvix-mission.md"), [
    "# Mission Brief",
    "",
    input.mission,
    "",
    "## Workspace Contract",
    "",
    "- Orvix owns orchestration state outside this repo.",
    "- Agent file writes must stay inside this repo.",
    "- Tool calls are logged with the mission run.",
    `- Detected scaffold: ${scaffold.label}.`,
    `- Suggested commands: ${scaffold.commands.join(", ") || "none"}.`,
    ""
  ].join("\n"));
  writeFileIfMissing(resolve(repoDir, ".gitignore"), [
    "node_modules/",
    "dist/",
    ".next/",
    "coverage/",
    "*.tsbuildinfo",
    ".env",
    ".DS_Store",
    ""
  ].join("\n"));

  initWorkspaceGit({ missionId: input.missionId, rootDir, repoDir, docsDir });

  return {
    missionId: input.missionId,
    rootDir,
    repoDir,
    docsDir,
    projectType: scaffold.type,
    mainRepoDir: repoDir,
    worktreesDir
  };
}

export function detectProjectScaffold(mission: string): ProjectScaffoldType {
  const text = mission.toLowerCase();
  if (/2d|browser game|web game|puzzle game|arcade|gameplay|canvas game|three\.?js|phaser|platformer|shooter/.test(text)) return "react-vite";
  if (/next\.?js|nextjs|app router|next app/.test(text)) return "nextjs";
  if (/(saas|crm|dashboard|admin panel|auth|login|signup|contacts|notes).*(web|app|site|portal|dashboard)?/.test(text)) return "nextjs";
  if (/react|vite|single page|spa|frontend|landing page|dashboard ui/.test(text)) return "react-vite";
  if (/express|rest api|node api|backend api|server api/.test(text)) return "express-api";
  if (/cli|command line|terminal tool/.test(text)) return "node-cli";
  if (/python|fastapi|flask|data science|notebook/.test(text)) return "python";
  return "generic";
}

export function scaffoldProject(repoDir: string, type: ProjectScaffoldType, input: { missionId: string; mission: string }): ProjectScaffold {
  switch (type) {
    case "nextjs":
      return scaffoldNextJs(repoDir, input);
    case "react-vite":
      return scaffoldReactVite(repoDir, input);
    case "express-api":
      return scaffoldExpressApi(repoDir, input);
    case "node-cli":
      return scaffoldNodeCli(repoDir, input);
    case "python":
      return scaffoldPython(repoDir, input);
    default:
      return scaffoldGeneric(repoDir, input);
  }
}

export function initWorkspaceGit(workspace: Workspace): GitToolResult {
  try {
    if (!existsSync(resolve(workspace.repoDir, ".git"))) {
      runGit(workspace, ["init"]);
      runGit(workspace, ["checkout", "-B", "main"]);
      runGit(workspace, ["config", "user.name", "Orvix"]);
      runGit(workspace, ["config", "user.email", "orvix@local"]);
      runGit(workspace, ["add", "."]);
      runGit(workspace, ["commit", "-m", "chore: initialize Orvix mission workspace"]);
    }

    return {
      ok: true,
      tool: "init_repo",
      branch: currentBranch(workspace),
      commit: currentCommit(workspace)
    };
  } catch (error) {
    return { ok: false, tool: "init_repo", error: errorMessage(error) };
  }
}

export function getGitStatus(workspace: Workspace): GitToolResult {
  try {
    const output = runGit(workspace, ["status", "--short", "--branch"]);
    return {
      ok: true,
      tool: "git_status",
      branch: currentBranch(workspace),
      clean: output.trim().split(/\r?\n/).length <= 1,
      output
    };
  } catch (error) {
    return { ok: false, tool: "git_status", error: errorMessage(error) };
  }
}

export function branchExists(workspace: Workspace, branch: string): GitToolResult {
  try {
    const safeBranch = validateBranchName(branch);
    try {
      runGit(workspace, ["show-ref", "--verify", "--quiet", `refs/heads/${safeBranch}`]);
      return {
        ok: true,
        tool: "branch_exists",
        branch: safeBranch,
        exists: true
      };
    } catch {
      return {
        ok: true,
        tool: "branch_exists",
        branch: safeBranch,
        exists: false
      };
    }
  } catch (error) {
    return { ok: false, tool: "branch_exists", error: errorMessage(error) };
  }
}

export function createGitBranch(workspace: Workspace, branch: string, baseBranch = "main"): GitToolResult {
  try {
    const safeBranch = validateBranchName(branch);
    const safeBaseBranch = validateBranchName(baseBranch);
    runGit(workspace, ["checkout", safeBaseBranch]);
    const output = runGit(workspace, ["checkout", "-B", safeBranch]);
    return {
      ok: true,
      tool: "create_branch",
      branch: safeBranch,
      output
    };
  } catch (error) {
    return { ok: false, tool: "create_branch", error: errorMessage(error) };
  }
}

export function ensureAgentWorktree(workspace: Workspace, agentId: string, branch: string, baseBranch = "main"): Workspace | GitToolResult {
  try {
    const safeAgent = safeName(agentId);
    const safeBranch = validateBranchName(branch);
    const safeBaseBranch = validateBranchName(baseBranch);
    const worktreesDir = workspace.worktreesDir ?? resolve(workspace.rootDir, "worktrees");
    const repoDir = resolve(worktreesDir, `${safeAgent}-${safeName(safeBranch)}`);
    const docsDir = resolve(repoDir, "docs");
    const mainWorkspace = mainWorkspaceFor(workspace);

    mkdirSync(worktreesDir, { recursive: true });
    if (!existsSync(resolve(repoDir, ".git"))) {
      const exists = branchExists(mainWorkspace, safeBranch);
      if (!exists.ok) return exists;

      if (exists.tool === "branch_exists" && exists.exists) {
        runGit(mainWorkspace, ["worktree", "add", repoDir, safeBranch]);
      } else {
        runGit(mainWorkspace, ["worktree", "add", "-b", safeBranch, repoDir, safeBaseBranch]);
      }
    }

    mkdirSync(docsDir, { recursive: true });
    return {
      missionId: workspace.missionId,
      rootDir: workspace.rootDir,
      repoDir,
      docsDir,
      mainRepoDir: workspace.mainRepoDir ?? workspace.repoDir,
      worktreesDir
    };
  } catch (error) {
    return { ok: false, tool: "create_worktree", error: errorMessage(error) };
  }
}

export function getBranchDiff(workspace: Workspace, branch: string, baseBranch = "main"): GitToolResult {
  try {
    const safeBranch = validateBranchName(branch);
    const safeBaseBranch = validateBranchName(baseBranch);
    const output = runGit(mainWorkspaceFor(workspace), ["diff", `${safeBaseBranch}...${safeBranch}`, "--"]);
    return {
      ok: true,
      tool: "get_diff",
      branch: safeBranch,
      output
    };
  } catch (error) {
    return { ok: false, tool: "get_diff", error: errorMessage(error) };
  }
}

export function checkoutGitBranch(workspace: Workspace, branch: string): GitToolResult {
  try {
    const safeBranch = validateBranchName(branch);
    const output = runGit(workspace, ["checkout", safeBranch]);
    return {
      ok: true,
      tool: "checkout_branch",
      branch: safeBranch,
      output
    };
  } catch (error) {
    return { ok: false, tool: "checkout_branch", error: errorMessage(error) };
  }
}

export function commitWorkspaceChanges(workspace: Workspace, message: string): GitToolResult {
  try {
    runGit(workspace, ["add", "."]);
    const status = runGit(workspace, ["status", "--short"]);
    if (!status.trim()) {
      return {
        ok: true,
        tool: "commit_changes",
        branch: currentBranch(workspace),
        output: "No changes to commit."
      };
    }

    const cleanMessage = message.trim().slice(0, 120) || "chore: agent workspace update";
    const output = runGit(workspace, ["commit", "-m", cleanMessage]);
    return {
      ok: true,
      tool: "commit_changes",
      branch: currentBranch(workspace),
      commit: currentCommit(workspace),
      output
    };
  } catch (error) {
    return { ok: false, tool: "commit_changes", error: errorMessage(error) };
  }
}

export function getWorkspaceDiff(workspace: Workspace, baseBranch = "main"): GitToolResult {
  try {
    const safeBranch = validateBranchName(baseBranch);
    const output = runGit(workspace, ["diff", `${safeBranch}...HEAD`, "--"]);
    return {
      ok: true,
      tool: "get_diff",
      branch: currentBranch(workspace),
      output
    };
  } catch (error) {
    return { ok: false, tool: "get_diff", error: errorMessage(error) };
  }
}

export function mergeWorkspaceBranch(workspace: Workspace, branch: string, targetBranch = "main"): GitToolResult {
  const mainWorkspace = mainWorkspaceFor(workspace);
  try {
    const safeBranch = validateBranchName(branch);
    const safeTargetBranch = validateBranchName(targetBranch);
    runGit(mainWorkspace, ["checkout", safeTargetBranch]);
    const output = runGit(mainWorkspace, ["merge", "--no-ff", safeBranch, "-m", `merge: ${safeBranch}`]);

    return {
      ok: true,
      tool: "merge_branch",
      branch: safeTargetBranch,
      output
    };
  } catch (error) {
    try {
      runGit(mainWorkspace, ["merge", "--abort"]);
    } catch {
      // Nothing to abort, or abort failed because merge did not start.
    }
    return { ok: false, tool: "merge_branch", error: errorMessage(error) };
  }
}

export function syncWorkspaceBranch(workspace: Workspace, branch: string, sourceBranch = "main"): GitToolResult {
  try {
    const safeBranch = validateBranchName(branch);
    const safeSourceBranch = validateBranchName(sourceBranch);
    runGit(workspace, ["checkout", safeBranch]);
    // No -X theirs fallback: auto-resolving conflicts in favor of main silently
    // destroys the branch owner's in-progress work and triggers confused
    // revision loops. A conflicted sync must fail so it is routed to the owner.
    const output = runGit(workspace, ["merge", "--no-ff", safeSourceBranch, "-m", `sync: ${safeBranch} with ${safeSourceBranch}`]);
    return {
      ok: true,
      tool: "sync_branch",
      branch: safeBranch,
      output
    };
  } catch (error) {
    try {
      runGit(workspace, ["merge", "--abort"]);
    } catch {
      // Nothing to abort, or abort failed because merge did not start.
    }
    return { ok: false, tool: "sync_branch", error: errorMessage(error) };
  }
}

export function listWorkspaceFiles(workspace: Workspace, input: { path?: string; depth?: number } = {}): WorkspaceToolResult {
  try {
    const baseDir = resolveWorkspacePath(workspace, input.path ?? ".");
    const files = walkFiles(workspace.repoDir, baseDir, input.depth ?? 2);
    return { ok: true, tool: "list_files", files };
  } catch (error) {
    return { ok: false, tool: "list_files", error: errorMessage(error) };
  }
}

export function readWorkspaceFile(workspace: Workspace, path: string): WorkspaceToolResult {
  try {
    const absolutePath = resolveWorkspacePath(workspace, path);
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error(`${path} is not a file`);
    }

    return {
      ok: true,
      tool: "read_file",
      path: toWorkspaceRelative(workspace.repoDir, absolutePath),
      content: readFileSync(absolutePath, "utf8")
    };
  } catch (error) {
    return { ok: false, tool: "read_file", error: errorMessage(error) };
  }
}

export function writeWorkspaceFile(workspace: Workspace, path: string, content: string): WorkspaceToolResult {
  try {
    const absolutePath = resolveWorkspacePath(workspace, path);
    const existedBefore = existsSync(absolutePath);
    const beforeContent = existedBefore ? readFileSync(absolutePath, "utf8") : "";
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
    const relativePath = toWorkspaceRelative(workspace.repoDir, absolutePath);
    const patch = createUnifiedDiff(relativePath, beforeContent, content, existedBefore);

    return {
      ok: true,
      tool: "write_file",
      path: relativePath,
      bytes: Buffer.byteLength(content),
      existedBefore,
      beforeContent,
      afterContent: content,
      additions: patch.additions,
      removals: patch.removals,
      diff: patch.diff
    };
  } catch (error) {
    return { ok: false, tool: "write_file", error: errorMessage(error) };
  }
}

export function deleteWorkspacePath(workspace: Workspace, path: string): WorkspaceToolResult {
  try {
    const absolutePath = resolveWorkspacePath(workspace, path);
    const relativePath = toWorkspaceRelative(workspace.repoDir, absolutePath);
    if (relativePath === "." || relativePath === ".git" || relativePath.startsWith(`.git${sep}`)) {
      throw new Error("Refusing to delete protected workspace path");
    }

    const existedBefore = existsSync(absolutePath);
    if (existedBefore) {
      rmSync(absolutePath, { recursive: true, force: true });
    }

    return {
      ok: true,
      tool: "delete_file",
      path: relativePath,
      existedBefore,
      output: existedBefore ? `Deleted ${relativePath}` : `${relativePath} did not exist`
    };
  } catch (error) {
    return { ok: false, tool: "delete_file", error: errorMessage(error) };
  }
}

type DiffEdit =
  | { kind: "context"; line: string }
  | { kind: "add"; line: string }
  | { kind: "remove"; line: string };

function createUnifiedDiff(path: string, beforeContent: string, afterContent: string, existedBefore: boolean) {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  const edits = diffLines(beforeLines, afterLines);
  const additions = edits.filter((edit) => edit.kind === "add").length;
  const removals = edits.filter((edit) => edit.kind === "remove").length;
  const oldCount = Math.max(1, beforeLines.length);
  const newCount = Math.max(1, afterLines.length);
  const body = edits.map((edit) => {
    if (edit.kind === "add") return `+${edit.line}`;
    if (edit.kind === "remove") return `-${edit.line}`;
    return ` ${edit.line}`;
  });

  return {
    additions,
    removals,
    diff: [
      `diff --git a/${path} b/${path}`,
      existedBefore ? `--- a/${path}` : "--- /dev/null",
      `+++ b/${path}`,
      `@@ -1,${oldCount} +1,${newCount} @@`,
      ...body
    ].join("\n")
  };
}

function splitLines(content: string) {
  if (!content) return [];
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized ? normalized.split(/\r?\n/) : [];
}

function diffLines(beforeLines: string[], afterLines: string[]): DiffEdit[] {
  const rows = beforeLines.length;
  const columns = afterLines.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(columns + 1).fill(0));

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] = beforeLines[row] === afterLines[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const edits: DiffEdit[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (beforeLines[row] === afterLines[column]) {
      edits.push({ kind: "context", line: beforeLines[row] });
      row += 1;
      column += 1;
      continue;
    }

    if (table[row + 1][column] >= table[row][column + 1]) {
      edits.push({ kind: "remove", line: beforeLines[row] });
      row += 1;
    } else {
      edits.push({ kind: "add", line: afterLines[column] });
      column += 1;
    }
  }

  while (row < rows) {
    edits.push({ kind: "remove", line: beforeLines[row] });
    row += 1;
  }

  while (column < columns) {
    edits.push({ kind: "add", line: afterLines[column] });
    column += 1;
  }

  return edits;
}

function writeFileIfMissing(path: string, content: string) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

function scaffoldNextJs(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const name = safeName(input.missionId);
  const files = [
    "package.json",
    "tsconfig.json",
    "next.config.mjs",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "next-env.d.ts",
    "README.md"
  ];

  writeFileIfMissing(resolve(repoDir, "package.json"), JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      lint: "next lint"
    },
    dependencies: {
      "@types/node": "^22.10.2",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
      "drizzle-orm": "^0.38.3",
      "jsonwebtoken": "^9.0.2",
      "next": "^15.1.0",
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "typescript": "^5.7.2",
      "zod": "^3.24.1"
    },
    devDependencies: {
      "@types/jsonwebtoken": "^9.0.7"
    }
  }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      baseUrl: ".",
      paths: {
        "@/*": ["./src/*", "./*"]
      },
      plugins: [{ name: "next" }]
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules", "tests", "**/*.test.ts", "**/*.spec.ts"]
  }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "next.config.mjs"), "const nextConfig = {};\n\nexport default nextConfig;\n");
  writeFileIfMissing(resolve(repoDir, "next-env.d.ts"), [
    "/// <reference types=\"next\" />",
    "/// <reference types=\"next/image-types/global\" />",
    "",
    "// This file is generated by Orvix so runtime Next.js builds do not dirty the workspace.",
    ""
  ].join("\n"));
  writeFileIfMissing(resolve(repoDir, "app/layout.tsx"), [
    "import './globals.css';",
    "import type { Metadata } from 'next';",
    "",
    "export const metadata: Metadata = {",
    "  title: 'Orvix Generated App',",
    "  description: 'A runnable Next.js scaffold prepared by Orvix.'",
    "};",
    "",
    "export default function RootLayout({ children }: { children: React.ReactNode }) {",
    "  return (",
    "    <html lang=\"en\">",
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}",
    ""
  ].join("\n"));
  writeFileIfMissing(resolve(repoDir, "app/page.tsx"), missionAwareNextPage(input.mission));
  writeMissionAwareNextRoutes(repoDir, input.mission);
  writeFileIfMissing(resolve(repoDir, "app/globals.css"), missionAwareProductCss());
  writeFileIfMissing(resolve(repoDir, "README.md"), scaffoldReadme("Next.js", input.mission, ["npm install", "npm run dev", "npm run build"]));
  return { type: "nextjs", label: "Next.js App Router", files, commands: ["npm install", "npm run dev", "npm run build"] };
}

function writeMissionAwareNextRoutes(repoDir: string, mission: string) {
  const text = mission.toLowerCase();
  const productName = productNameForMission(mission);
  for (const link of navLinksForMission(mission)) {
    if (link.href === "/" || link.href === "/login") continue;
    const route = link.href.replace(/^\//, "");
    writeFileIfMissing(resolve(repoDir, "app", route, "page.tsx"), routePage(link.label, `${link.label} workspace for ${productName}.`, ["Plan", "Build", "Review"]));
  }
  if (text.includes("dashboard")) {
    writeFileIfMissing(resolve(repoDir, "app/dashboard/page.tsx"), routePage("Dashboard", "Revenue, activity, contacts, and note velocity in one operator view.", ["Pipeline health", "Recent notes", "Team workload"]));
  }
  if (text.includes("contacts")) {
    const contactsPage = routePage("Contacts", "Search, segment, and manage tenant-scoped customer records.", ["Advanced search", "Lifecycle stage", "Owner assignment"]);
    writeFileIfMissing(resolve(repoDir, "app/contacts/page.tsx"), contactsPage);
    writeFileIfMissing(resolve(repoDir, "app/dashboard/contacts/page.tsx"), contactsPage);
  }
  if (text.includes("notes")) {
    writeFileIfMissing(resolve(repoDir, "app/notes/page.tsx"), routePage("Notes", "Capture relationship context, follow-ups, and account history.", ["Linked contacts", "Rich activity log", "Version history"]));
  }
  if (text.includes("auth") || text.includes("login") || text.includes("signup")) {
    writeFileIfMissing(resolve(repoDir, "app/login/page.tsx"), [
      "export default function LoginPage() {",
      "  return (",
      "    <main className=\"auth-screen\">",
      "      <section className=\"auth-panel\">",
      "        <p className=\"eyebrow\">Secure workspace access</p>",
      `        <h1>Sign in to ${productName}</h1>`,
      "        <label>Email<input defaultValue=\"admin@acme.test\" /></label>",
      "        <label>Password<input type=\"password\" defaultValue=\"password\" /></label>",
      "        <button>Continue</button>",
      "      </section>",
      "    </main>",
      "  );",
      "}",
      ""
    ].join("\n"));
  }
}

function missionAwareNextPage(mission: string) {
  const text = mission.toLowerCase();
  const isCrm = /crm|contacts|notes/.test(text);
  const productName = productNameForMission(mission);
  const title = isCrm ? "SaaS CRM Command Center" : "Production Workspace";
  const subtitle = isCrm
    ? "Authentication, dashboard metrics, contacts, and relationship notes organized for a real operator workflow."
    : "A mission-aware product surface ready for specialist Orvix agents to extend.";
  const modules = modulesForMission(mission);
  const navLinks = navLinksForMission(mission);
  const metrics = metricCardsForMission(mission);

  return [
    `const modules = ${JSON.stringify(modules)};`,
    "",
    "export default function Home() {",
    "  return (",
    "    <main className=\"product-shell\">",
    "      <aside className=\"sidebar\">",
    `        <strong>${productName}</strong>`,
    "        <nav>",
    ...navLinks.map((link) => `          <a href="${link.href}">${link.label}</a>`),
    "        </nav>",
    "      </aside>",
    "      <section className=\"workspace\">",
    "        <p className=\"eyebrow\">Mission-ready MVP</p>",
    `        <h1>${title}</h1>`,
    `        <p className=\"lede\">${subtitle}</p>`,
    "        <div className=\"metric-grid\">",
    ...metrics.map((card) => `          <article><span>${card.label}</span><strong>${card.value}</strong><small>${card.detail}</small></article>`),
    "        </div>",
    "        <div className=\"module-grid\">",
    "          {modules.map((module) => <article key={module}><span>{module}</span><p>Owned by a specialist agent and ready for PR review.</p></article>)}",
    "        </div>",
    "      </section>",
    "    </main>",
    "  );",
    "}",
    ""
  ].join("\n");
}

function routePage(title: string, description: string, items: string[]) {
  return [
    `const items = ${JSON.stringify(items)};`,
    "",
    `export default function ${title.replace(/[^a-zA-Z0-9]/g, "")}Page() {`,
    "  return (",
    "    <main className=\"route-shell\">",
    `      <p className=\"eyebrow\">${title}</p>`,
    `      <h1>${title}</h1>`,
    `      <p className=\"lede\">${description}</p>`,
    "      <div className=\"module-grid\">",
    "        {items.map((item) => <article key={item}><span>{item}</span><p>Specialist implementation surface prepared for production hardening.</p></article>)}",
    "      </div>",
    "    </main>",
    "  );",
    "}",
    ""
  ].join("\n");
}

function productNameForMission(mission: string) {
  const text = mission.toLowerCase();
  if (/crm|contacts|notes/.test(text)) return "Orvix CRM";
  if (/game|play|arcade|level/.test(text)) return "Orvix Game Studio";
  if (/data|analytics|report|chart/.test(text)) return "Orvix Analytics";
  if (/api|backend|service/.test(text)) return "Orvix Service";
  if (/mobile|ios|android/.test(text)) return "Orvix Mobile";
  return "Orvix Product";
}

function modulesForMission(mission: string) {
  const text = mission.toLowerCase();
  const modules = new Set<string>();
  if (text.includes("auth") || text.includes("login")) modules.add("Authentication");
  if (text.includes("dashboard")) modules.add("Dashboard");
  if (text.includes("contacts")) modules.add("Contacts");
  if (text.includes("notes")) modules.add("Notes");
  if (/game|play|arcade|level/.test(text)) ["Gameplay", "Levels", "Score"].forEach((module) => modules.add(module));
  if (/data|analytics|chart|report/.test(text)) ["Data Model", "Charts", "Reports"].forEach((module) => modules.add(module));
  if (/api|backend|service/.test(text)) ["API", "Validation", "Persistence"].forEach((module) => modules.add(module));
  if (/mobile|ios|android/.test(text)) ["Mobile Shell", "Offline Sync", "Notifications"].forEach((module) => modules.add(module));
  if (modules.size === 0) ["Overview", "Workflow", "Settings"].forEach((module) => modules.add(module));
  return Array.from(modules).slice(0, 6);
}

function navLinksForMission(mission: string) {
  const links = [{ href: "/", label: "Home" }];
  for (const module of modulesForMission(mission)) {
    const slug = module.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    links.push({ href: `/${slug}`, label: module });
  }
  if (mission.toLowerCase().includes("auth") || mission.toLowerCase().includes("login")) {
    links.push({ href: "/login", label: "Login" });
  }
  return links.slice(0, 6);
}

function metricCardsForMission(mission: string) {
  const text = mission.toLowerCase();
  if (/crm|contacts|notes/.test(text)) {
    return [
      { label: "Contacts", value: "248", detail: "42 need follow-up" },
      { label: "Notes", value: "1,284", detail: "Synced to accounts" },
      { label: "Pipeline", value: "$186K", detail: "Open opportunities" }
    ];
  }
  if (/game|play|arcade|level/.test(text)) {
    return [
      { label: "Scenes", value: "8", detail: "Playable loop ready" },
      { label: "FPS Target", value: "60", detail: "Responsive input" },
      { label: "Systems", value: "5", detail: "Gameplay modules" }
    ];
  }
  if (/data|analytics|chart|report/.test(text)) {
    return [
      { label: "Datasets", value: "4", detail: "Connected sources" },
      { label: "Charts", value: "12", detail: "Interactive views" },
      { label: "Reports", value: "3", detail: "Export-ready" }
    ];
  }
  return [
    { label: "Modules", value: "6", detail: "Agent-owned areas" },
    { label: "Checks", value: "14", detail: "Runtime gates" },
    { label: "PRs", value: "Ready", detail: "Reviewable workflow" }
  ];
}

function scaffoldReactVite(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const name = safeName(input.missionId);
  const files = ["package.json", "index.html", "tsconfig.json", "vite.config.ts", "src/main.tsx", "src/App.tsx", "src/styles.css", "README.md"];
  writeFileIfMissing(resolve(repoDir, "package.json"), JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
    dependencies: { "@vitejs/plugin-react": "^4.3.4", "vite": "^6.0.5", "typescript": "^5.7.2", "react": "^18.3.1", "react-dom": "^18.3.1", "@types/react": "^18.3.12", "@types/react-dom": "^18.3.1" }
  }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "index.html"), "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script>\n");
  writeFileIfMissing(resolve(repoDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["DOM", "DOM.Iterable", "ES2020"], allowImportingTsExtensions: true, skipLibCheck: true, esModuleInterop: true, allowSyntheticDefaultImports: true, strict: true, forceConsistentCasingInFileNames: true, module: "ESNext", moduleResolution: "Node", resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx" }, include: ["src"] }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "vite.config.ts"), "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n");
  writeFileIfMissing(resolve(repoDir, "src/main.tsx"), "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './styles.css';\n\nReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);\n");
  writeFileIfMissing(resolve(repoDir, "src/App.tsx"), "export default function App() {\n  return <main className=\"shell\"><section className=\"hero\"><p className=\"eyebrow\">Orvix Project Scaffold</p><h1>Runnable React app</h1><p className=\"lede\">Agents can now extend a real Vite React project.</p></section></main>;\n}\n");
  writeFileIfMissing(resolve(repoDir, "src/styles.css"), baseCss("React"));
  writeFileIfMissing(resolve(repoDir, "README.md"), scaffoldReadme("Vite React", input.mission, ["npm install", "npm run dev", "npm run build"]));
  return { type: "react-vite", label: "Vite React App", files, commands: ["npm install", "npm run dev", "npm run build"] };
}

function scaffoldExpressApi(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const name = safeName(input.missionId);
  const files = ["package.json", "tsconfig.json", "src/index.ts", "README.md"];
  writeFileIfMissing(resolve(repoDir, "package.json"), JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { dev: "tsx src/index.ts", build: "tsc", start: "node dist/index.js" },
    dependencies: { "express": "^4.21.2", "cors": "^2.8.5", "tsx": "^4.19.2", "typescript": "^5.7.2", "@types/express": "^5.0.0", "@types/cors": "^2.8.17", "@types/node": "^22.10.2" }
  }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, esModuleInterop: true, outDir: "dist", skipLibCheck: true }, include: ["src"] }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "src/index.ts"), "import express from 'express';\nimport cors from 'cors';\n\nconst app = express();\nconst port = Number(process.env.PORT ?? 3000);\n\napp.use(cors());\napp.use(express.json());\n\napp.get('/health', (_request, response) => response.json({ status: 'ok', service: 'orvix-generated-api' }));\n\napp.listen(port, () => console.log(`API listening on ${port}`));\n");
  writeFileIfMissing(resolve(repoDir, "README.md"), scaffoldReadme("Express API", input.mission, ["npm install", "npm run dev", "npm run build"]));
  return { type: "express-api", label: "Express API", files, commands: ["npm install", "npm run dev", "npm run build"] };
}

function scaffoldNodeCli(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const base = scaffoldExpressApi(repoDir, input);
  writeFileIfMissing(resolve(repoDir, "src/index.ts"), "#!/usr/bin/env node\n\nconsole.log('Orvix generated CLI scaffold');\n");
  return { ...base, type: "node-cli", label: "Node TypeScript CLI" };
}

function scaffoldPython(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const files = ["pyproject.toml", "src/main.py", "README.md"];
  writeFileIfMissing(resolve(repoDir, "pyproject.toml"), "[project]\nname = \"orvix-generated-python\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\n\n[tool.pytest.ini_options]\npythonpath = [\"src\"]\n");
  writeFileIfMissing(resolve(repoDir, "src/main.py"), "def main() -> None:\n    print('Orvix generated Python scaffold')\n\n\nif __name__ == '__main__':\n    main()\n");
  writeFileIfMissing(resolve(repoDir, "README.md"), scaffoldReadme("Python", input.mission, ["python src/main.py"]));
  return { type: "python", label: "Python Project", files, commands: ["python src/main.py"] };
}

function scaffoldGeneric(repoDir: string, input: { missionId: string; mission: string }): ProjectScaffold {
  const files = ["package.json", "README.md"];
  writeFileIfMissing(resolve(repoDir, "package.json"), JSON.stringify({
    name: safeName(input.missionId),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { test: "echo \"No tests generated yet\"" }
  }, null, 2) + "\n");
  writeFileIfMissing(resolve(repoDir, "README.md"), scaffoldReadme("Generic", input.mission, ["npm test"]));
  return { type: "generic", label: "Generic Project", files, commands: ["npm test"] };
}

function scaffoldReadme(label: string, mission: string, commands: string[]) {
  return [
    `# Orvix Generated ${label} Scaffold`,
    "",
    "## Mission",
    "",
    mission,
    "",
    "## Commands",
    "",
    ...commands.map((command) => `- \`${command}\``),
    ""
  ].join("\n");
}

function missionAwareProductCss() {
  return [
    ":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #14110d; color: #f5efe4; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; background: #14110d; }",
    "a { color: inherit; text-decoration: none; }",
    ".product-shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; background: linear-gradient(135deg, #17130f 0%, #20170e 54%, #11100e 100%); }",
    ".sidebar { border-right: 1px solid rgba(245,239,228,.12); padding: 28px 22px; background: rgba(255,255,255,.035); }",
    ".sidebar strong { display: block; margin-bottom: 28px; color: #f7c873; font-size: 1.05rem; }",
    ".sidebar nav { display: grid; gap: 8px; }",
    ".sidebar a { border-radius: 8px; padding: 10px 12px; color: #d8cbbb; }",
    ".sidebar a:hover { background: rgba(247,200,115,.12); color: #fff8eb; }",
    ".workspace, .route-shell { width: min(1180px, 100%); padding: 56px; }",
    ".eyebrow { margin: 0 0 12px; color: #f7c873; text-transform: uppercase; letter-spacing: .08em; font-size: .78rem; font-weight: 700; }",
    "h1 { margin: 0; font-size: clamp(2.2rem, 6vw, 4.8rem); line-height: 1; letter-spacing: 0; }",
    ".lede { color: #d8cbbb; font-size: clamp(1rem, 2vw, 1.25rem); max-width: 760px; line-height: 1.6; }",
    ".metric-grid, .module-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-top: 28px; }",
    "article { border: 1px solid rgba(245,239,228,.12); border-radius: 8px; padding: 18px; background: rgba(255,255,255,.055); box-shadow: 0 20px 60px rgba(0,0,0,.16); }",
    "article span { display: block; color: #f7c873; font-size: .82rem; font-weight: 700; }",
    "article strong { display: block; margin-top: 10px; font-size: 2rem; }",
    "article small, article p { color: #c7b8a4; line-height: 1.5; }",
    ".auth-screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, rgba(247,200,115,.16), transparent 34rem), #14110d; }",
    ".auth-panel { width: min(420px, 100%); border: 1px solid rgba(245,239,228,.14); border-radius: 8px; padding: 28px; background: rgba(255,255,255,.055); }",
    "label { display: grid; gap: 6px; margin-top: 14px; color: #d8cbbb; }",
    "input { width: 100%; border: 1px solid rgba(245,239,228,.18); border-radius: 6px; padding: 11px 12px; background: #211a13; color: #f5efe4; }",
    "button { width: 100%; margin-top: 18px; border: 0; border-radius: 6px; padding: 12px; background: #f7c873; color: #17130f; font-weight: 800; }",
    "@media (max-width: 760px) { .product-shell { grid-template-columns: 1fr; } .sidebar { border-right: 0; border-bottom: 1px solid rgba(245,239,228,.12); } .workspace, .route-shell { padding: 28px; } }",
    ""
  ].join("\n");
}

function baseCss(label: string) {
  return [
    ":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #11100e; color: #f2ede4; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(214, 156, 69, 0.18), transparent 32rem), #11100e; }",
    ".shell { min-height: 100vh; display: grid; place-items: center; padding: 48px 20px; }",
    ".hero { width: min(920px, 100%); }",
    ".eyebrow { color: #d69c45; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.78rem; font-weight: 700; }",
    "h1 { margin: 0; font-size: clamp(2.5rem, 8vw, 5.8rem); line-height: 0.96; letter-spacing: 0; }",
    ".lede { color: #cfc6b8; font-size: clamp(1.05rem, 2vw, 1.35rem); max-width: 680px; line-height: 1.6; }",
    ".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-top: 28px; }",
    ".tile { border: 1px solid rgba(242, 237, 228, 0.16); border-radius: 8px; padding: 16px; background: rgba(255, 255, 255, 0.04); }",
    `body::after { content: '${label} scaffold'; position: fixed; right: 18px; bottom: 14px; color: rgba(242, 237, 228, 0.32); font-size: 12px; }`,
    ""
  ].join("\n");
}

function resolveWorkspacePath(workspace: Workspace, path: string) {
  if (path.includes("\0")) {
    throw new Error("Path contains invalid null byte");
  }

  const absolutePath = resolve(workspace.repoDir, path);
  const relativePath = relative(workspace.repoDir, absolutePath);
  if (relativePath.startsWith("..") || relativePath === ".." || absolutePath === workspace.repoDir + sep) {
    throw new Error("Path escapes mission workspace");
  }

  return absolutePath;
}

function walkFiles(root: string, current: string, depth: number): WorkspaceFile[] {
  const entries = readdirSync(current, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));

  const files: WorkspaceFile[] = [];
  for (const entry of entries) {
    const absolutePath = resolve(current, entry.name);
    const stats = statSync(absolutePath);
    files.push({
      path: toWorkspaceRelative(root, absolutePath),
      type: entry.isDirectory() ? "directory" : "file",
      size: stats.size
    });

    if (entry.isDirectory() && depth > 0) {
      files.push(...walkFiles(root, absolutePath, depth - 1));
    }
  }

  return files.slice(0, 200);
}

function toWorkspaceRelative(root: string, absolutePath: string) {
  return relative(root, absolutePath) || ".";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown workspace tool error";
}

function runGit(workspace: Workspace, args: string[]) {
  return execFileSync("git", args, {
    cwd: workspace.repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function mainWorkspaceFor(workspace: Workspace): Workspace {
  const repoDir = workspace.mainRepoDir ?? workspace.repoDir;
  return {
    ...workspace,
    repoDir,
    docsDir: resolve(repoDir, "docs")
  };
}

function currentBranch(workspace: Workspace) {
  return runGit(workspace, ["branch", "--show-current"]).trim() || "HEAD";
}

function currentCommit(workspace: Workspace) {
  return runGit(workspace, ["rev-parse", "--short", "HEAD"]).trim();
}

function validateBranchName(branch: string) {
  const candidate = branch
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 80);

  if (!candidate || candidate.length > 80) {
    throw new Error("Invalid branch name");
  }

  if (!/^[a-zA-Z0-9._/-]+$/.test(candidate)) {
    throw new Error("Branch name contains unsupported characters");
  }

  if (
    candidate.startsWith("-") ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("..") ||
    candidate.includes("//") ||
    candidate.includes("@{") ||
    candidate.endsWith(".lock")
  ) {
    throw new Error("Branch name is not allowed");
  }

  return candidate;
}
