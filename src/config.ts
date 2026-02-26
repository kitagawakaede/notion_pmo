export interface Bindings {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  NOTION_OAUTH_ACCESS_TOKEN?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_DATE_PROPERTY?: string;
  ALLOWED_DB_URLS?: string;
  ALLOW_ALL_PROPERTIES?: string;
  SPRINT_DB_URL?: string;
  SPRINT_DB_NAME?: string;
  TASK_DB_URL?: string;
  TASK_DB_NAME?: string;
  TASK_SPRINT_RELATION_PROPERTY?: string;
  MCP_SERVER_URL?: string;
  MCP_AUTH_TOKEN?: string;
  NOTIFY_PROPERTIES?: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_ERROR_WEBHOOK_URL?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_PMO_CHANNEL_ID?: string;
  SLACK_PM_USER_ID?: string;
  MEMBER_DB_URL?: string;
  MEMBER_SLACK_MAP?: string;
  MEMBER_WHITELIST?: string;
  GITHUB_TOKEN?: string;
  GOOGLE_SHEETS_ID?: string;
  GOOGLE_SHEETS_API_KEY?: string;
  GOOGLE_SHEETS_RANGE?: string;
  REFERENCE_DB_URL?: string;
  DRY_RUN?: string;
  REQUIRE_APPROVAL?: string;
  NOTIFY_CACHE: KVNamespace;
}

export interface AppConfig {
  openaiApiKey: string;
  openaiModel: string;
  notionToken: string;
  notionDatabaseId?: string;
  notionDateProperty: string;
  allowedDbUrls: string[];
  allowAllProperties: boolean;
  sprintDbUrl?: string;
  sprintDbName?: string;
  sprintDbId?: string;
  taskDbUrl?: string;
  taskDbName?: string;
  taskDbId?: string;
  taskSprintRelationProperty: string;
  notifyProperties: string[];
  slackWebhookUrl?: string;
  slackErrorWebhookUrl?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackPmoChannelId?: string;
  slackPmUserId?: string;
  memberDbId?: string;
  memberSlackMap: Record<string, string>;
  memberWhitelist: string[];
  googleSheetsId?: string;
  googleSheetsApiKey?: string;
  googleSheetsRange?: string;
  referenceDbId?: string;
  dryRun: boolean;
  requireApproval: "never" | "always";
  mcpServerUrl: string;
  mcpAuthToken?: string;
  allowedTools: string[];
  maxRetries: number;
  dedupeTtlSeconds: number;
}

const DEFAULT_PROPERTIES = ["確定 見積SP", "確定 実績SP", "確定 想定"];

const parseBool = (value?: string | null): boolean => {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const parseList = (value?: string, fallback: string[] = DEFAULT_PROPERTIES): string[] => {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v));
      }
    } catch {
      // fall through to CSV parsing
    }
  }
  return trimmed
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
};

export const extractNotionIdFromUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    // Path may contain the 32-char ID (with or without hyphens)
    const match = u.pathname.match(/([0-9a-fA-F]{32})/);
    if (match?.[1]) return match[1].replace(/-/g, "");
  } catch {
    // not a URL; ignore
  }
  return undefined;
};

const parseMemberSlackMap = (value?: string): Record<string, string> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
  } catch { /* ignore */ }
  return {};
};

export function getConfig(env: Bindings): AppConfig {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  if (!env.NOTION_OAUTH_ACCESS_TOKEN)
    throw new Error("NOTION_OAUTH_ACCESS_TOKEN is required");
  if (!env.SPRINT_DB_URL && !env.SPRINT_DB_NAME)
    throw new Error("SPRINT_DB_URL or SPRINT_DB_NAME is required");
  if (!env.TASK_DB_URL && !env.TASK_DB_NAME)
    throw new Error("TASK_DB_URL or TASK_DB_NAME is required");

  const sprintDbId = extractNotionIdFromUrl(env.SPRINT_DB_URL);
  const taskDbId = extractNotionIdFromUrl(env.TASK_DB_URL);
  const memberDbId = extractNotionIdFromUrl(env.MEMBER_DB_URL);
  const referenceDbId = extractNotionIdFromUrl(env.REFERENCE_DB_URL);

  return {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || "gpt-4.1-mini",
    notionToken: env.NOTION_OAUTH_ACCESS_TOKEN,
    notionDatabaseId: env.NOTION_DATABASE_ID || taskDbId || sprintDbId,
    notionDateProperty: env.NOTION_DATE_PROPERTY || "期間",
    allowedDbUrls: parseList(env.ALLOWED_DB_URLS, []),
    allowAllProperties: parseBool(env.ALLOW_ALL_PROPERTIES),
    sprintDbUrl: env.SPRINT_DB_URL,
    sprintDbName: env.SPRINT_DB_NAME,
    sprintDbId,
    taskDbUrl: env.TASK_DB_URL,
    taskDbName: env.TASK_DB_NAME,
    taskDbId,
    taskSprintRelationProperty:
      env.TASK_SPRINT_RELATION_PROPERTY || "スプリント",
    notifyProperties: parseList(env.NOTIFY_PROPERTIES),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    slackErrorWebhookUrl: env.SLACK_ERROR_WEBHOOK_URL,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    slackPmoChannelId: env.SLACK_PMO_CHANNEL_ID,
    slackPmUserId: env.SLACK_PM_USER_ID,
    memberDbId,
    memberSlackMap: parseMemberSlackMap(env.MEMBER_SLACK_MAP),
    memberWhitelist: parseList(env.MEMBER_WHITELIST, []),
    googleSheetsId: env.GOOGLE_SHEETS_ID,
    googleSheetsApiKey: env.GOOGLE_SHEETS_API_KEY,
    googleSheetsRange: env.GOOGLE_SHEETS_RANGE,
    referenceDbId,
    dryRun: parseBool(env.DRY_RUN),
    requireApproval: env.REQUIRE_APPROVAL === "always" ? "always" : "never",
    mcpServerUrl: env.MCP_SERVER_URL || "https://mcp.notion.com/mcp",
    mcpAuthToken: env.MCP_AUTH_TOKEN,
    allowedTools: ["search", "fetch"],
    maxRetries: 3,
    dedupeTtlSeconds: 7 * 24 * 3600
  };
}
