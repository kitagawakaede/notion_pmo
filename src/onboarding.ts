import { extractNotionIdFromUrl, type Bindings } from "./config";
import {
  chatPostMessage,
  viewsOpen,
  conversationsMembers,
  usersInfo,
  authTest,
} from "./slackBot";
import {
  getChannelConfig,
  saveChannelConfig,
  type ChannelConfig,
} from "./channelConfig";

const NOTION_VERSION = "2022-06-28";
const PENDING_TTL = 3600; // 1 hour
const MATCH_TTL = 3600;

// ---------------------------------------------------------------------------
// KV key helpers
// ---------------------------------------------------------------------------
const pendingKey = (ch: string) => `onboarding-pending:${ch}`;
const matchKey = (ch: string) => `onboarding-match:${ch}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface MatchResult {
  matched: Array<{ slackUserId: string; slackName: string; notionName: string }>;
  unmatched: Array<{ slackUserId: string; slackName: string }>;
  unmatchedNotion: string[];
}

interface PendingConfig {
  taskDbUrl: string;
  sprintDbUrl: string;
  memberDbUrl: string;
  referenceDbUrl?: string;
  projectName?: string;
  googleSheetsId?: string;
  registeredBy: string;
}

// ---------------------------------------------------------------------------
// 1. handleBotJoinedChannel
// ---------------------------------------------------------------------------
export async function handleBotJoinedChannel(
  env: Bindings,
  event: { user: string; channel: string }
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return;

  // Check if the joined user is our bot
  const { userId: botUserId } = await authTest(token);
  if (event.user !== botUserId) return;

  // Check if channel is already configured
  const existing = await getChannelConfig(env.NOTIFY_CACHE, event.channel);
  if (existing) {
    await chatPostMessage(
      token,
      event.channel,
      "このチャンネルは既にセットアップ済みです。再設定したい場合は `/pmo-setup` を実行してください。"
    );
    return;
  }

  // Post greeting with setup button
  await chatPostMessage(
    token,
    event.channel,
    "こんにちは！PMO Bot がチャンネルに参加しました。\nプロジェクトの Notion データベースを接続するには、下のボタンからセットアップを開始してください。",
    [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "セットアップを開始" },
            style: "primary",
            action_id: "onboarding_open_modal",
            value: event.channel,
          },
        ],
      },
    ]
  );
}

// ---------------------------------------------------------------------------
// 2. buildSetupModal
// ---------------------------------------------------------------------------
export function buildSetupModal(
  channelId: string,
  existingConfig?: ChannelConfig
): Record<string, unknown> {
  const prefill = (url?: string) =>
    url ? { type: "plain_text", text: url } : undefined;
  const prefillPlain = (val?: string) =>
    val ? { type: "plain_text", text: val } : undefined;

  return {
    type: "modal",
    callback_id: "onboarding_modal_submit",
    private_metadata: JSON.stringify({ channelId }),
    title: { type: "plain_text", text: "PMO セットアップ" },
    submit: { type: "plain_text", text: "接続する" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "task_db_url",
        label: { type: "plain_text", text: "タスクDB URL" },
        element: {
          type: "url_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.taskDbUrl
            ? { initial_value: existingConfig.taskDbUrl }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "sprint_db_url",
        label: { type: "plain_text", text: "スプリントDB URL" },
        element: {
          type: "url_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.sprintDbUrl
            ? { initial_value: existingConfig.sprintDbUrl }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "member_db_url",
        label: { type: "plain_text", text: "メンバーDB URL" },
        element: {
          type: "url_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.memberDbUrl
            ? { initial_value: existingConfig.memberDbUrl }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "reference_db_url",
        optional: true,
        label: { type: "plain_text", text: "リファレンスDB URL" },
        element: {
          type: "url_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://www.notion.so/..." },
          ...(existingConfig?.referenceDbUrl
            ? { initial_value: existingConfig.referenceDbUrl }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "project_name",
        optional: true,
        label: { type: "plain_text", text: "プロジェクト略称" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "例: ms" },
          ...(existingConfig?.projectName
            ? { initial_value: existingConfig.projectName }
            : {}),
        },
      },
      {
        type: "input",
        block_id: "google_sheets_id",
        optional: true,
        label: { type: "plain_text", text: "Google Sheets ID" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: {
            type: "plain_text",
            text: "スプレッドシートの ID",
          },
          ...(existingConfig?.googleSheetsId
            ? { initial_value: existingConfig.googleSheetsId }
            : {}),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. openSetupModal
// ---------------------------------------------------------------------------
export async function openSetupModal(
  env: Bindings,
  triggerId: string,
  channelId: string
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN!;
  const existing = await getChannelConfig(env.NOTIFY_CACHE, channelId);
  const view = buildSetupModal(channelId, existing ?? undefined);
  await viewsOpen(token, triggerId, view);
}

// ---------------------------------------------------------------------------
// Notion DB validation helper
// ---------------------------------------------------------------------------
async function validateNotionDb(
  notionToken: string,
  url: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = extractNotionIdFromUrl(url);
  if (!id) {
    return { ok: false, error: "Notion DB の URL から ID を抽出できませんでした" };
  }
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Notion API エラー (${res.status}): データベースにアクセスできません`,
      };
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: `Notion API 接続エラー: ${String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Fetch member names from Notion member DB
// ---------------------------------------------------------------------------
async function fetchMemberNames(
  notionToken: string,
  memberDbId: string
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${memberDbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) break;

    const data = (await res.json()) as {
      results: Array<{
        properties: Record<
          string,
          { type: string; title?: Array<{ plain_text: string }> }
        >;
      }>;
      has_more: boolean;
      next_cursor?: string;
    };

    for (const page of data.results) {
      // Find title property — try common names first, then scan
      const titleProp =
        page.properties["名前"] ??
        page.properties["Name"] ??
        page.properties["name"] ??
        Object.values(page.properties).find((p) => p.type === "title");

      if (titleProp?.title) {
        const name = titleProp.title.map((t) => t.plain_text).join("");
        if (name) names.push(name);
      }
    }

    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor);

  return names;
}

// ---------------------------------------------------------------------------
// 4. handleSetupModalSubmit
// ---------------------------------------------------------------------------
export async function handleSetupModalSubmit(
  env: Bindings,
  payload: {
    view: {
      state: {
        values: Record<string, Record<string, { value?: string | null }>>;
      };
      private_metadata: string;
    };
    user: { id: string };
  }
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  const token = env.SLACK_BOT_TOKEN!;
  const notionToken = env.NOTION_OAUTH_ACCESS_TOKEN!;
  const { channelId } = JSON.parse(payload.view.private_metadata) as {
    channelId: string;
  };
  const vals = payload.view.state.values;

  const taskDbUrl = vals.task_db_url?.value?.value ?? "";
  const sprintDbUrl = vals.sprint_db_url?.value?.value ?? "";
  const memberDbUrl = vals.member_db_url?.value?.value ?? "";
  const referenceDbUrl = vals.reference_db_url?.value?.value ?? undefined;
  const projectName = vals.project_name?.value?.value ?? undefined;
  const googleSheetsId = vals.google_sheets_id?.value?.value ?? undefined;

  // Validate required DBs
  const errors: Record<string, string> = {};

  const [taskResult, sprintResult, memberResult] = await Promise.all([
    validateNotionDb(notionToken, taskDbUrl),
    validateNotionDb(notionToken, sprintDbUrl),
    validateNotionDb(notionToken, memberDbUrl),
  ]);

  if (!taskResult.ok) errors.task_db_url = taskResult.error;
  if (!sprintResult.ok) errors.sprint_db_url = sprintResult.error;
  if (!memberResult.ok) errors.member_db_url = memberResult.error;

  // Validate optional reference DB if provided
  if (referenceDbUrl) {
    const refResult = await validateNotionDb(notionToken, referenceDbUrl);
    if (!refResult.ok) errors.reference_db_url = refResult.error;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // Save pending config to KV
  const pending: PendingConfig = {
    taskDbUrl,
    sprintDbUrl,
    memberDbUrl,
    referenceDbUrl: referenceDbUrl || undefined,
    projectName: projectName || undefined,
    googleSheetsId: googleSheetsId || undefined,
    registeredBy: payload.user.id,
  };
  await env.NOTIFY_CACHE.put(pendingKey(channelId), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL,
  });

  // Member matching runs in background (don't block modal response)
  const memberDbId = memberResult.ok ? (memberResult as { ok: true; id: string }).id : "";
  runMemberMatchingInBackground(env, token, notionToken, channelId, memberDbId);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4b. Background member matching (non-blocking)
// ---------------------------------------------------------------------------
function runMemberMatchingInBackground(
  env: Bindings,
  token: string,
  notionToken: string,
  channelId: string,
  memberDbId: string
): void {
  // Fire-and-forget — errors are logged but don't propagate
  (async () => {
    try {
      const notionMemberNames = await fetchMemberNames(notionToken, memberDbId).catch(
        () => [] as string[]
      );

      const { userId: botUserId } = await authTest(token);
      const matchResult = await autoMatchMembers(
        token,
        channelId,
        notionMemberNames,
        botUserId
      );

      await env.NOTIFY_CACHE.put(matchKey(channelId), JSON.stringify(matchResult), {
        expirationTtl: MATCH_TTL,
      });

      const blocks = buildMatchResultBlocks(matchResult, channelId);
      await chatPostMessage(
        token,
        channelId,
        "Notion データベースの接続に成功しました。メンバーのマッチング結果を確認してください。",
        blocks
      );
    } catch (err) {
      console.error(`Onboarding member matching failed for ${channelId}:`, err);
      await chatPostMessage(
        token,
        channelId,
        "メンバーマッチング中にエラーが発生しました。`@bot 設定変更` で再度お試しください。"
      ).catch(() => {});
    }
  })();
}

// ---------------------------------------------------------------------------
// 5. autoMatchMembers
// ---------------------------------------------------------------------------
export async function autoMatchMembers(
  token: string,
  channelId: string,
  notionMemberNames: string[],
  botUserId: string
): Promise<MatchResult> {
  const memberIds = await conversationsMembers(token, channelId);

  // Fetch Slack user info for all non-bot members
  const slackMembers: Array<{
    userId: string;
    realName: string;
    displayName: string;
  }> = [];

  for (const uid of memberIds) {
    if (uid === botUserId) continue;
    const info = await usersInfo(token, uid).catch(() => ({
      realName: "",
      displayName: "",
    }));
    slackMembers.push({ userId: uid, ...info });
  }

  const matched: MatchResult["matched"] = [];
  const unmatched: MatchResult["unmatched"] = [];
  const remainingNotion = new Set(notionMemberNames);

  for (const sm of slackMembers) {
    const slackName = sm.displayName || sm.realName;
    const slackTokens = tokenize(slackName);

    let bestMatch: string | null = null;
    for (const nn of remainingNotion) {
      if (fuzzyMatch(slackTokens, slackName, nn)) {
        bestMatch = nn;
        break;
      }
    }

    if (bestMatch) {
      matched.push({
        slackUserId: sm.userId,
        slackName,
        notionName: bestMatch,
      });
      remainingNotion.delete(bestMatch);
    } else {
      unmatched.push({ slackUserId: sm.userId, slackName });
    }
  }

  return {
    matched,
    unmatched,
    unmatchedNotion: [...remainingNotion],
  };
}

// ---------------------------------------------------------------------------
// Fuzzy matching helpers
// ---------------------------------------------------------------------------
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\/]+/)
    .filter((t) => t.length > 0);
}

function fuzzyMatch(
  slackTokens: string[],
  slackName: string,
  notionName: string
): boolean {
  const notionLower = notionName.toLowerCase();
  const slackLower = slackName.toLowerCase();

  // Direct includes (either direction)
  if (notionLower.includes(slackLower) || slackLower.includes(notionLower)) {
    return true;
  }

  // Token-based matching: split Notion name on / and space
  const notionTokens = tokenize(notionName);

  // Check if any Slack token matches any Notion token
  for (const st of slackTokens) {
    for (const nt of notionTokens) {
      if (st.includes(nt) || nt.includes(st)) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 6. buildMatchResultBlocks
// ---------------------------------------------------------------------------
export function buildMatchResultBlocks(
  result: MatchResult,
  channelId: string
): unknown[] {
  const blocks: unknown[] = [];

  // Matched members section
  if (result.matched.length > 0) {
    const lines = result.matched.map(
      (m) => `• <@${m.slackUserId}> → ${m.notionName}`
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*マッチ済み (${result.matched.length}名)*\n${lines.join("\n")}`,
      },
    });
  }

  // Unmatched Slack members
  if (result.unmatched.length > 0) {
    const lines = result.unmatched.map(
      (m) => `• <@${m.slackUserId}> (${m.slackName}) — 未マッチ`
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*未マッチ Slack メンバー (${result.unmatched.length}名)*\n${lines.join("\n")}`,
      },
    });
  }

  // Unmatched Notion members
  if (result.unmatchedNotion.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*未マッチ Notion メンバー (${result.unmatchedNotion.length}名)*\n${result.unmatchedNotion.map((n) => `• ${n}`).join("\n")}`,
      },
    });
  }

  // PM select
  blocks.push({
    type: "section",
    block_id: "pm_select",
    text: {
      type: "mrkdwn",
      text: "*PM（プロジェクトマネージャー）を選択してください:*",
    },
    accessory: {
      type: "users_select",
      action_id: "onboarding_pm_select",
      placeholder: { type: "plain_text", text: "PM を選択" },
    },
  });

  // Confirm / Edit buttons
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "この内容で確定" },
        style: "primary",
        action_id: "onboarding_confirm_members",
        value: JSON.stringify({ channelId }),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "設定を編集" },
        action_id: "onboarding_edit_members",
        value: JSON.stringify({ channelId }),
      },
    ],
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// 7. handleMemberConfirmation
// ---------------------------------------------------------------------------
export async function handleMemberConfirmation(
  env: Bindings,
  channelId: string,
  pmUserId: string
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN!;
  const kv = env.NOTIFY_CACHE;

  // Read pending config and match result
  const [pendingRaw, matchRaw] = await Promise.all([
    kv.get(pendingKey(channelId)),
    kv.get(matchKey(channelId)),
  ]);

  if (!pendingRaw || !matchRaw) {
    await chatPostMessage(
      token,
      channelId,
      "セットアップデータの有効期限が切れました。もう一度セットアップを実行してください。"
    );
    return;
  }

  const pending = JSON.parse(pendingRaw) as PendingConfig;
  const matchResult = JSON.parse(matchRaw) as MatchResult;

  // Build memberMap from matched results: Slack User ID -> Notion member name
  const memberMap: Record<string, string> = {};
  for (const m of matchResult.matched) {
    memberMap[m.slackUserId] = m.notionName;
  }

  // Build and save final ChannelConfig
  const config: ChannelConfig = {
    taskDbUrl: pending.taskDbUrl,
    sprintDbUrl: pending.sprintDbUrl,
    memberDbUrl: pending.memberDbUrl,
    referenceDbUrl: pending.referenceDbUrl,
    pmUserId,
    memberMap,
    projectName: pending.projectName,
    googleSheetsId: pending.googleSheetsId,
    registeredAt: new Date().toISOString(),
    registeredBy: pending.registeredBy,
  };

  await saveChannelConfig(kv, channelId, config);

  // Clean up pending KV keys
  await Promise.all([
    kv.delete(pendingKey(channelId)),
    kv.delete(matchKey(channelId)),
  ]);

  // Post success message
  await chatPostMessage(
    token,
    channelId,
    `セットアップが完了しました！\n• PM: <@${pmUserId}>\n• メンバーマッチ: ${matchResult.matched.length}名\n• プロジェクト: ${pending.projectName ?? "(未設定)"}\n\nこのチャンネルで PMO Bot をご利用いただけます。`
  );
}
