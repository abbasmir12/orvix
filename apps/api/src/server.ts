import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createQwenConfig, isQwenConfigured } from "@orvix/qwen";
import type {
  OrvixBookEntryType,
  OrvixBookPriority,
  OrvixBookScope,
  OrvixBookVisibility
} from "@orvix/core";
import { getGitStatus, listWorkspaceFiles } from "@orvix/workspace";
import { appendEvent, metricsSummary, port, runs, runSummary, writeSse, type MissionMode } from "./run.js";
import { agentName, getBookContext, postBookEntry } from "./book.js";
import { createRun } from "./planning.js";
import { executeAgentTask, executeGitTool, executeNextAgentTask } from "./agentRuntime.js";
import { reviewNextPullRequest, reviewPullRequest } from "./review.js";
import { runAutopilot, runSchedulerTurn } from "./scheduler.js";
import { listRunsOnDisk, resumeRun } from "./resume.js";

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(body, null, 2));
}

export function notFound(response: ServerResponse) {
  sendJson(response, 404, { error: "not_found" });
}

function planningInProgress(response: ServerResponse, run: { id: string; planningStages: unknown[] }) {
  sendJson(response, 409, {
    error: "planning_in_progress",
    message: "The mission workspace is not ready yet; planning is still running.",
    missionId: run.id,
    planningStages: run.planningStages
  });
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

export const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const qwenConfig = createQwenConfig();
      sendJson(response, 200, {
        service: "orvix-api",
        status: "ok",
        provider: "Alibaba Cloud ready",
        runtime: "Node.js",
        qwen: isQwenConfigured(qwenConfig) ? "configured" : "missing_api_key",
        qwenBaseUrl: qwenConfig.baseUrl,
        qwenModel: qwenConfig.model
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/missions") {
      const body = await readJson<{ mission?: string; mode?: MissionMode }>(request);
      if (!body.mission?.trim()) {
        sendJson(response, 400, { error: "mission_required" });
        return;
      }

      const mode: MissionMode = body.mode === "qwen" || body.mode === "solo" ? body.mode : "mock";
      const run = createRun(body.mission.trim(), mode);
      sendJson(response, 201, {
        missionId: run.id,
        eventsUrl: `/missions/${run.id}/events`,
        stateUrl: `/missions/${run.id}`,
        summary: runSummary(run)
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/missions/disk") {
      sendJson(response, 200, { runs: listRunsOnDisk() });
      return;
    }

    const resumeMatch = url.pathname.match(/^\/missions\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      const result = resumeRun(resumeMatch[1]);
      if (!result.ok) {
        sendJson(response, 404, { error: result.error });
        return;
      }
      sendJson(response, 200, {
        missionId: result.run.id,
        resumed: result.resumed,
        eventsUrl: `/missions/${result.run.id}/events`,
        stateUrl: `/missions/${result.run.id}`,
        summary: runSummary(result.run)
      });
      return;
    }

    const missionMatch = url.pathname.match(/^\/missions\/([^/]+)$/);
    if (request.method === "GET" && missionMatch) {
      const run = runs.get(missionMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        summary: runSummary(run),
        state: run.state,
        planningStages: run.planningStages,
        reasoningArtifacts: run.reasoningArtifacts,
        artifactsDir: run.store.artifactsDir,
        workspace: run.workspace ?? null
      });
      return;
    }

    const metricsMatch = url.pathname.match(/^\/missions\/([^/]+)\/metrics$/);
    if (request.method === "GET" && metricsMatch) {
      const run = runs.get(metricsMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, metricsSummary(run));
      return;
    }

    const workspaceMatch = url.pathname.match(/^\/missions\/([^/]+)\/workspace$/);
    if (request.method === "GET" && workspaceMatch) {
      const run = runs.get(workspaceMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        workspace: run.workspace,
        files: listWorkspaceFiles(run.workspace),
        git: getGitStatus(run.workspace)
      });
      return;
    }

    const bookMatch = url.pathname.match(/^\/missions\/([^/]+)\/book$/);
    if (request.method === "GET" && bookMatch) {
      const run = runs.get(bookMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const agentId = url.searchParams.get("agentId");
      const taskId = url.searchParams.get("taskId") ?? undefined;
      sendJson(response, 200, {
        missionId: run.id,
        book: agentId ? getBookContext(run, agentId, taskId) : {
          entries: run.state.bookEntries,
          signals: run.state.agentSignals,
          ownershipIndex: run.state.ownershipIndex
        }
      });
      return;
    }

    if (request.method === "POST" && bookMatch) {
      const run = runs.get(bookMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      const body = await readJson<{
        type?: OrvixBookEntryType;
        fromAgentId?: string;
        message?: string;
        toAgentIds?: string[];
        scope?: OrvixBookScope;
        visibility?: OrvixBookVisibility;
        taskId?: string;
        prId?: number;
        replyTo?: string;
        topics?: string[];
        priority?: OrvixBookPriority;
      }>(request);
      if (!body.message?.trim()) {
        sendJson(response, 400, { error: "message_required" });
        return;
      }

      const entry = postBookEntry(run, {
        type: body.type ?? "note",
        fromAgentId: body.fromAgentId ?? "mastermind-agent",
        message: body.message.trim(),
        toAgentIds: body.toAgentIds,
        scope: body.scope,
        visibility: body.visibility,
        taskId: body.taskId,
        prId: body.prId,
        replyTo: body.replyTo,
        topics: body.topics,
        priority: body.priority
      });
      appendEvent(run, `${agentName(run, entry.fromAgentId)} posted ${entry.type} to Orvix Book`, "info");
      sendJson(response, 201, { entry });
      return;
    }

    const signalsMatch = url.pathname.match(/^\/missions\/([^/]+)\/agents\/([^/]+)\/signals$/);
    if (request.method === "GET" && signalsMatch) {
      const run = runs.get(signalsMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        agentId: signalsMatch[2],
        signals: run.state.agentSignals.filter((signal) => signal.toAgentId === signalsMatch[2])
      });
      return;
    }

    const gitToolMatch = url.pathname.match(/^\/missions\/([^/]+)\/workspace\/git$/);
    if (request.method === "POST" && gitToolMatch) {
      const run = runs.get(gitToolMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const body = await readJson<{
        tool?: "git_status" | "create_branch" | "checkout_branch" | "commit_changes" | "get_diff" | "merge_branch";
        branch?: string;
        message?: string;
        baseBranch?: string;
        targetBranch?: string;
      }>(request);

      const result = executeGitTool(run, body);
      if (result.ok) {
        appendEvent(run, `Workspace Git tool ${result.tool} completed on ${result.branch}`, "success");
      } else {
        appendEvent(run, `Workspace Git tool ${result.tool} failed: ${result.error}`, "warning");
      }

      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const agentExecuteMatch = url.pathname.match(/^\/missions\/([^/]+)\/agents\/([^/]+)\/execute$/);
    if (request.method === "POST" && agentExecuteMatch) {
      const run = runs.get(agentExecuteMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const result = await executeAgentTask(run, agentExecuteMatch[2]);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const executeNextMatch = url.pathname.match(/^\/missions\/([^/]+)\/execute-next$/);
    if (request.method === "POST" && executeNextMatch) {
      const run = runs.get(executeNextMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const result = await executeNextAgentTask(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const reviewNextMatch = url.pathname.match(/^\/missions\/([^/]+)\/review-next$/);
    if (request.method === "POST" && reviewNextMatch) {
      const run = runs.get(reviewNextMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const result = await reviewNextPullRequest(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const prReviewMatch = url.pathname.match(/^\/missions\/([^/]+)\/prs\/(\d+)\/review$/);
    if (request.method === "POST" && prReviewMatch) {
      const run = runs.get(prReviewMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const result = await reviewPullRequest(run, Number(prReviewMatch[2]));
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const schedulerTickMatch = url.pathname.match(/^\/missions\/([^/]+)\/scheduler\/tick$/);
    if (request.method === "POST" && schedulerTickMatch) {
      const run = runs.get(schedulerTickMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const result = await runSchedulerTurn(run);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const autopilotMatch = url.pathname.match(/^\/missions\/([^/]+)\/autopilot$/);
    if (request.method === "POST" && autopilotMatch) {
      const run = runs.get(autopilotMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      if (!run.workspace) {
        planningInProgress(response, run);
        return;
      }

      const body = await readJson<{ cycles?: number }>(request);
      const result = await runAutopilot(run, Math.min(Math.max(body.cycles ?? 300, 1), 300));
      sendJson(response, 200, result);
      return;
    }

    const reasoningMatch = url.pathname.match(/^\/missions\/([^/]+)\/reasoning$/);
    if (request.method === "GET" && reasoningMatch) {
      const run = runs.get(reasoningMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      sendJson(response, 200, {
        missionId: run.id,
        mode: run.mode,
        runDir: run.store.runDir,
        artifactsDir: run.store.artifactsDir,
        artifacts: run.reasoningArtifacts
      });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/missions\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const run = runs.get(eventsMatch[1]);
      if (!run) {
        notFound(response);
        return;
      }

      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream"
      });

      run.subscribers.add(response);
      writeSse(response, "state", run.state);
      writeSse(response, "planning_snapshot", run.planningStages);

      request.on("close", () => {
        run.subscribers.delete(response);
      });
      return;
    }

    notFound(response);
  } catch (error) {
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(port, () => {
  console.log(`orvix-api listening on http://localhost:${port}`);
});

