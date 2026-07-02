import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function loadEnv(path = ".env") {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function extractMessage(payload) {
  return payload?.choices?.[0]?.message ?? {};
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace < firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

loadEnv();

const apiKey = process.env.DASHSCOPE_API_KEY;
const baseUrl = process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const model = process.env.QWEN_MODEL ?? "qwen-plus";
const outputPath = process.argv[2] ?? ".orvix/analysis/qwen-standalone-small-build-response.json";

if (!apiKey) {
  throw new Error("DASHSCOPE_API_KEY is missing. Add it to .env or export it before running this script.");
}

const requestBody = {
  model,
  temperature: 0.2,
  messages: [
    {
      role: "system",
      content: [
        "You are a senior software engineer responding to a normal direct coding request.",
        "Return a complete, useful answer.",
        "Include an explicit concise planning_trace field, but do not include hidden chain-of-thought.",
        "Return valid JSON only."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        request: "Build a tiny TypeScript in-memory bookmark manager API using Express. Include routes to create, list, search, and delete bookmarks. Keep it small but production-minded.",
        expectedOutput: {
          planning_trace: ["short visible planning bullets"],
          files: [
            {
              path: "package.json",
              content: "full file content"
            },
            {
              path: "src/index.ts",
              content: "full file content"
            }
          ],
          run_commands: ["commands to install/build/run"],
          notes: ["important tradeoffs or assumptions"]
        }
      })
    }
  ]
};

const startedAt = new Date().toISOString();
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(requestBody)
});

const rawText = await response.text();
let payload;
try {
  payload = JSON.parse(rawText);
} catch {
  payload = { rawText };
}

const message = extractMessage(payload);
const content = typeof message.content === "string" ? message.content : "";
const parsedContent = safeJsonParse(content);

const output = {
  capturedAt: new Date().toISOString(),
  startedAt,
  endpoint: `${baseUrl}/chat/completions`,
  model,
  status: response.status,
  ok: response.ok,
  request: {
    ...requestBody,
    messages: requestBody.messages
  },
  response: payload,
  extracted: {
    message,
    content,
    parsedContent,
    hasReasoningContent: typeof message.reasoning_content === "string",
    reasoningContent: typeof message.reasoning_content === "string" ? message.reasoning_content : null,
    usage: payload?.usage ?? null
  }
};

const absoluteOutputPath = resolve(outputPath);
mkdirSync(dirname(absoluteOutputPath), { recursive: true });
writeFileSync(absoluteOutputPath, JSON.stringify(output, null, 2), "utf8");

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  model,
  outputPath,
  contentChars: content.length,
  parsed: Boolean(parsedContent),
  hasReasoningContent: output.extracted.hasReasoningContent,
  usage: payload?.usage ?? null
}, null, 2));
