import type { Bindings } from "./config";
import { getConfig } from "./config";
import { chatPostMessage, chatUpdate, conversationsOpen, conversationsReplies } from "./slackBot";
import {
  getPendingAction,
  deletePendingAction,
  deletePendingCreateRef,
  getPmThread,
  savePmThread,
  getThreadState,
  saveThreadState,
  toJstDateString,
  appendReply,
  savePhoneReminder
} from "./workflow";
import {
  executeNotionActions,
  executeTaskCreation,
  sendCompletionNotification
} from "./slackEvents";
import { interpretPmReply } from "./llmAnalyzer";
import { fetchNotionUserMap, buildUserMapFromDatabase, appendPageContent } from "./notionWriter";
import type { AllocationProposal, NewTask } from "./schema";

// ── HMAC-SHA256 signature verification (same as slackEvents) ───────────────

async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`)
  );
  const computed =
    "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return computed === signature;
}

// ── Block Kit button builders ──────────────────────────────────────────────

/** Build an actions block with approve/modify/cancel buttons for task or update confirmation */
export function buildApprovalButtons(actionIdPrefix: string): unknown[] {
  return [
    {
      type: "actions",
      block_id: `${actionIdPrefix}_buttons`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 承認", emoji: true },
          style: "primary",
          action_id: `${actionIdPrefix}_approve`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✏️ 修正する", emoji: true },
          action_id: `${actionIdPrefix}_modify`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ キャンセル", emoji: true },
          style: "danger",
          action_id: `${actionIdPrefix}_cancel`
        }
      ]
    }
  ];
}

/** Build buttons for PM report approval */
export function buildPmReportButtons(): unknown[] {
  return [
    {
      type: "actions",
      block_id: "pm_report_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ OK", emoji: true },
          style: "primary",
          action_id: "pm_report_approve"
        }
      ]
    }
  ];
}

/** Build buttons for EOD reminder */
export function buildEodReminderButtons(): unknown[] {
  return [
    {
      type: "actions",
      block_id: "eod_reminder_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 更新済み", emoji: true },
          style: "primary",
          action_id: "eod_updated"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 作業中", emoji: true },
          action_id: "eod_in_progress"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🚫 今日は進捗なし", emoji: true },
          action_id: "eod_no_progress"
        }
      ]
    }
  ];
}

/** Build a text section block from text */
function textSection(text: string): unknown {
  return {
    type: "section",
    text: { type: "mrkdwn", text }
  };
}

// ── Interactive payload handler ────────────────────────────────────────────

interface SlackInteractionPayload {
  type: string;
  callback_id?: string;
  user: { id: string; username?: string };
  channel: { id: string };
  message: {
    ts: string;
    text: string;
    user?: string;
    blocks?: unknown[];
    thread_ts?: string;
  };
  actions?: Array<{
    type: string;
    action_id: string;
    value?: string;
    block_id?: string;
  }>;
  trigger_id: string;
  response_url?: string;
}

export async function handleSlackInteractions(
  request: Request,
  env: Bindings,
  ctx?: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Replay attack prevention
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parseInt(timestamp, 10)) > 300) {
    return new Response("Request timestamp too old", { status: 400 });
  }

  // Signature verification
  const config = getConfig(env);
  if (!config.slackSigningSecret) {
    console.error("SLACK_SIGNING_SECRET not configured");
    return new Response("Server configuration error", { status: 500 });
  }

  const isValid = await verifySlackSignature(
    body,
    timestamp,
    signature,
    config.slackSigningSecret
  );
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Parse URL-encoded payload
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return new Response("Missing payload", { status: 400 });
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractionPayload;
  } catch {
    return new Response("Invalid payload JSON", { status: 400 });
  }

  // Background processing
  const bg = (work: Promise<void>) => {
    if (ctx) {
      ctx.waitUntil(work.catch((err) => console.error("interaction bg task failed:", err)));
    } else {
      return work;
    }
    return Promise.resolve();
  };

  // ── Message shortcut (message_action) ──────────────────────────────────
  if (payload.type === "message_action") {
    if (payload.callback_id === "set_reminder") {
      await bg(handleSetReminderShortcut(env, payload));
    }
    return new Response("ok");
  }

  // ── Button clicks (block_actions) ──────────────────────────────────────
  if (payload.type !== "block_actions") {
    return new Response("ok");
  }

  const action = payload.actions?.[0];
  if (!action) return new Response("ok");

  const actionId = action.action_id;

  // Route to appropriate handler
  if (actionId === "task_action_approve" || actionId === "task_action_cancel") {
    await bg(handleTaskActionButton(env, payload, actionId === "task_action_approve"));
  } else if (actionId === "task_action_modify") {
    await bg(handleTaskModifyButton(env, payload));
  } else if (actionId === "pm_report_approve") {
    await bg(handlePmReportButton(env, payload));
  } else if (actionId.startsWith("eod_")) {
    await bg(handleEodButton(env, payload, actionId));
  }

  // Return 200 immediately (Slack expects response within 3 seconds)
  return new Response("ok");
}

// ── Task/Update approval button handler ────────────────────────────────────

async function handleTaskActionButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  approved: boolean
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = payload.channel.id;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts;
  const userId = payload.user.id;

  const pending = await getPendingAction(env.NOTIFY_CACHE, channel, messageTs);
  if (!pending) {
    console.log(`Button click but no pending action found: channel=${channel} ts=${messageTs}`);
    return;
  }

  // Remove buttons from the original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  if (!approved) {
    // Cancel: update message to show cancelled state, delete pending action
    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n❌ キャンセルされました",
      [
        ...blocksWithoutActions,
        textSection(`❌ <@${userId}> がキャンセルしました`)
      ]
    );
    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }
    console.log(`Action cancelled by ${userId}: channel=${channel} ts=${messageTs}`);
    return;
  }

  // Approved: execute actions
  const createActions = pending.actions.filter((a) => a.action === "create_task");

  if (createActions.length > 0) {
    // Task creation flow
    const dbUserMap = config.taskDbId
      ? await buildUserMapFromDatabase(config.notionToken, config.taskDbId)
      : new Map<string, string>();
    const notionUserMap = await fetchNotionUserMap(config.notionToken);
    const userMaps = { dbUserMap, notionUserMap };

    const taskResults = await Promise.all(
      createActions.map(async (createAction) => {
        const newTask = JSON.parse(createAction.new_value) as NewTask & {
          sprintId?: string;
          projectIds?: string[];
          project?: string | null;
          description?: string;
        };
        const result = await executeTaskCreation(
          {
            notionToken: config.notionToken,
            taskDbId: config.taskDbId,
            taskSprintRelationProperty: config.taskSprintRelationProperty,
            dryRun: config.dryRun
          },
          newTask,
          userMaps
        );

        if (result.pageId && newTask.description) {
          try {
            await appendPageContent(config.notionToken, result.pageId, newTask.description);
          } catch (err) {
            console.warn(`Failed to append description: ${(err as Error).message}`);
          }
        }

        return { result, newTask };
      })
    );

    const allResults = taskResults.map((r) => r.result.message);
    const notificationLines = taskResults.map(
      (r) =>
        `・タスク追加: ${r.newTask.task_name}（担当: ${r.newTask.assignee}、期限: ${r.newTask.due}、SP: ${r.newTask.sp}）`
    );

    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }

    // Update original message: remove buttons, add result
    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n" + allResults.join("\n\n"),
      [
        ...blocksWithoutActions,
        textSection(`✅ <@${userId}> が承認しました\n\n${allResults.join("\n\n")}`)
      ]
    );

    // Channel-wide completion notification
    const pmoChannel = config.slackPmoChannelId;
    if (pmoChannel && !config.dryRun) {
      await sendCompletionNotification(config.slackBotToken, pmoChannel, notificationLines, false);
    }
  } else {
    // Update actions (update_due, update_sp, update_status, etc.)
    const results = await executeNotionActions(
      config.notionToken,
      pending.actions,
      config.dryRun
    );

    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }

    const summaryMsg =
      results.length > 0
        ? `✅ Notion更新完了\n\n更新内容:\n${results.join("\n")}`
        : "✅ 更新する内容がありませんでした。";

    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n" + summaryMsg,
      [
        ...blocksWithoutActions,
        textSection(`✅ <@${userId}> が承認しました\n\n${summaryMsg}`)
      ]
    );

    const pmoChannel = config.slackPmoChannelId;
    if (pmoChannel) {
      await sendCompletionNotification(config.slackBotToken, pmoChannel, results, config.dryRun);
    }
  }

  console.log(`Action approved by ${userId}: channel=${channel} ts=${messageTs}`);
}

// ── Task modify button handler ─────────────────────────────────────────────

async function handleTaskModifyButton(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = payload.channel.id;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;
  const userId = payload.user.id;

  // Remove buttons from original message, keep the content
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText,
    [
      ...blocksWithoutActions,
      textSection(`✏️ <@${userId}> が修正を選択しました`)
    ]
  );

  // Post a prompt in the thread asking for modification details
  await chatPostMessage(
    config.slackBotToken,
    channel,
    `<@${userId}> 修正内容をこのスレッドに返信してください。\n例: 「担当を佐藤に変更」「SPを5に」「期限を来週金曜に」`,
    undefined,
    threadTs
  );

  console.log(`Action modify requested by ${userId}: channel=${channel} ts=${messageTs}`);
}

// ── PM Report approval button handler ──────────────────────────────────────

async function handlePmReportButton(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = payload.channel.id;
  const messageTs = payload.message.ts;
  const userId = payload.user.id;

  const today = toJstDateString();
  const pmThread = await getPmThread(env.NOTIFY_CACHE, today);

  if (!pmThread || pmThread.state !== "pending" || pmThread.channel !== channel || pmThread.ts !== messageTs) {
    console.log(`PM report button click but no matching pending PM thread: channel=${channel} ts=${messageTs}`);
    return;
  }

  // Remove buttons from original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  // Full approval
  const proposal = JSON.parse(pmThread.proposalJson) as AllocationProposal;
  const approvalText = "全提案を承認します";
  const actions = await interpretPmReply(config, proposal, approvalText);

  const results = await executeNotionActions(
    config.notionToken,
    actions.actions,
    config.dryRun
  );

  await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" });

  const summaryMsg =
    results.length > 0
      ? `✅ Notion更新完了\n\n更新内容:\n${results.join("\n")}`
      : "✅ 更新する内容がありませんでした。";

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + "\n\n" + summaryMsg,
    [
      ...blocksWithoutActions,
      textSection(`✅ <@${userId}> がOKしました\n\n${summaryMsg}`)
    ]
  );

  // Channel-wide completion notification
  const pmoChannel = config.slackPmoChannelId;
  if (pmoChannel) {
    await sendCompletionNotification(config.slackBotToken, pmoChannel, results, config.dryRun);
  }

  console.log(`PM report approved by ${userId}`);
}

// ── EOD reminder button handler ────────────────────────────────────────────

async function handleEodButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  actionId: string
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = payload.channel.id;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;
  const userId = payload.user.id;

  // Map action to response text
  const responseMap: Record<string, string> = {
    eod_updated: "✅ タスクのステータスを更新済みです！",
    eod_in_progress: "🔄 まだ作業中です。後で更新します。",
    eod_no_progress: "🚫 今日は進捗がありませんでした。"
  };
  const responseText = responseMap[actionId] ?? "回答済み";

  // Remove buttons from original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + `\n\n<@${userId}>: ${responseText}`,
    [
      ...blocksWithoutActions,
      textSection(`<@${userId}>: ${responseText}`)
    ]
  );

  // Find and update the thread state if this is a tracked thread
  const threadState = await getThreadState(env.NOTIFY_CACHE, channel, threadTs);
  if (threadState && threadState.state === "pending") {
    await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
      ...threadState,
      state: "replied"
    });

    await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
      text: responseText,
      userId,
      receivedAt: new Date().toISOString()
    });
  }

  console.log(`EOD response from ${userId}: ${actionId}`);
}

// ── Message shortcut: set reminder ─────────────────────────────────────────

async function handleSetReminderShortcut(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const userId = payload.user.id;
  const channel = payload.channel.id;
  const messageTs = payload.message.ts;
  // Use thread_ts if the message is in a thread, otherwise use the message itself
  const threadTs = payload.message.thread_ts ?? messageTs;

  // Fetch thread content
  const messages = await conversationsReplies(
    config.slackBotToken,
    channel,
    threadTs,
    100,
    true
  );

  if (messages.length === 0) return;

  const threadContent = messages
    .map((m) => `<@${m.user}>: ${m.text}`)
    .join("\n\n");

  const threadLink = `https://slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;

  const dmText =
    `☎️ *リマインド設定されたスレッド*\n` +
    `<${threadLink}|スレッドを見る>\n\n` +
    `───────────────\n` +
    `${threadContent}\n` +
    `───────────────\n` +
    `_1時間ごとにリマインドします。解除するには ☎️ リアクションを外すか、「リマインド解除」と返信してください。_`;

  // Open DM channel with user
  const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
  if (!dmChannelId) {
    console.error(`Failed to open DM channel for user ${userId}`);
    return;
  }

  // Send initial DM
  await chatPostMessage(config.slackBotToken, dmChannelId, dmText);

  // Save reminder to KV (same as ☎️ reaction flow)
  const now = new Date().toISOString();
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs, {
    userId,
    channel,
    threadTs,
    createdAt: now,
    lastRemindedAt: now
  });

  console.log(`Reminder set via shortcut: user=${userId}, channel=${channel}, threadTs=${threadTs}`);
}
