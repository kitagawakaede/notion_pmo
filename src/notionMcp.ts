import type { AppConfig } from "./config";
import { openAiJsonSchema, sprintTasksJsonSchema } from "./schema";

type ResponseContentPart = { type?: string; text?: string; json?: unknown };
type ResponseOutputItem = {
  type?: string; // e.g. "message"
  role?: string; // e.g. "assistant"
  content?: ResponseContentPart[];
};
interface OpenAIResponse {
  output?: ResponseOutputItem[];
  output_text?: string;
}

const SYSTEM_PROMPT = `
You are a retrieval agent that reads a Notion Sprint DB via the Notion MCP hosted server.
Only use the allowed MCP tools: search, fetch. Do not perform any updates or writes.
If sprintDbUrl is provided, use it directly; otherwise search by sprintDbName once, then fetch that DB.
Never access databases outside the provided allowedDbUrls list; if a DB is not allowed, return an error message in JSON.
Return exactly one sprint record that matches the active/current sprint.
Selection rules (in order): Status == "Active" (or similar), otherwise date range containing today, otherwise most recently updated.
Extract the requested properties; if a property is missing, return a sensible fallback such as null.
Output must strictly follow the provided JSON schema. Do not add extra fields.
Minimize tool calls and stay within rate limits.`;

const TASKS_SYSTEM_PROMPT = `
You are a retrieval agent that reads Notion databases via the Notion MCP hosted server.
Only use the allowed MCP tools: search, fetch. Do not perform any updates or writes.
If sprintDbUrl/taskDbUrl is provided, use it directly; otherwise search by the provided DB name, then fetch that DB.
Never access databases outside the provided allowedDbUrls list; if a DB is not allowed, return an error message in JSON.
Determine the current sprint by reading the sprint DB and matching today's date to the sprint period property.
Then read the task DB and list tasks that belong to the current sprint.
Exclude tasks whose status indicates completion ("完了", "Done", "Closed", etc.).
Extract the requested properties; if a property is missing, return a sensible fallback such as null.
Output must strictly follow the provided JSON schema. Do not add extra fields.
Minimize tool calls and stay within rate limits.`;

function normalizeTextFormat(schemaLike: any) {
  const js = schemaLike?.json_schema ?? schemaLike;
  const name = js?.name ?? "sprint_summary";
  const schema = js?.schema ?? js;
  const strict = js?.strict ?? true;
  const description = js?.description;

  const format: Record<string, unknown> = {
    type: "json_schema",
    name,
    strict,
    schema
  };
  if (typeof description === "string" && description.length > 0) {
    format.description = description;
  }
  return format;
}

function applyMcpAuth(toolDef: Record<string, unknown>, config: AppConfig) {
  const raw =
    (config as any).mcpAuthorization ??
    (config as any).mcpHeaders ??
    (config as any).mcpAccessToken ??
    (config as any).mcpAuthToken ??
    config.mcpAuthToken ??
    config.notionToken;

  if (!raw) return;

  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return;
    // Always send via Authorization header; add Bearer prefix if missing.
    toolDef.headers = {
      Authorization: /^Bearer\s+/i.test(s) ? s : `Bearer ${s}`
    };
    return;
  }

  if (typeof raw === "object" && raw !== null) {
    const headersObj = (raw as any).headers ?? raw;
    toolDef.headers = normalizeHeaders(headersObj);
    return;
  }

  throw new Error(
    "MCP auth must be either a string token (authorization) or a headers object (headers)."
  );
}

function normalizeHeaders(obj: unknown): Record<string, string> {
  if (!obj || typeof obj !== "object") {
    throw new Error("mcp headers must be an object");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`MCP header '${k}' must be a string, got ${typeof v}`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Free-form query that returns raw LLM text (no JSON schema enforcement).
 */
export async function fetchFreeText(
  config: AppConfig,
  prompt: string,
  now: Date
): Promise<string> {
  const toolDef: Record<string, unknown> = {
    type: "mcp",
    server_url: config.mcpServerUrl,
    server_label: "notion",
    require_approval: "never",
    allowed_tools: config.allowedTools
  };
  applyMcpAuth(toolDef, config);

  const system = [
    "You are an information retriever using Notion MCP tools (search, fetch).",
    "Never use write/update tools.",
    `Allowed DB URLs (whitelist): ${
      config.allowedDbUrls.length > 0
        ? config.allowedDbUrls.join(", ")
        : "none"
    }. If none, respond with an error message; do NOT ask the user to provide a URL.`,
    config.allowedDbUrls.length > 0
      ? `If the user does not specify a DB, default to the first allowed DB: ${config.allowedDbUrls[0]}. Do NOT ask follow-up questions.`
      : "There are no allowed DBs; return an error message.",
    config.allowAllProperties
      ? "You may return all properties from allowed DBs."
      : "Restrict properties to notifyProperties if provided.",
    "Return a concise textual answer. Do not ask clarifying questions."
  ].join("\n");

  const userContent = {
    prompt,
    allowedDbUrls: config.allowedDbUrls,
    allowAllProperties: config.allowAllProperties,
    notifyProperties: config.notifyProperties,
    today: now.toISOString().slice(0, 10)
  };

  const body = {
    model: config.openaiModel,
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Use Notion MCP to answer:\n${prompt}\nContext: ${JSON.stringify(
          userContent
        )}`
      }
    ],
    tools: [toolDef],
    temperature: 0.1,
    max_output_tokens: 800
  };

  const res = await callOpenAi(config, body);
  const parsed = (await res.json()) as OpenAIResponse;
  return extractTextLoose(parsed);
}

export async function fetchSprintSummary(
  config: AppConfig,
  now: Date
): Promise<unknown> {
  const toolDef: Record<string, unknown> = {
    type: "mcp",
    server_url: config.mcpServerUrl,
    server_label: "notion",
    require_approval: "never",
    allowed_tools: config.allowedTools
  };

  // If Notion MCP requires auth, apply it (authorization string or headers object).
  applyMcpAuth(toolDef, config);

  const userContent = {
    sprintDbUrl: config.sprintDbUrl,
    sprintDbName: config.sprintDbName,
    allowedDbUrls: config.allowedDbUrls,
    allowAllProperties: config.allowAllProperties,
    notifyProperties: config.notifyProperties,
    today: now.toISOString().slice(0, 10)
  };

  const body = {
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\nAllowed tools: ${config.allowedTools.join(
          ", "
        )}.\nAllowed DB URLs (whitelist): ${
          config.allowedDbUrls.length > 0
            ? config.allowedDbUrls.join(", ")
            : "none"
        }.\nIf allowAllProperties is true, return all properties; otherwise, restrict to notifyProperties.`
      },
      {
        role: "user",
        content: `Fetch the current sprint from Notion and return only the requested properties. Input: ${JSON.stringify(
          userContent
        )}`
      }
    ],
    tools: [toolDef],
    // Structured outputs: text.format requires name + schema
    text: {
      format: normalizeTextFormat(openAiJsonSchema)
    },
    temperature: 0.1,
    max_output_tokens: 800
  };

  const res = await callOpenAi(config, body);
  const parsed = (await res.json()) as OpenAIResponse;

  try {
    const text = extractJsonText(parsed);
    return JSON.parse(text);
  } catch (err) {
    console.error("LLM raw response (for debugging)", parsed);
    throw new Error(`Failed to parse LLM JSON: ${(err as Error).message}`);
  }
}

export async function fetchSprintTasks(
  config: AppConfig,
  now: Date
): Promise<unknown> {
  const toolDef: Record<string, unknown> = {
    type: "mcp",
    server_url: config.mcpServerUrl,
    server_label: "notion",
    require_approval: "never",
    allowed_tools: config.allowedTools
  };

  applyMcpAuth(toolDef, config);

  const userContent = {
    sprintDbUrl: config.sprintDbUrl,
    sprintDbName: config.sprintDbName,
    taskDbUrl: config.taskDbUrl,
    taskDbName: config.taskDbName,
    allowedDbUrls: config.allowedDbUrls,
    allowAllProperties: config.allowAllProperties,
    notifyProperties: config.notifyProperties,
    today: now.toISOString().slice(0, 10)
  };

  const body = {
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: `${TASKS_SYSTEM_PROMPT}\nAllowed tools: ${config.allowedTools.join(
          ", "
        )}.\nAllowed DB URLs (whitelist): ${
          config.allowedDbUrls.length > 0
            ? config.allowedDbUrls.join(", ")
            : "none"
        }.\nIf allowAllProperties is true, return all properties; otherwise, restrict to notifyProperties.`
      },
      {
        role: "user",
        content: `Find the current sprint and list tasks grouped by assignee for that sprint.
Use the task properties: 名前, 担当者, ステータス, 優先度, SP, 期限.
Output each task as { name, status, priority, sp, due }.
Include each task id as { id } for change tracking.
From the sprint DB, also return sprint_metrics using properties: 計画SP, 進捗SP, 必要SP/日 (fallbacks allowed).
Input: ${JSON.stringify(
          userContent
        )}`
      }
    ],
    tools: [toolDef],
    text: {
      format: normalizeTextFormat(sprintTasksJsonSchema)
    },
    temperature: 0.1,
    max_output_tokens: 1200
  };

  const res = await callOpenAi(config, body);
  const parsed = (await res.json()) as OpenAIResponse;

  try {
    const text = extractJsonText(parsed);
    return JSON.parse(text);
  } catch (err) {
    console.error("LLM raw response (for debugging)", parsed);
    throw new Error(`Failed to parse LLM JSON: ${(err as Error).message}`);
  }
}

async function callOpenAi(
  config: AppConfig,
  body: Record<string, unknown>
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };

  let attempt = 0;
  let waitMs = 500;

  while (true) {
    attempt += 1;
    const res = await fetch("https://api.openai.com/v1/responses", init);
    if (res.ok) return res;
    if (attempt >= config.maxRetries) {
      const detail = await res.text();
      throw new Error(
        `OpenAI failed after ${attempt} attempts: ${res.status} ${detail}`
      );
    }
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs *= 2;
  }
}

function extractJsonText(payload: OpenAIResponse): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const outputs = payload.output;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("LLM response did not contain output items");
  }

  const chunks: string[] = [];

  for (const item of outputs) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text);
      } else if (part?.json != null) {
        chunks.push(JSON.stringify(part.json));
      }
    }
  }

  const text = chunks.join("").trim();
  if (text) return text;

  throw new Error(
    "LLM response text is empty; no textual content returned from outputs"
  );
}

function extractTextLoose(payload: OpenAIResponse): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const outputs = payload.output;
  if (Array.isArray(outputs)) {
    const chunks: string[] = [];
    for (const item of outputs) {
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part?.text === "string" && part.text.trim()) {
          chunks.push(part.text);
        } else if (part?.json != null) {
          chunks.push(JSON.stringify(part.json));
        }
      }
    }
    const text = chunks.join("").trim();
    if (text) return text;
  }
  throw new Error(
    "LLM response text is empty; no textual content returned from outputs"
  );
}
