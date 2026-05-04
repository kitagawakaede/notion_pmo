# Channel Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the bot to work in any Slack channel by collecting per-channel Notion configuration via an onboarding flow when the bot joins a channel.

**Architecture:** Per-channel config stored in KV (`channel-config:{channelId}`). When the bot joins a channel, it posts a greeting with a setup button. Clicking opens a Slack modal to collect Notion DB URLs. After validation, auto-matches channel members to Notion member names. A `resolveConfig()` function merges channel config over global env config.

**Tech Stack:** Cloudflare Workers, Slack Block Kit (modals), Notion API, KV storage

---

### Task 1: Channel Config KV CRUD (`src/channelConfig.ts`)

**Files:**
- Create: `src/channelConfig.ts`

**Step 1: Create the ChannelConfig interface and KV CRUD functions**

```typescript
// src/channelConfig.ts
import { extractNotionIdFromUrl, type AppConfig, type Bindings, getConfig } from "./config";

export interface ChannelConfig {
  taskDbUrl: string;
  sprintDbUrl: string;
  memberDbUrl: string;
  referenceDbUrl?: string;
  pmUserId: string;
  memberMap: Record<string, string>;  // Slack User ID -> Notion member name
  projectName?: string;
  googleSheetsId?: string;
  googleSheetsRange?: string;
  registeredAt: string;
  registeredBy: string;
}

const CHANNEL_CONFIG_KEY = (channelId: string) => `channel-config:${channelId}`;
const CHANNEL_LIST_KEY = "channel-config-list";

export async function getChannelConfig(
  kv: KVNamespace,
  channelId: string
): Promise<ChannelConfig | null> {
  const raw = await kv.get(CHANNEL_CONFIG_KEY(channelId));
  if (!raw) return null;
  return JSON.parse(raw) as ChannelConfig;
}

export async function saveChannelConfig(
  kv: KVNamespace,
  channelId: string,
  config: ChannelConfig
): Promise<void> {
  await kv.put(CHANNEL_CONFIG_KEY(channelId), JSON.stringify(config));
  // Update channel list
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  const list: string[] = listRaw ? JSON.parse(listRaw) : [];
  if (!list.includes(channelId)) {
    list.push(channelId);
    await kv.put(CHANNEL_LIST_KEY, JSON.stringify(list));
  }
}

export async function deleteChannelConfig(
  kv: KVNamespace,
  channelId: string
): Promise<void> {
  await kv.delete(CHANNEL_CONFIG_KEY(channelId));
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  if (listRaw) {
    const list: string[] = JSON.parse(listRaw);
    const filtered = list.filter((id) => id !== channelId);
    await kv.put(CHANNEL_LIST_KEY, JSON.stringify(filtered));
  }
}

export async function listAllChannelConfigs(
  kv: KVNamespace
): Promise<Array<{ channelId: string; config: ChannelConfig }>> {
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  if (!listRaw) return [];
  const list: string[] = JSON.parse(listRaw);
  const results: Array<{ channelId: string; config: ChannelConfig }> = [];
  for (const channelId of list) {
    const config = await getChannelConfig(kv, channelId);
    if (config) results.push({ channelId, config });
  }
  return results;
}

/** Invert memberMap: { SlackID: NotionName } -> { NotionName: SlackID } */
function invertMap(map: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    result[value] = key;
  }
  return result;
}

/**
 * Merge channel-specific config over global env config.
 * Returns base config if channel has no config registered.
 */
export async function resolveConfig(
  env: Bindings,
  channelId: string
): Promise<AppConfig> {
  const base = getConfig(env);
  const channelCfg = await getChannelConfig(env.NOTIFY_CACHE, channelId);
  if (!channelCfg) return base;

  return {
    ...base,
    taskDbId: extractNotionIdFromUrl(channelCfg.taskDbUrl) ?? base.taskDbId,
    taskDbUrl: channelCfg.taskDbUrl,
    sprintDbId: extractNotionIdFromUrl(channelCfg.sprintDbUrl) ?? base.sprintDbId,
    sprintDbUrl: channelCfg.sprintDbUrl,
    memberDbId: extractNotionIdFromUrl(channelCfg.memberDbUrl) ?? base.memberDbId,
    referenceDbId: channelCfg.referenceDbUrl
      ? extractNotionIdFromUrl(channelCfg.referenceDbUrl)
      : base.referenceDbId,
    slackPmUserId: channelCfg.pmUserId,
    memberSlackMap: invertMap(channelCfg.memberMap),
    googleSheetsId: channelCfg.googleSheetsId ?? base.googleSheetsId,
    googleSheetsRange: channelCfg.googleSheetsRange ?? base.googleSheetsRange,
  };
}
```

**Step 2: Commit**

```bash
git add src/channelConfig.ts
git commit -m "feat: add channelConfig KV CRUD and resolveConfig"
```

---

### Task 2: Slack API helpers (`src/slackBot.ts`)

**Files:**
- Modify: `src/slackBot.ts` (append new functions after existing exports)

**Step 1: Add `viewsOpen`, `conversationsMembers`, and `usersInfo` functions**

Append these after the existing `chatUpdate` function at line 178:

```typescript
export async function viewsOpen(
  token: string,
  triggerId: string,
  view: unknown
): Promise<void> {
  await slackApiCall(token, "views.open", {
    trigger_id: triggerId,
    view
  });
}

export async function conversationsMembers(
  token: string,
  channel: string
): Promise<string[]> {
  const data = (await slackApiCall(token, "conversations.members", {
    channel,
    limit: 200
  })) as { members?: string[] };
  return data.members ?? [];
}

export async function usersInfo(
  token: string,
  userId: string
): Promise<{ realName: string; displayName: string }> {
  const data = (await slackApiCall(token, "users.info", {
    user: userId
  })) as { user?: { real_name?: string; profile?: { display_name?: string } } };
  return {
    realName: data.user?.real_name ?? "",
    displayName: data.user?.profile?.display_name ?? ""
  };
}

export async function authTest(
  token: string
): Promise<{ userId: string; botId: string }> {
  const data = (await slackApiCall(token, "auth.test", {})) as {
    user_id?: string;
    bot_id?: string;
  };
  return {
    userId: data.user_id ?? "",
    botId: data.bot_id ?? ""
  };
}
```

**Step 2: Commit**

```bash
git add src/slackBot.ts
git commit -m "feat: add viewsOpen, conversationsMembers, usersInfo, authTest to slackBot"
```

---

### Task 3: Onboarding logic (`src/onboarding.ts`)

**Files:**
- Create: `src/onboarding.ts`

**Step 1: Create the onboarding module with greeting, modal builder, validation, and member matching**

```typescript
// src/onboarding.ts
import type { Bindings } from "./config";
import { getConfig, extractNotionIdFromUrl } from "./config";
import { chatPostMessage, viewsOpen, conversationsMembers, usersInfo, authTest } from "./slackBot";
import { getChannelConfig, saveChannelConfig, type ChannelConfig } from "./channelConfig";

const NOTION_VERSION = "2022-06-28";

// ── Greeting message when bot joins a channel ────────────────────────────

export async function handleBotJoinedChannel(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = event.channel as string;
  const user = event.user as string;

  // Check if this is the bot itself joining
  const auth = await authTest(config.slackBotToken);
  if (user !== auth.userId) return;

  // Check if already configured
  const existing = await getChannelConfig(env.NOTIFY_CACHE, channel);
  if (existing) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      "このチャンネルは設定済みです。変更する場合は `@bot 設定変更` とメンションしてください。"
    );
    return;
  }

  await chatPostMessage(
    config.slackBotToken,
    channel,
    "プロジェクト管理ボットです！このチャンネルで使うには初期設定が必要です。\n下のボタンから設定を始めてください。",
    [buildSetupButton()]
  );
}

// ── Setup button ─────────────────────────────────────────────────────────

function buildSetupButton(): unknown {
  return {
    type: "actions",
    block_id: "onboarding_setup",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "初期設定を始める", emoji: true },
        style: "primary",
        action_id: "onboarding_open_modal"
      }
    ]
  };
}

// ── Modal definition ─────────────────────────────────────────────────────

export function buildSetupModal(channelId: string, existingConfig?: ChannelConfig): unknown {
  return {
    type: "modal",
    callback_id: "onboarding_modal_submit",
    private_metadata: JSON.stringify({ channelId }),
    title: { type: "plain_text", text: "プロジェクト初期設定" },
    submit: { type: "plain_text", text: "設定する" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "task_db_url",
        label: { type: "plain_text", text: "タスクDB URL" },
        element: {
          type: "url_text_input",
          action_id: "task_db_url_input",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.taskDbUrl ? { initial_value: existingConfig.taskDbUrl } : {})
        }
      },
      {
        type: "input",
        block_id: "sprint_db_url",
        label: { type: "plain_text", text: "スプリントDB URL" },
        element: {
          type: "url_text_input",
          action_id: "sprint_db_url_input",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.sprintDbUrl ? { initial_value: existingConfig.sprintDbUrl } : {})
        }
      },
      {
        type: "input",
        block_id: "member_db_url",
        label: { type: "plain_text", text: "メンバーDB URL" },
        element: {
          type: "url_text_input",
          action_id: "member_db_url_input",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.memberDbUrl ? { initial_value: existingConfig.memberDbUrl } : {})
        }
      },
      {
        type: "input",
        block_id: "reference_db_url",
        optional: true,
        label: { type: "plain_text", text: "リファレンスDB URL（任意）" },
        element: {
          type: "url_text_input",
          action_id: "reference_db_url_input",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.referenceDbUrl ? { initial_value: existingConfig.referenceDbUrl } : {})
        }
      },
      {
        type: "input",
        block_id: "project_name",
        optional: true,
        label: { type: "plain_text", text: "プロジェクト略称（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "project_name_input",
          placeholder: { type: "plain_text", text: "例: ms, acme" },
          ...(existingConfig?.projectName ? { initial_value: existingConfig.projectName } : {})
        }
      },
      {
        type: "input",
        block_id: "google_sheets_id",
        optional: true,
        label: { type: "plain_text", text: "Google Sheets ID（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "google_sheets_id_input",
          placeholder: { type: "plain_text", text: "スプレッドシートのID" },
          ...(existingConfig?.googleSheetsId ? { initial_value: existingConfig.googleSheetsId } : {})
        }
      }
    ]
  };
}

// ── Open modal from button click ─────────────────────────────────────────

export async function openSetupModal(
  env: Bindings,
  triggerId: string,
  channelId: string
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const existingConfig = await getChannelConfig(env.NOTIFY_CACHE, channelId);
  const modal = buildSetupModal(channelId, existingConfig ?? undefined);
  await viewsOpen(config.slackBotToken, triggerId, modal);
}

// ── Validate Notion DB access ────────────────────────────────────────────

async function validateNotionDb(
  token: string,
  url: string,
  label: string
): Promise<{ ok: boolean; error?: string; dbId?: string }> {
  const dbId = extractNotionIdFromUrl(url);
  if (!dbId) {
    return { ok: false, error: `${label}: URLからNotion IDを取得できません` };
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION
      }
    });
    if (!res.ok) {
      return { ok: false, error: `${label}: DBにアクセスできません (${res.status})。Notion Integrationの共有を確認してください。` };
    }
    return { ok: true, dbId };
  } catch {
    return { ok: false, error: `${label}: DBへの接続に失敗しました` };
  }
}

// ── Fetch member names from Notion member DB ─────────────────────────────

async function fetchMemberNames(
  token: string,
  memberDbId: string
): Promise<string[]> {
  const res = await fetch(
    `https://api.notion.com/v1/databases/${memberDbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ page_size: 100 })
    }
  );
  if (!res.ok) return [];

  const data = (await res.json()) as { results?: unknown[] };
  const names: string[] = [];
  for (const page of data.results ?? []) {
    const props = ((page as Record<string, unknown>).properties ?? {}) as Record<string, unknown>;
    const titleProp = props["名前"] ?? props["Name"] ?? props["name"];
    if (!titleProp) continue;
    const items = ((titleProp as Record<string, unknown>).title ?? []) as Array<{ plain_text?: string }>;
    const name = items.map((t) => t.plain_text ?? "").join("").trim();
    if (name) names.push(name);
  }
  return names;
}

// ── Auto-match Slack members to Notion members ───────────────────────────

interface MatchResult {
  matched: Array<{ slackUserId: string; slackName: string; notionName: string }>;
  unmatched: Array<{ slackUserId: string; slackName: string }>;
  unmatchedNotion: string[];
}

export async function autoMatchMembers(
  token: string,
  channelId: string,
  notionMemberNames: string[],
  botUserId: string
): Promise<MatchResult> {
  const slackMembers = await conversationsMembers(token, channelId);
  const matched: MatchResult["matched"] = [];
  const unmatched: MatchResult["unmatched"] = [];
  const matchedNotionNames = new Set<string>();

  for (const slackUserId of slackMembers) {
    if (slackUserId === botUserId) continue;  // skip bot itself

    const info = await usersInfo(token, slackUserId);
    const slackName = info.displayName || info.realName;
    if (!slackName) {
      unmatched.push({ slackUserId, slackName: slackUserId });
      continue;
    }

    // Try partial match against Notion member names
    const match = notionMemberNames.find(
      (notionName) =>
        !matchedNotionNames.has(notionName) &&
        (notionName.includes(slackName) ||
         slackName.includes(notionName) ||
         notionName.toLowerCase().includes(slackName.toLowerCase()) ||
         slackName.toLowerCase().includes(notionName.toLowerCase()) ||
         // Also try matching against parts separated by / or space
         notionName.split(/[\s\/]+/).some((part) =>
           part.toLowerCase() === slackName.toLowerCase() ||
           slackName.toLowerCase().includes(part.toLowerCase())
         ))
    );

    if (match) {
      matched.push({ slackUserId, slackName, notionName: match });
      matchedNotionNames.add(match);
    } else {
      unmatched.push({ slackUserId, slackName });
    }
  }

  const unmatchedNotion = notionMemberNames.filter((n) => !matchedNotionNames.has(n));

  return { matched, unmatched, unmatchedNotion };
}

// ── Build match result message ───────────────────────────────────────────

export function buildMatchResultBlocks(
  result: MatchResult,
  channelId: string
): { text: string; blocks: unknown[] } {
  const lines: string[] = ["*メンバーマッチング結果:*\n"];

  for (const m of result.matched) {
    lines.push(`  <@${m.slackUserId}> (${m.slackName}) → ${m.notionName}`);
  }
  for (const u of result.unmatched) {
    lines.push(`  <@${u.slackUserId}> (${u.slackName}) → 未マッチ`);
  }
  if (result.unmatchedNotion.length > 0) {
    lines.push(`\n*Notion側で未マッチ:* ${result.unmatchedNotion.join(", ")}`);
  }

  const text = lines.join("\n");

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "section",
      block_id: "pm_select",
      text: { type: "mrkdwn", text: "*PMを選択してください:*" },
      accessory: {
        type: "users_select",
        action_id: "onboarding_pm_select",
        placeholder: { type: "plain_text", text: "PMを選択" }
      }
    },
    {
      type: "actions",
      block_id: "onboarding_confirm",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "確定", emoji: true },
          style: "primary",
          action_id: "onboarding_confirm_members",
          value: JSON.stringify({ channelId })
        },
        {
          type: "button",
          text: { type: "plain_text", text: "修正", emoji: true },
          action_id: "onboarding_edit_members",
          value: JSON.stringify({ channelId })
        }
      ]
    }
  ];

  return { text, blocks };
}

// ── Handle modal submission ──────────────────────────────────────────────

export async function handleSetupModalSubmit(
  env: Bindings,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; errors?: Record<string, string> }> {
  const config = getConfig(env);
  if (!config.notionToken || !config.slackBotToken) {
    return { ok: false, errors: { task_db_url: "Server configuration error" } };
  }

  const view = payload.view as Record<string, unknown>;
  const meta = JSON.parse((view.private_metadata as string) ?? "{}");
  const channelId = meta.channelId as string;
  const userId = (payload.user as Record<string, unknown>)?.id as string;

  const values = (view.state as Record<string, unknown>)?.values as Record<
    string,
    Record<string, { value?: string }>
  >;

  const taskDbUrl = values?.task_db_url?.task_db_url_input?.value ?? "";
  const sprintDbUrl = values?.sprint_db_url?.sprint_db_url_input?.value ?? "";
  const memberDbUrl = values?.member_db_url?.member_db_url_input?.value ?? "";
  const referenceDbUrl = values?.reference_db_url?.reference_db_url_input?.value ?? "";
  const projectName = values?.project_name?.project_name_input?.value ?? "";
  const googleSheetsId = values?.google_sheets_id?.google_sheets_id_input?.value ?? "";

  // Validate all required DBs
  const errors: Record<string, string> = {};
  const [taskResult, sprintResult, memberResult] = await Promise.all([
    validateNotionDb(config.notionToken, taskDbUrl, "タスクDB"),
    validateNotionDb(config.notionToken, sprintDbUrl, "スプリントDB"),
    validateNotionDb(config.notionToken, memberDbUrl, "メンバーDB")
  ]);

  if (!taskResult.ok) errors.task_db_url = taskResult.error!;
  if (!sprintResult.ok) errors.sprint_db_url = sprintResult.error!;
  if (!memberResult.ok) errors.member_db_url = memberResult.error!;

  if (referenceDbUrl) {
    const refResult = await validateNotionDb(config.notionToken, referenceDbUrl, "リファレンスDB");
    if (!refResult.ok) errors.reference_db_url = refResult.error!;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // Save partial config (without memberMap and pmUserId yet — those come after matching)
  const partialConfig: ChannelConfig = {
    taskDbUrl,
    sprintDbUrl,
    memberDbUrl,
    referenceDbUrl: referenceDbUrl || undefined,
    pmUserId: "",  // will be set after PM selection
    memberMap: {},  // will be set after member confirmation
    projectName: projectName || undefined,
    googleSheetsId: googleSheetsId || undefined,
    registeredAt: new Date().toISOString(),
    registeredBy: userId
  };

  // Save as pending config
  await env.NOTIFY_CACHE.put(
    `onboarding-pending:${channelId}`,
    JSON.stringify(partialConfig),
    { expirationTtl: 3600 }  // 1 hour TTL for pending
  );

  // Kick off member matching in the channel
  const auth = await authTest(config.slackBotToken);
  const notionNames = await fetchMemberNames(config.notionToken, memberResult.dbId!);

  if (notionNames.length === 0) {
    await chatPostMessage(
      config.slackBotToken,
      channelId,
      "メンバーDBにメンバーが見つかりませんでした。DBにメンバーを追加してから `@bot 設定変更` で再設定してください。"
    );
    return { ok: true };
  }

  const matchResult = await autoMatchMembers(
    config.slackBotToken,
    channelId,
    notionNames,
    auth.userId
  );

  // Save match result for later confirmation
  await env.NOTIFY_CACHE.put(
    `onboarding-match:${channelId}`,
    JSON.stringify(matchResult),
    { expirationTtl: 3600 }
  );

  const { text, blocks } = buildMatchResultBlocks(matchResult, channelId);
  await chatPostMessage(config.slackBotToken, channelId, text, blocks);

  return { ok: true };
}

// ── Handle member confirmation ───────────────────────────────────────────

export async function handleMemberConfirmation(
  env: Bindings,
  channelId: string,
  pmUserId: string
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const pendingRaw = await env.NOTIFY_CACHE.get(`onboarding-pending:${channelId}`);
  const matchRaw = await env.NOTIFY_CACHE.get(`onboarding-match:${channelId}`);

  if (!pendingRaw || !matchRaw) {
    await chatPostMessage(
      config.slackBotToken,
      channelId,
      "設定データが見つかりません。もう一度 `@bot 設定変更` で設定してください。"
    );
    return;
  }

  const pending = JSON.parse(pendingRaw) as ChannelConfig;
  const matchResult = JSON.parse(matchRaw) as MatchResult;

  // Build memberMap from matched results
  const memberMap: Record<string, string> = {};
  for (const m of matchResult.matched) {
    memberMap[m.slackUserId] = m.notionName;
  }

  const finalConfig: ChannelConfig = {
    ...pending,
    pmUserId,
    memberMap
  };

  await saveChannelConfig(env.NOTIFY_CACHE, channelId, finalConfig);

  // Clean up pending data
  await env.NOTIFY_CACHE.delete(`onboarding-pending:${channelId}`);
  await env.NOTIFY_CACHE.delete(`onboarding-match:${channelId}`);

  const memberCount = Object.keys(memberMap).length;
  await chatPostMessage(
    config.slackBotToken,
    channelId,
    `設定完了！\n・PM: <@${pmUserId}>\n・マッチ済みメンバー: ${memberCount}名\n・プロジェクト: ${finalConfig.projectName ?? "(未設定)"}\n\nメンションで質問・指示できます。`
  );
}
```

**Step 2: Commit**

```bash
git add src/onboarding.ts
git commit -m "feat: add onboarding module with modal, validation, member matching"
```

---

### Task 4: Relax config.ts required checks

**Files:**
- Modify: `src/config.ts:126-131`

**Step 1: Make SPRINT_DB_URL and TASK_DB_URL optional**

Currently `getConfig()` throws if `SPRINT_DB_URL` and `TASK_DB_URL` are missing. Since channel-configured projects provide these via KV, relax the check:

```typescript
// Replace lines 128-131 in getConfig():
// BEFORE:
//   if (!env.SPRINT_DB_URL && !env.SPRINT_DB_NAME)
//     throw new Error("SPRINT_DB_URL or SPRINT_DB_NAME is required");
//   if (!env.TASK_DB_URL && !env.TASK_DB_NAME)
//     throw new Error("TASK_DB_URL or TASK_DB_NAME is required");
//
// AFTER:
// (Remove or comment out these checks — channel config provides them)
```

Remove lines 128-131 entirely. The bot will work without global DB URLs when channel config is present.

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: relax SPRINT_DB_URL/TASK_DB_URL required checks for per-channel config"
```

---

### Task 5: Wire `member_joined_channel` into slackEvents.ts

**Files:**
- Modify: `src/slackEvents.ts:1562-1575`

**Step 1: Add import for onboarding handler**

Add to the imports at the top of `src/slackEvents.ts`:

```typescript
import { handleBotJoinedChannel } from "./onboarding";
```

**Step 2: Add `member_joined_channel` handler before the `app_mention` block**

Insert after the `reaction_removed` handler (after line 1570) and before the `app_mention` handler (line 1572):

```typescript
  // ── member_joined_channel (bot onboarding) ──────────────────────────────
  if (eventType === "member_joined_channel") {
    return respondAndProcess(() => handleBotJoinedChannel(env, event));
  }
```

**Step 3: Commit**

```bash
git add src/slackEvents.ts
git commit -m "feat: handle member_joined_channel for bot onboarding"
```

---

### Task 6: Wire modal + buttons into slackInteractions.ts

**Files:**
- Modify: `src/slackInteractions.ts`

**Step 1: Add imports**

Add at the top of `src/slackInteractions.ts`:

```typescript
import { openSetupModal, handleSetupModalSubmit, handleMemberConfirmation } from "./onboarding";
```

**Step 2: Handle `view_submission` type**

In `handleSlackInteractions()`, after the `message_action` block (after line 271) and before the `block_actions` check (line 275), add:

```typescript
  // ── Modal submissions (view_submission) ─────────────────────────────────
  if (payload.type === "view_submission") {
    const view = (payload as any).view;
    if (view?.callback_id === "onboarding_modal_submit") {
      const result = await handleSetupModalSubmit(env, payload as any);
      if (!result.ok && result.errors) {
        return new Response(
          JSON.stringify({ response_action: "errors", errors: result.errors }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ response_action: "clear" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("ok");
  }
```

**Step 3: Handle onboarding button actions**

In the button routing section (after the existing `phone_reminder_stop` handler around line 296), add:

```typescript
  } else if (actionId === "onboarding_open_modal") {
    const channelId = payload.channel.id;
    await bg(openSetupModal(env, payload.trigger_id, channelId));
  } else if (actionId === "onboarding_confirm_members") {
    const value = action.value ? JSON.parse(action.value) : {};
    // Find selected PM from the payload's state
    const state = (payload as any).state?.values?.pm_select?.onboarding_pm_select;
    const pmUserId = state?.selected_user ?? payload.user.id;
    await bg(handleMemberConfirmation(env, value.channelId, pmUserId));
  } else if (actionId === "onboarding_edit_members") {
    await bg((async () => {
      const config = getConfig(env);
      if (!config.slackBotToken) return;
      await chatPostMessage(
        config.slackBotToken,
        payload.channel.id,
        `<@${payload.user.id}> メンバーマッピングの修正内容をこのチャンネルに投稿してください。\n例: 「@user1 = 山田太郎」\n修正後、再度 \`@bot 設定変更\` で設定し直してください。`,
      );
    })());
  } else if (actionId === "onboarding_pm_select") {
    // PM select is handled as part of the confirm flow, no immediate action needed
  }
```

**Step 4: Update the `SlackInteractionPayload` interface to include `trigger_id` and `state`**

The `trigger_id` is already in the interface (line 206). Verify `state` is accessible — it comes on the raw payload for block actions with `users_select`. The code accesses it via `(payload as any).state` which is sufficient.

**Step 5: Commit**

```bash
git add src/slackInteractions.ts
git commit -m "feat: wire onboarding modal submission and button handlers"
```

---

### Task 7: Use `resolveConfig` in existing handlers

**Files:**
- Modify: `src/slackEvents.ts` (handleMention and other handlers)
- Modify: `src/slackInteractions.ts` (handleTaskActionButton and other handlers)

**Step 1: Add import to slackEvents.ts**

```typescript
import { resolveConfig } from "./channelConfig";
```

**Step 2: Update `handleMention` to use `resolveConfig`**

In `handleMention()` (around line 453 in `slackEvents.ts`), find the line where `getConfig(env)` is called and replace with:

```typescript
const config = await resolveConfig(env, channel);
```

Note: `channel` is extracted from `event.channel` early in the function. Ensure `config` assignment happens after `channel` is available.

**Step 3: Update `handleSlackInteractions` to use `resolveConfig`**

In the interaction handlers that call `getConfig(env)` — `handleTaskActionButton`, `handleTaskModifyButton`, `handlePmReportButton`, `handleEodButton` — replace with:

```typescript
const config = await resolveConfig(env, payload.channel.id);
```

For the `handleSetupModalSubmit` and `openSetupModal` functions, keep using `getConfig(env)` since they need the global config (Notion token, Slack bot token).

**Step 4: Add `@bot 設定変更` command to handleMention**

In `handleMention()`, after extracting the message text, add an early check:

```typescript
// Check for settings command
const cleanText = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();
if (cleanText === "設定変更" || cleanText === "settings") {
  // Post setup button for reconfiguration
  await chatPostMessage(
    config.slackBotToken!,
    channel,
    "設定を変更します。下のボタンから設定画面を開いてください。",
    [{ type: "actions", block_id: "onboarding_setup", elements: [{ type: "button", text: { type: "plain_text", text: "設定変更", emoji: true }, style: "primary", action_id: "onboarding_open_modal" }] }]
  );
  return;
}
```

**Step 5: Commit**

```bash
git add src/slackEvents.ts src/slackInteractions.ts
git commit -m "feat: use resolveConfig for per-channel config in existing handlers"
```

---

### Task 8: Update cron to loop over channel configs

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import**

```typescript
import { listAllChannelConfigs, resolveConfig } from "./channelConfig";
```

**Step 2: Update cron handler**

In the `scheduled()` handler, where cron jobs iterate over members/tasks, wrap the existing logic to loop over all registered channels. The current code uses `getConfig(env)` to get a single config — wrap with:

```typescript
// Get all registered channels (+ a "global" fallback for backward compat)
const channelConfigs = await listAllChannelConfigs(env.NOTIFY_CACHE);
const channels = channelConfigs.map((c) => c.channelId);

// If no channels registered, use global config with PMO channel
if (channels.length === 0 && config.slackPmoChannelId) {
  channels.push(config.slackPmoChannelId);
}

for (const channelId of channels) {
  const channelConfig = await resolveConfig(env, channelId);
  // ... existing cron logic using channelConfig instead of config ...
}
```

The exact refactoring depends on which cron functions need per-channel config. Start with the daily notification and PM report crons, which are the most channel-specific.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: cron jobs loop over registered channel configs"
```

---

### Task 9: Slack App Settings (manual)

**No code changes — manual configuration required.**

**Step 1:** Go to Slack App Settings > Event Subscriptions > Subscribe to bot events

**Step 2:** Add `member_joined_channel` event

**Step 3:** Save and reinstall the app if prompted

---

### Task 10: Deploy and test

**Step 1: Deploy**

```bash
npx wrangler deploy
```

**Step 2: Test the full flow**

1. Invite the bot to a new test channel
2. Verify greeting message appears with setup button
3. Click setup button, fill in modal with valid Notion DB URLs
4. Verify member matching results appear
5. Select PM, click confirm
6. Verify "Setup complete!" message
7. Test a mention in the channel to verify it uses the channel config
8. Test `@bot 設定変更` to verify reconfiguration works

**Step 3: Test backward compatibility**

1. Verify the bot still works in the original channel with global env config
2. Verify cron jobs still fire for both global and channel-configured channels
