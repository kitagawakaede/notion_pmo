import type { Bindings } from "./config";
import { getConfig } from "./config";
import { resolveConfig } from "./channelConfig";
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
  savePhoneReminder,
  getPhoneReminder,
  deletePhoneReminder
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

/** Build time selection buttons for phone reminder */
export function buildTimeSelectionButtons(
  userId: string,
  channel: string,
  threadTs: string
): unknown {
  return {
    type: "actions",
    block_id: "phone_time_select",
    elements: [1, 3, 6, 24].map(h => ({
      type: "button",
      text: { type: "plain_text", text: `${h}時間`, emoji: true },
      action_id: `phone_reminder_schedule_${h}`,
      value: JSON.stringify({ hours: h, userId, channel, threadTs })
    }))
  };
}

/** Build reminder delivery buttons (stop + reschedule) */
export function buildReminderDeliveryButtons(
  userId: string,
  channel: string,
  threadTs: string
): unknown {
  return {
    type: "actions",
    block_id: "phone_reminder_actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "リマインド終了", emoji: true },
        style: "danger",
        action_id: "phone_reminder_stop",
        value: JSON.stringify({ userId, channel, threadTs })
      },
      ...[1, 3, 6, 24].map(h => ({
        type: "button",
        text: { type: "plain_text", text: `${h}時間`, emoji: true },
        action_id: `phone_reminder_schedule_${h}`,
        value: JSON.stringify({ hours: h, userId, channel, threadTs })
      }))
    ]
  };
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

  // ── Modal submissions (view_submission) ─────────────────────────────────
  if (payload.type === "view_submission") {
    return new Response("ok");
  }

  // ── Button clicks (block_actions) ──────────────────────────────────────
  if (payload.type !== "block_actions") {
    return new Response("ok");
  }

  const action = payload.actions?.[0];
  if (!action) return new Response("ok");

  const actionId = action.action_id;

  // Determine the handler for this action
  let handler: Promise<void> | null = null;

  if (actionId === "task_action_approve" || actionId === "task_action_cancel") {
    handler = handleTaskActionButton(env, payload, actionId === "task_action_approve");
  } else if (actionId === "task_action_modify") {
    handler = handleTaskModifyButton(env, payload);
  } else if (actionId === "pm_report_approve") {
    handler = handlePmReportButton(env, payload);
  } else if (actionId.startsWith("eod_")) {
    handler = handleEodButton(env, payload, actionId);
  } else if (actionId.startsWith("phone_reminder_schedule")) {
    handler = handleReminderScheduleButton(env, payload, action);
  } else if (actionId === "phone_reminder_stop") {
    handler = handleReminderStopButton(env, payload, action);
  }

  if (!handler) {
    return new Response("ok");
  }

  // Use TransformStream to keep Worker alive beyond 30s waitUntil limit
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const task = (async () => {
    try {
      await handler;
    } catch (err) {
      console.error("interaction handler failed:", err);
    } finally {
      await writer.write(new TextEncoder().encode("ok"));
      await writer.close();
    }
  })();
  if (ctx) ctx.waitUntil(task);
  return new Response(readable, { status: 200 });
}

// ── Task/Update approval button handler ────────────────────────────────────

async function handleTaskActionButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  approved: boolean
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
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
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
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
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = payload.message.ts;
  const userId = payload.user.id;

  const today = toJstDateString();
  // Try channel-scoped PM thread first, then global (backward compat)
  let pmThread = await getPmThread(env.NOTIFY_CACHE, today, channel);
  let pmThreadScope: string | undefined = channel;
  if (!pmThread) {
    pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    pmThreadScope = undefined;
  }

  if (!pmThread || pmThread.state !== "pending" || pmThread.channel !== channel || pmThread.ts !== messageTs) {
    console.log(`PM report button mismatch: pmThread=${pmThread ? JSON.stringify({ state: pmThread.state, ts: pmThread.ts, channel: pmThread.channel }) : "null"}, clicked: channel=${channel} ts=${messageTs}, today=${today}`);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `⚠️ このボタンは既に処理済みか、有効期限が切れています。`,
      undefined,
      messageTs
    );
    return;
  }

  // Remove buttons from original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  // Mark as processed FIRST to prevent reminder from firing during execution
  // Save back to the SAME scope key we read from, so the reminder cron sees "processed"
  await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, pmThreadScope);
  // Also mark the other scope as processed in case reminder checks both
  if (pmThreadScope === undefined) {
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, channel);
  } else {
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, undefined);
  }

  // Full approval
  const proposal = JSON.parse(pmThread.proposalJson) as AllocationProposal;
  const approvalText = "全提案を承認します";
  const actions = await interpretPmReply(config, proposal, approvalText);

  const results = await executeNotionActions(
    config.notionToken,
    actions.actions,
    config.dryRun
  );

  const summaryMsg = results.length > 0
    ? `\n\nNotion更新完了:\n${results.join("\n")}`
    : "";

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + summaryMsg,
    [
      ...blocksWithoutActions,
      textSection(`✅ <@${userId}> がOKしました${summaryMsg}`)
    ]
  );

  // Thread reply for visibility
  await chatPostMessage(
    config.slackBotToken,
    channel,
    `✅ <@${userId}> がOKしました${summaryMsg}`,
    undefined,
    messageTs
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
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
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
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;

  const userId = payload.user.id;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;

  // Fetch the target message
  let messages: Awaited<ReturnType<typeof conversationsReplies>> = [];
  try {
    messages = await conversationsReplies(config.slackBotToken, channel, threadTs, 1, true);
    if (messages.length > 1) messages = [messages[0]];
  } catch {
    // thread_not_found — link-only
  }

  const threadLink = `https://slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
  const messageContent = messages.length > 0
    ? `<@${messages[0].user}>: ${messages[0].text}`
    : "";

  const dmText =
    `☎️ *リマインド設定されたメッセージ*\n` +
    `<${threadLink}|メッセージを見る>\n\n` +
    (messageContent ? `───────────────\n${messageContent}\n───────────────\n\n` : "") +
    `_以下のボタンからリマインドまでの時間を選択してください。_`;

  const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
  if (!dmChannelId) {
    console.error(`Failed to open DM channel for user ${userId}`);
    return;
  }

  const dmResult = await chatPostMessage(
    config.slackBotToken,
    dmChannelId,
    dmText,
    [buildTimeSelectionButtons(userId, channel, threadTs)]
  );

  const now = new Date().toISOString();
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs, {
    userId,
    channel,
    threadTs,
    messageContent,
    threadLink,
    createdAt: now,
    remindAt: "",
    dmChannel: dmChannelId,
    initialDmTs: dmResult.ts,
    status: "pending"
  });

  console.log(`Reminder set via shortcut: user=${userId}, channel=${channel}, threadTs=${threadTs}`);
}

// ── Phone reminder schedule button handler ──────────────────────────────────

async function handleReminderScheduleButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const payloadChannel = payload.channel.id;
  const config = await resolveConfig(env, payloadChannel);
  if (!config.slackBotToken) return;

  if (!action.value) return;
  const { hours, userId, channel, threadTs } = JSON.parse(action.value) as {
    hours: number;
    userId: string;
    channel: string;
    threadTs: string;
  };

  const reminder = await getPhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs);
  if (!reminder) {
    console.log(`handleReminderScheduleButton: no reminder found for user=${userId}, threadTs=${threadTs}`);
    const dmChannel = payload.channel.id;
    const dmTs = payload.message.ts;
    await chatUpdate(
      config.slackBotToken,
      dmChannel,
      dmTs,
      "⚠️ リマインダーが見つかりません。もう一度 ☎️ リアクションを付けてください。",
      [textSection("⚠️ リマインダーが見つかりません。もう一度 ☎️ リアクションを付けてください。")]
    );
    return;
  }

  // Calculate remind time
  const remindAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  // Update KV
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs, {
    ...reminder,
    remindAt,
    status: "pending"
  });

  // Build updated DM content
  const dmText =
    `☎️ *${hours}時間後にリマインドします！*\n` +
    `<${reminder.threadLink}|メッセージを見る>\n\n` +
    (reminder.messageContent ? `───────────────\n${reminder.messageContent}\n───────────────\n\n` : "") +
    `_変更したい場合は以下のボタンから再度選択してください。_`;

  // Update the DM message (replace buttons with new state)
  const dmChannel = payload.channel.id;
  const dmTs = payload.message.ts;

  await chatUpdate(
    config.slackBotToken,
    dmChannel,
    dmTs,
    dmText,
    [
      textSection(dmText),
      buildTimeSelectionButtons(userId, channel, threadTs)
    ]
  );

  console.log(`Reminder scheduled: user=${userId}, hours=${hours}, remindAt=${remindAt}`);
}

// ── Phone reminder stop button handler ──────────────────────────────────────

async function handleReminderStopButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const payloadChannel = payload.channel.id;
  const config = await resolveConfig(env, payloadChannel);
  if (!config.slackBotToken) return;

  if (!action.value) return;
  const { userId, channel, threadTs } = JSON.parse(action.value) as {
    userId: string;
    channel: string;
    threadTs: string;
  };

  // Delete from KV
  await deletePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs);

  // Update DM to show stopped state (remove buttons)
  const dmChannel = payload.channel.id;
  const dmTs = payload.message.ts;

  await chatUpdate(
    config.slackBotToken,
    dmChannel,
    dmTs,
    "☎️ リマインドを終了しました。",
    [textSection("☎️ リマインドを終了しました。")]
  );

  console.log(`Reminder stopped via button: user=${userId}, channel=${channel}, threadTs=${threadTs}`);
}
