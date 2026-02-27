import type { Bindings } from "./config";
import { getConfig } from "./config";
import {
  getThreadState,
  saveThreadState,
  getPmThread,
  savePmThread,
  appendReply,
  savePendingAction,
  getPendingAction,
  deletePendingAction,
  getMentionHistory,
  appendMentionHistory,
  savePendingProjectSelection,
  getPendingProjectSelection,
  deletePendingProjectSelection,
  savePendingCreateRef,
  getPendingCreateRef,
  deletePendingCreateRef,
  toJstDateString,
  savePhoneReminder,
  deletePhoneReminder,
  savePhoneReminderDm,
  getPhoneReminderDm
} from "./workflow";
import { chatPostMessage, conversationsHistory, conversationsReplies, conversationsOpen } from "./slackBot";
import { interpretPmReply, interpretMention, evaluateAssigneeReply, generateTaskDescription } from "./llmAnalyzer";
import { updateTaskPage, updateTaskSprint, createTaskPage, fetchNotionUserMap, buildUserMapFromDatabase, searchProjectsByName, appendPageContent } from "./notionWriter";
import { fetchCurrentSprintTasksSummary, fetchSprintCapacity, fetchAllSprints, fetchReferenceDbItems } from "./notionApi";
import { fetchMembers } from "./memberApi";
import {
  calculateAvgDailySpConsumption,
  calcAvgDailySpFromSprint,
  detectStagnantDoingTasks,
  calculateWeeklyDiff
} from "./index";
import { fetchScheduleData, analyzeScheduleDeviation } from "./sheetsApi";
import type { AllocationProposal, NewTask, MentionContext } from "./schema";
import { buildApprovalButtons } from "./slackInteractions";

// ── HMAC-SHA256 signature verification ────────────────────────────────────

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

// ── Execute a Notion task creation ──────────────────────────────────────────

export async function executeTaskCreation(
  config: {
    notionToken: string;
    taskDbId?: string;
    taskSprintRelationProperty: string;
    dryRun: boolean;
  },
  task: NewTask & { sprintId?: string; projectIds?: string[]; project?: string | null },
  userMaps?: { dbUserMap: Map<string, string>; notionUserMap: Map<string, string> }
): Promise<{ message: string; pageId?: string }> {
  if (!config.taskDbId) {
    return { message: "❌ TASK_DB_URL が未設定のためタスクを作成できません" };
  }

  // Resolve assignee name → Notion user ID
  // Try exact match first, then partial match (e.g. "北川" matches "北川楓")
  const findUser = (map: Map<string, string>, name: string): string | undefined => {
    // Exact match
    const exact = map.get(name);
    if (exact) return exact;
    // Partial match: input is substring of Notion name, or vice versa
    for (const [notionName, id] of map) {
      if (notionName.includes(name) || name.includes(notionName)) {
        console.log(`Assignee partial match: "${name}" → "${notionName}" (${id})`);
        return id;
      }
    }
    return undefined;
  };

  let assigneeId: string | undefined;
  const dbMap = userMaps?.dbUserMap ?? (config.taskDbId ? await buildUserMapFromDatabase(config.notionToken, config.taskDbId) : new Map<string, string>());
  assigneeId = findUser(dbMap, task.assignee);
  if (!assigneeId) {
    const notionMap = userMaps?.notionUserMap ?? await fetchNotionUserMap(config.notionToken);
    assigneeId = findUser(notionMap, task.assignee);
  }

  const properties: Record<string, unknown> = {
    名前: { title: [{ text: { content: task.task_name } }] },
    期限: { date: { start: task.due } },
    SP: { number: task.sp },
    ステータス: { status: { name: task.status } }
  };

  if (assigneeId) {
    properties["担当者"] = { people: [{ id: assigneeId }] };
  }

  if (task.sprintId) {
    properties[config.taskSprintRelationProperty] = {
      relation: [{ id: task.sprintId }]
    };
  }

  // Project IDs are already resolved in handleMention before confirmation
  const resolvedProjectIds = task.projectIds ?? [];
  if (resolvedProjectIds.length > 0) {
    properties["プロジェクト"] = {
      relation: resolvedProjectIds.map((id) => ({ id }))
    };
  }

  console.log(`createTask: sprintId=${task.sprintId ?? "(none)"}, projectIds=${task.projectIds?.join(",") ?? "(none)"}, assigneeId=${assigneeId ?? "(none)"}`);
  console.log(`createTask properties:`, JSON.stringify(properties));

  if (config.dryRun) {
    const assigneeNote = assigneeId
      ? `${task.assignee} (${assigneeId})`
      : `${task.assignee} (⚠️ Notion ユーザー未検出)`;
    console.log(`DRY_RUN: create task "${task.task_name}" assignee=${assigneeNote}`);
    return { message: `（DRY_RUN）タスク「${task.task_name}」を作成予定\n担当: ${assigneeNote}\n期限: ${task.due}\nSP: ${task.sp}` };
  }

  let createdPageId: string | undefined;
  try {
    createdPageId = await createTaskPage(config.notionToken, config.taskDbId, properties);
  } catch (err) {
    console.error(`Failed to create task "${task.task_name}"`, (err as Error).message);
    return { message: `❌ タスク作成失敗: ${task.task_name}\nエラー: ${(err as Error).message}` };
  }

  const assigneeNote = assigneeId
    ? task.assignee
    : `${task.assignee}（⚠️ Notion ユーザー未検出のため担当者未設定）`;

  return {
    message: `✅ タスク作成完了\n・タスク名: ${task.task_name}\n・担当: ${assigneeNote}\n・期限: ${task.due}\n・SP: ${task.sp}`,
    pageId: createdPageId
  };
}

// ── Fetch related messages from channel for task description ─────────────

async function fetchChannelContext(
  token: string,
  channel: string
): Promise<Array<{ text: string; user: string; ts: string }>> {
  try {
    const messages = await conversationsHistory(token, channel, 50);
    console.log(`fetchChannelContext: got ${messages.length} messages from channel`);

    const result: Array<{ text: string; user: string; ts: string }> = [];
    let threadsFetched = 0;

    for (const msg of messages) {
      if (!msg.text) continue;
      result.push({ text: msg.text, user: msg.user, ts: msg.ts });

      // Fetch thread replies for threaded messages (max 5 threads)
      if (msg.reply_count && msg.reply_count > 0 && threadsFetched < 5) {
        try {
          const threadTs = msg.thread_ts ?? msg.ts;
          const replies = await conversationsReplies(token, channel, threadTs, 10);
          for (const reply of replies) {
            result.push({ text: reply.text, user: reply.user, ts: reply.ts });
          }
          threadsFetched++;
        } catch (err) {
          console.warn(`fetchChannelContext: thread ${msg.ts} replies failed: ${(err as Error).message}`);
        }
      }
    }

    console.log(`fetchChannelContext: ${result.length} total messages (including threads)`);
    return result.slice(0, 50);
  } catch (err) {
    console.warn(`fetchChannelContext error: ${(err as Error).message}`);
    return [];
  }
}

// ── Step 9: Channel-wide completion notification ─────────────────────────

export async function sendCompletionNotification(
  botToken: string,
  channel: string,
  results: string[],
  dryRun: boolean
): Promise<void> {
  if (results.length === 0) return;

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getMonth() + 1;
  const day = jst.getDate();
  const hours = String(jst.getHours()).padStart(2, "0");
  const minutes = String(jst.getMinutes()).padStart(2, "0");
  const timestamp = `${month}/${day} ${hours}:${minutes}`;

  const prefix = dryRun ? "（DRY_RUN）" : "";
  const text = `${prefix}✅ Notion更新完了（${timestamp}）\n\n更新内容:\n${results.join("\n")}`;

  await chatPostMessage(botToken, channel, text);
}

// ── Execute a list of Notion update actions ────────────────────────────────

export async function executeNotionActions(
  token: string,
  actions: Array<{
    action: string;
    page_id: string;
    task_name: string;
    new_value: string;
  }>,
  dryRun: boolean
): Promise<string[]> {
  const results: string[] = [];

  for (const action of actions) {
    // update_assignee is implemented but not active yet — log only
    if (action.action === "update_assignee") {
      console.log(`[NOT ACTIVE] update_assignee: ${action.task_name} → ${action.new_value}`);
      results.push(`（未有効）${action.task_name}: 担当者変更 → ${action.new_value}`);
      continue;
    }

    // update_sprint — move task to another sprint or backlog
    if (action.action === "update_sprint") {
      if (dryRun) {
        const label = action.new_value ? `スプリント ${action.new_value}` : "バックログ";
        console.log(`DRY_RUN: update_sprint ${action.task_name} → ${label}`);
        results.push(`（DRY_RUN）${action.task_name}: スプリント移動 → ${label}`);
        continue;
      }
      try {
        await updateTaskSprint(token, action.page_id, action.new_value);
        const label = action.new_value ? `スプリント移動` : "バックログ戻し";
        results.push(`・${action.task_name}: ${label}`);
      } catch (err) {
        console.error(`Failed to update sprint for ${action.page_id}`, (err as Error).message);
        results.push(`・${action.task_name}: スプリント移動失敗 (${(err as Error).message})`);
      }
      continue;
    }

    const updates =
      action.action === "update_due"
        ? { due: action.new_value }
        : action.action === "update_sp"
        ? { sp: parseFloat(action.new_value) }
        : action.action === "update_status"
        ? { status: action.new_value }
        : {};

    if (Object.keys(updates).length === 0) {
      console.warn(`Unknown action type: ${action.action}`);
      continue;
    }

    if (dryRun) {
      console.log(`DRY_RUN: ${action.action} ${action.task_name} → ${action.new_value}`);
      results.push(`（DRY_RUN）${action.task_name}: ${action.action} → ${action.new_value}`);
      continue;
    }

    try {
      await updateTaskPage(token, action.page_id, updates);
      results.push(`・${action.task_name}: ${action.action} → ${action.new_value}`);
    } catch (err) {
      console.error(`Failed to update task ${action.page_id}`, (err as Error).message);
      results.push(`・${action.task_name}: 更新失敗 (${(err as Error).message})`);
    }
  }

  return results;
}

// ── SP → 推定時間 変換テーブル（非線形） ──────────────────────────────────
// 8SP=~10h, 5SP=~6h, 3SP=~2.5h, 2SP=~1.5h
const SP_HOURS_TABLE: [number, number][] = [
  [1, 0.5],
  [2, 1.5],
  [3, 2.5],
  [5, 6],
  [8, 10],
];

function estimateHoursFromSp(sp: number): number {
  if (sp <= 0) return 0;

  // Exact match
  const exact = SP_HOURS_TABLE.find(([s]) => s === sp);
  if (exact) return exact[1];

  // Below minimum — extrapolate from first segment
  if (sp < SP_HOURS_TABLE[0][0]) {
    const [s1, h1] = SP_HOURS_TABLE[0];
    const [s2, h2] = SP_HOURS_TABLE[1];
    const rate = (h2 - h1) / (s2 - s1);
    return Math.max(0, h1 + rate * (sp - s1));
  }

  // Interpolation between known points
  for (let i = 0; i < SP_HOURS_TABLE.length - 1; i++) {
    const [s1, h1] = SP_HOURS_TABLE[i];
    const [s2, h2] = SP_HOURS_TABLE[i + 1];
    if (sp > s1 && sp < s2) {
      const ratio = (sp - s1) / (s2 - s1);
      return h1 + ratio * (h2 - h1);
    }
  }

  // Above maximum — extrapolate from last segment
  const [sN1, hN1] = SP_HOURS_TABLE[SP_HOURS_TABLE.length - 2];
  const [sN, hN] = SP_HOURS_TABLE[SP_HOURS_TABLE.length - 1];
  const rate = (hN - hN1) / (sN - sN1);
  return hN + rate * (sp - sN);
}

// ── Handle project selection reply (番号でプロジェクト選択) ─────────────────

async function handleProjectSelectionReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<boolean> {
  const config = getConfig(env);
  if (!config.slackBotToken) return false;

  const channel = event.channel as string;
  const threadTs = event.thread_ts as string;
  const text = ((event.text as string) ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const userId = (event.user as string) ?? "";
  const userMention = userId ? `<@${userId}> ` : "";

  const pending = await getPendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
  if (!pending) return false;

  // Only the original requester can select
  if (pending.requestedBy !== userId) return false;

  // Cancel keywords
  const cancelWords = ["キャンセル", "cancel", "やめる", "中止"];
  if (cancelWords.some((w) => text.toLowerCase().includes(w))) {
    await deletePendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}タスク作成をキャンセルしました。`,
      undefined,
      threadTs
    );
    return true;
  }

  // Parse number
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 1 || num > pending.candidates.length) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}1〜${pending.candidates.length} の番号で選んでください！（キャンセルする場合は「キャンセル」と送ってください）`,
      undefined,
      threadTs
    );
    return true;
  }

  const selected = pending.candidates[num - 1];
  const resolvedProjectIds = [selected.id];

  await deletePendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);

  // Build confirmation message
  const task = pending.newTask;
  const responseText = [
    "以下のタスクを追加します。問題なければ ✅ をリアクションしてください:",
    `・タスク名: *${task.task_name}*`,
    `・担当: ${task.assignee}`,
    `・期限: ${task.due}`,
    `・SP: ${task.sp}`,
    `・ステータス: ${task.status}`,
    `📁 プロジェクト: *${selected.name}*`
  ].join("\n");

  const confirmMsg = await chatPostMessage(
    config.slackBotToken,
    channel,
    `${userMention}${responseText}`,
    buildApprovalButtons("task_action"),
    threadTs
  );

  // Store as pending action (same as normal create_task flow)
  await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
    actions: [{
      action: "create_task",
      page_id: "",
      task_name: task.task_name,
      new_value: JSON.stringify({
        ...task,
        projectIds: resolvedProjectIds
      })
    }],
    requestedBy: userId,
    requestedAt: new Date().toISOString(),
    threadTs
  });

  // Save thread-level reference for potential modifications
  await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
    confirmMsgTs: confirmMsg.ts
  });

  console.log(`Project selected: "${selected.name}" (${selected.id}) for task "${task.task_name}"`);
  return true;
}

// ── Handle @mention (app_mention event) ───────────────────────────────────

async function handleMention(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = event.channel as string;
  const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string);
  const rawText = (event.text as string) ?? "";
  const userId = (event.user as string) ?? "";
  const userMention = userId ? `<@${userId}> ` : "";

  console.log(`handleMention: channel=${channel}, threadTs=${threadTs}, rawText="${rawText}", userId=${userId}`);

  // Strip bot mention tokens like <@U12345>
  const userText = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!userText) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}何かお手伝いできますか？ タスク状況の確認や更新をリクエストしてください。`,
      undefined,
      threadTs
    );
    return;
  }

  // Shortcut: if user @mentions with a number and there's a pending project selection,
  // handle it directly without LLM call
  if (/^\d+$/.test(userText) || /^(キャンセル|cancel|やめる|中止)$/i.test(userText)) {
    const pendingSelection = await getPendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
    if (pendingSelection) {
      const handled = await handleProjectSelectionReply(env, {
        ...event,
        text: userText
      });
      if (handled) return;
    }
  }

  try {
    const now = new Date();
    const today = toJstDateString(now);

    // Fetch current sprint tasks for LLM context
    const summary = await fetchCurrentSprintTasksSummary(config, now);

    // Build current task snapshot for helper functions
    const currentSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );

    // Fetch all context data in parallel (including thread/channel context and KV lookups)
    const hasThread = !!event.thread_ts;
    const [
      members,
      capacities,
      scheduleDataResult,
      spConsumption,
      weeklyDiff,
      stagnantTasks,
      allSprints,
      referenceItems,
      rawThreadMsgs,
      rawChannelMsgs,
      threadStateResult,
      conversationHistoryResult,
      pendingCreateRefResult
    ] = await Promise.all([
      fetchMembers(config).catch(() => []),
      fetchSprintCapacity(config, summary.sprint.id).catch(() => []),
      fetchScheduleData(config).catch(() => null),
      calculateAvgDailySpConsumption(env.NOTIFY_CACHE, summary.sprint.id, today).catch(() => null),
      calculateWeeklyDiff(env.NOTIFY_CACHE, summary.sprint.id, today, currentSnapshot).catch(() => null),
      detectStagnantDoingTasks(env.NOTIFY_CACHE, summary.sprint.id, today, currentSnapshot).catch(() => []),
      fetchAllSprints(config).catch(() => []),
      hasThread ? Promise.resolve([]) : fetchReferenceDbItems(config).catch(() => []),
      // Thread & channel context (parallelized with above)
      hasThread
        ? conversationsReplies(config.slackBotToken, channel, threadTs, 30, true).catch(() => [] as Array<{ ts: string; text: string; user: string }>)
        : Promise.resolve([] as Array<{ ts: string; text: string; user: string }>),
      hasThread
        ? fetchChannelContext(config.slackBotToken, channel).catch(() => [] as Array<{ text: string; user: string; ts: string }>)
        : Promise.resolve([] as Array<{ text: string; user: string; ts: string }>),
      // KV lookups (parallelized with above)
      getThreadState(env.NOTIFY_CACHE, channel, threadTs).catch(() => null),
      getMentionHistory(env.NOTIFY_CACHE, channel, threadTs).catch(() => [] as Array<{ role: "user" | "assistant"; content: string }>),
      getPendingCreateRef(env.NOTIFY_CACHE, channel, threadTs).catch(() => null)
    ]);

    // Merge capacity data into members
    for (const member of members) {
      const cap = capacities.find(
        (c) => c.name === member.name || c.name.includes(member.name) || member.name.includes(c.name)
      );
      if (cap) member.availableHours = cap.remainingHours;
    }

    // Calculate avg daily SP (priority: KV 7-day history > sprint-level)
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    if (avgDailySp == null) {
      avgDailySp = calcAvgDailySpFromSprint(summary, today);
    }

    // Calculate sprint metrics
    const planSp = typeof summary.sprint_metrics?.plan_sp === "number"
      ? summary.sprint_metrics.plan_sp : null;
    const progressSp = typeof summary.sprint_metrics?.progress_sp === "number"
      ? summary.sprint_metrics.progress_sp : null;
    const remainingSp = planSp != null && progressSp != null ? planSp - progressSp : null;
    const endDate = new Date(`${summary.sprint.end_date}T00:00:00Z`);
    const startDate = new Date(`${summary.sprint.start_date}T00:00:00Z`);
    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
    const elapsedDays = Math.ceil((now.getTime() - startDate.getTime()) / 86400000) + 1;
    const remainingDays = totalDays > 0 ? Math.max(totalDays - elapsedDays, 1) : 1;
    const requiredSpPerDay = typeof summary.sprint_metrics?.required_sp_per_day === "number"
      ? summary.sprint_metrics.required_sp_per_day
      : remainingSp != null
        ? Math.round((remainingSp / remainingDays) * 100) / 100
        : null;

    // Build schedule deviation summary
    let scheduleDeviation: MentionContext["scheduleDeviation"] = null;
    if (scheduleDataResult && scheduleDataResult.rows.length > 0) {
      const deviation = analyzeScheduleDeviation(scheduleDataResult, today);
      scheduleDeviation = {
        onTrack: deviation.onTrack.length,
        delayed: deviation.delayed.length,
        atRisk: deviation.atRisk.length,
        delayedItems: deviation.delayed.map((row) => ({
          category: row.category,
          item: row.item,
          plannedEnd: row.plannedEnd ?? ""
        })),
        atRiskItems: deviation.atRisk.map((row) => ({
          category: row.category,
          item: row.item,
          plannedEnd: row.plannedEnd ?? ""
        }))
      };
    }

    // Build member context with workload info (partial name matching)
    // requiredHours is calculated per-task using non-linear SP→hours conversion
    const memberContext: MentionContext["members"] = members.map((m) => {
      const assigneeTasks = summary.assignees.find(
        (a) => a.name === m.name || a.name.includes(m.name) || m.name.includes(a.name)
      );
      const cap = capacities.find(
        (c) => c.name === m.name || c.name.includes(m.name) || m.name.includes(c.name)
      );
      const taskCount = assigneeTasks?.tasks.length ?? 0;
      const totalSp = assigneeTasks?.tasks.reduce((sum, t) => sum + (t.sp ?? 0), 0) ?? 0;
      const requiredHours = assigneeTasks?.tasks.reduce(
        (sum, t) => sum + estimateHoursFromSp(t.sp ?? 0), 0
      ) ?? 0;
      const hoursPerSp = totalSp > 0 ? Math.round((requiredHours / totalSp) * 100) / 100 : 0;
      const remainingHours = cap?.remainingHours ?? m.availableHours ?? null;
      const totalHours = cap?.totalHours ?? null;
      const utilization = remainingHours != null && remainingHours > 0
        ? Math.round((requiredHours / remainingHours) * 100)
        : null;
      return {
        name: assigneeTasks?.name ?? m.name,
        remainingHours,
        totalHours,
        hoursPerSp,
        currentTaskCount: taskCount,
        currentTotalSp: totalSp,
        requiredHours: Math.round(requiredHours * 10) / 10,
        utilization
      };
    });

    const mentionContext: MentionContext = {
      sprintMetrics: {
        plan_sp: planSp,
        progress_sp: progressSp,
        remaining_sp: remainingSp,
        required_sp_per_day: requiredSpPerDay
      },
      avgDailySp,
      members: memberContext,
      scheduleDeviation,
      weeklyDiff,
      stagnantTasks,
      availableSprints: allSprints.map((s) => ({
        id: s.id,
        name: s.name,
        start_date: s.start_date,
        end_date: s.end_date
      }))
    };

    // Resolve Slack user ID → member name for "自分" resolution
    const requestUserName = members.find((m) => m.slackUserId === userId)?.name;

    // Build Slack user ID → member name map for resolving <@U12345> mentions
    const slackIdToName = new Map<string, string>();
    for (const m of members) {
      if (m.slackUserId) {
        slackIdToName.set(m.slackUserId, m.name);
      }
    }
    const resolveSlackMentions = (text: string): string =>
      text.replace(/<@([A-Z0-9]+)>/g, (_, id) => {
        const name = slackIdToName.get(id);
        return name ? `@${name}` : `<@${id}>`;
      });
    const resolveUserIdName = (uid: string): string =>
      slackIdToName.get(uid) ?? uid;

    // Process thread/channel context from parallel fetch results
    let threadContext: Array<{ text: string; user: string }> | undefined;
    let channelContext: Array<{ text: string; user: string }> | undefined;
    if (hasThread) {
      if (rawThreadMsgs.length > 0) {
        threadContext = rawThreadMsgs.map((m) => ({
          text: resolveSlackMentions(m.text),
          user: resolveUserIdName(m.user)
        }));
        console.log(`Thread context: ${threadContext.length} messages from thread ${threadTs}`);
      }
      if (rawChannelMsgs.length > 0) {
        channelContext = rawChannelMsgs.map((m) => ({
          text: resolveSlackMentions(m.text),
          user: resolveUserIdName(m.user)
        }));
        console.log(`Channel context: ${channelContext.length} messages for cross-reference`);
      }
    }

    // Process thread state from parallel fetch result
    const threadState = threadStateResult;
    if (threadState) {
      // Save as assignee reply (for evening flow)
      await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
        text: userText,
        userId,
        receivedAt: new Date().toISOString()
      });
      await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
        ...threadState,
        state: "replied"
      });
      console.log(`Also saved as assignee reply from ${threadState.assigneeName}`);
    }

    // Process conversation history from parallel fetch result
    let conversationHistory = conversationHistoryResult;

    // If this is a morning flow thread and no mention history yet,
    // inject the original morning message context so LLM knows what "そのタスク" refers to
    if (threadState && conversationHistory.length === 0) {
      const taskList = threadState.tasks
        .map((t) => `- ${t.name}（ステータス: ${t.status ?? "不明"}、SP: ${t.sp ?? "不明"}）`)
        .join("\n");
      const syntheticAssistantMsg =
        `${threadState.assigneeName}さんへの進捗確認メッセージ:\n担当タスク:\n${taskList}`;
      conversationHistory = [
        { role: "assistant" as const, content: syntheticAssistantMsg }
      ];
    }

    // Process pending actions from parallel fetch result
    let pendingCreateTasks: Array<{ task_name: string; assignee: string; due: string; sp: number; status: string; project: string | null; description: string | null; sprint: string | null }> | null = null;
    let pendingUpdateActions: Array<{ action: string; page_id: string; task_name: string; new_value: string }> | null = null;
    const pendingCreateRef = pendingCreateRefResult;
    if (pendingCreateRef) {
      const oldPending = await getPendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
      if (oldPending) {
        const createActions = oldPending.actions.filter((a) => a.action === "create_task");
        if (createActions.length > 0) {
          pendingCreateTasks = createActions.map((a) => {
            const parsed = JSON.parse(a.new_value) as { task_name: string; assignee: string; due: string; sp: number; status: string; project?: string | null; description?: string | null; sprintId?: string; sprintName?: string | null };
            return {
              task_name: parsed.task_name,
              assignee: parsed.assignee,
              due: parsed.due,
              sp: parsed.sp,
              status: parsed.status,
              project: parsed.project ?? null,
              description: parsed.description ?? null,
              sprint: parsed.sprintName ?? null
            };
          });
        } else {
          // Pending update actions
          pendingUpdateActions = oldPending.actions;
        }
      } else {
        // Pending action no longer exists — clean up stale ref
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
      }
    }

    // Trim context data to keep LLM prompt within reasonable size
    // Thread context: limit each message to 500 chars, max 20 messages (keep first few + last few for TODO context)
    const trimmedThreadContext = threadContext
      ?.map((m) => ({ ...m, text: m.text.slice(0, 500) }))
      .slice(0, 20);
    // Channel context: limit each message to 300 chars, max 20 messages
    const trimmedChannelContext = channelContext
      ?.map((m) => ({ ...m, text: m.text.slice(0, 300) }))
      .slice(0, 20);
    // Reference items: limit content to 500 chars per section, max 10 sections
    const trimmedReferenceItems = referenceItems
      ?.map((r) => ({ ...r, content: r.content.slice(0, 500) }))
      .slice(0, 10);

    const result = await interpretMention(config, userText, summary, mentionContext, requestUserName, conversationHistory, pendingCreateTasks, pendingUpdateActions, trimmedThreadContext, trimmedChannelContext, trimmedReferenceItems);

    if (result.intent === "create_task" && result.new_tasks.length > 0) {
      // If modifying a pending create, clean up old pending action first
      if (pendingCreateRef) {
        await deletePendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
        console.log(`Cleaned up old pending create: confirmMsgTs=${pendingCreateRef.confirmMsgTs}`);
      }

      // Resolve projects and generate descriptions for each task, then build message in code
      const taskActions: Array<{ action: "create_task"; page_id: string; task_name: string; new_value: string }> = [];
      let needsDescriptionHearing = false;
      const taskBlocks: string[] = [];

      for (let i = 0; i < result.new_tasks.length; i++) {
        const newTask = result.new_tasks[i];
        // Resolve project before sending confirmation
        let resolvedProjectIds = summary.projectIds ?? [];
        let projectDisplay: string | null = null;

        if (newTask.project) {
          const candidates = await searchProjectsByName(config.notionToken, newTask.project);

          if (candidates.length === 0) {
            projectDisplay = `${newTask.project}（⚠️ 未検出、既存プロジェクトを使用）`;
          } else if (candidates.length === 1) {
            resolvedProjectIds = [candidates[0].id];
            projectDisplay = candidates[0].name;
          } else {
            resolvedProjectIds = [candidates[0].id];
            projectDisplay = candidates[0].name;
          }
        }

        // Generate or carry over task description
        let taskDescription: string | null = null;
        if (pendingCreateTasks) {
          taskDescription = newTask.description ?? null;
        } else if (newTask.description) {
          taskDescription = newTask.description;
        } else if (result.new_tasks.length === 1) {
          try {
            const channelMsgs = await fetchChannelContext(config.slackBotToken, channel);
            if (channelMsgs.length > 0) {
              taskDescription = await generateTaskDescription(config, newTask.task_name, channelMsgs);
            }
          } catch (err) {
            console.warn(`Description generation failed: ${(err as Error).message}`);
          }
        }

        // Track if single-task creation needs description hearing
        if (!taskDescription && !pendingCreateTasks && result.new_tasks.length === 1) {
          needsDescriptionHearing = true;
        }

        // Resolve sprint from LLM output (null = backlog)
        let resolvedSprintId: string | undefined;
        let sprintDisplay: string | null = null;
        if (newTask.sprint) {
          const matchedSprint = allSprints.find(
            (s) => s.name === newTask.sprint || s.name.includes(newTask.sprint!) || newTask.sprint!.includes(s.name)
          );
          if (matchedSprint) {
            resolvedSprintId = matchedSprint.id;
            sprintDisplay = matchedSprint.name;
          } else {
            sprintDisplay = `${newTask.sprint}（⚠️ 未検出）`;
          }
        }
        // sprint が null → バックログ（sprintId なし）

        // Build task display block with description inline
        const label = result.new_tasks.length > 1 ? `【タスク${i + 1}】\n` : "";
        const lines = [
          `${label}・タスク名: *${newTask.task_name}*`,
          `・担当: ${newTask.assignee}`,
          `・期限: ${newTask.due}`,
          `・SP: ${newTask.sp}`
        ];
        if (projectDisplay) lines.push(`・プロジェクト: *${projectDisplay}*`);
        lines.push(`・スプリント: ${sprintDisplay ?? "バックログ"}`);
        if (taskDescription) lines.push(`・📝 概要: ${taskDescription}`);
        taskBlocks.push(lines.join("\n"));

        taskActions.push({
          action: "create_task",
          page_id: "",
          task_name: newTask.task_name,
          new_value: JSON.stringify({
            ...newTask,
            ...(resolvedSprintId ? { sprintId: resolvedSprintId } : {}),
            sprintName: newTask.sprint,
            projectIds: resolvedProjectIds,
            ...(taskDescription ? { description: taskDescription } : {})
          })
        });
      }

      const responseText = `以下のタスクを追加します。問題なければ ✅ をリアクションしてください:\n\n${taskBlocks.join("\n\n")}`;

      if (needsDescriptionHearing) {
        // Single task with no description — ask user for description
        const askMsg = await chatPostMessage(
          config.slackBotToken,
          channel,
          `${userMention}${responseText}\n\nこのタスクの概要を教えてください！背景や目的など、関連する情報があれば共有してください 📝\n（「概要なし」と返信すればスキップできます）`,
          undefined,
          threadTs
        );

        await savePendingAction(env.NOTIFY_CACHE, askMsg.channel, askMsg.ts, {
          actions: taskActions,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          threadTs
        });

        await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
          confirmMsgTs: askMsg.ts
        });

        console.log(`Asking for task description: "${result.new_tasks[0].task_name}", ts=${askMsg.ts}`);
      } else {
        // Has description or multiple tasks — send confirmation with buttons
        const confirmMsg = await chatPostMessage(
          config.slackBotToken,
          channel,
          `${userMention}${responseText}`,
          buildApprovalButtons("task_action"),
          threadTs
        );

        await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
          actions: taskActions,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          threadTs
        });

        await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
          confirmMsgTs: confirmMsg.ts
        });

        console.log(`Pending task creation saved: ${result.new_tasks.length} tasks, ts=${confirmMsg.ts}`);
      }
    } else if (result.intent === "create_task" && result.new_tasks.length === 0) {
      // Missing required fields — ask PM for more info
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${result.response_text}`,
        undefined,
        threadTs
      );
    } else if (result.intent === "update" && result.actions.length > 0) {
      // If modifying a pending update, clean up old pending action first
      if (pendingCreateRef && pendingUpdateActions) {
        await deletePendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
        console.log(`Cleaned up old pending update: confirmMsgTs=${pendingCreateRef.confirmMsgTs}`);
      }

      // Send confirmation message with buttons and save pending action
      const confirmMsg = await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${result.response_text}`,
        buildApprovalButtons("task_action"),
        threadTs
      );

      await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
        actions: result.actions,
        requestedBy: userId,
        requestedAt: new Date().toISOString(),
        threadTs
      });

      // Save thread-level reference so modifications can find this pending action
      await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
        confirmMsgTs: confirmMsg.ts
      });

      console.log(`Pending action saved: ${result.actions.length} actions, ts=${confirmMsg.ts}`);
    } else {
      // Query or unknown — just reply
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${result.response_text}`,
        undefined,
        threadTs
      );
    }

    // Save conversation history for follow-up questions
    await appendMentionHistory(
      env.NOTIFY_CACHE,
      channel,
      threadTs,
      userText,
      result.response_text
    );
  } catch (err) {
    console.error("handleMention failed", (err as Error).message);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}エラーが発生しました: ${(err as Error).message}`,
      undefined,
      threadTs
    );
  }
}

// ── Handle ☎️ phone reaction → send thread content as DM ────────────────

const PHONE_REACTIONS = ["phone", "telephone_receiver"];

async function handlePhoneReaction(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const userId = event.user as string;
  const item = event.item as Record<string, unknown>;
  const channel = item.channel as string;
  const messageTs = item.ts as string;

  console.log(`handlePhoneReaction: user=${userId}, channel=${channel}, messageTs=${messageTs}`);

  // Fetch only the reacted message (not the full thread)
  let messages: Awaited<ReturnType<typeof conversationsReplies>> = [];
  try {
    messages = await conversationsReplies(
      config.slackBotToken,
      channel,
      messageTs,
      1,
      true
    );
    // Only keep the reacted message itself, not thread replies
    if (messages.length > 1) messages = [messages[0]];
  } catch {
    // thread_not_found — likely a thread reply; content will be link-only
    console.log(`handlePhoneReaction: conversationsReplies failed for ${messageTs}, using link-only`);
  }

  // Build permalink
  const threadLink = `https://slack.com/archives/${channel}/p${messageTs.replace(".", "")}`;

  let dmText: string;
  if (messages.length > 0) {
    const msgContent = `<@${messages[0].user}>: ${messages[0].text}`;
    dmText =
      `☎️ *リマインド設定されたメッセージ*\n` +
      `<${threadLink}|メッセージを見る>\n\n` +
      `───────────────\n` +
      `${msgContent}\n` +
      `───────────────\n` +
      `_1時間ごとにリマインドします。このメッセージにスタンプを付けると停止します。_`;
  } else {
    dmText =
      `☎️ *リマインド設定されたメッセージ*\n` +
      `<${threadLink}|メッセージを見る>\n\n` +
      `_1時間ごとにリマインドします。このメッセージにスタンプを付けると停止します。_`;
  }

  // Open DM channel with user
  const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
  if (!dmChannelId) {
    console.error(`Failed to open DM channel for user ${userId}`);
    return;
  }

  // Send initial DM
  const dmResult = await chatPostMessage(config.slackBotToken, dmChannelId, dmText);

  // Save reminder to KV
  const now = new Date().toISOString();
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, messageTs, {
    userId,
    channel,
    threadTs: messageTs,
    createdAt: now,
    lastRemindedAt: now
  });

  // Save DM→reminder mapping so reacting to the DM can stop the reminder
  await savePhoneReminderDm(env.NOTIFY_CACHE, dmChannelId, dmResult.ts, {
    userId, channel, threadTs: messageTs
  });

  console.log(`Phone reminder saved: user=${userId}, channel=${channel}, threadTs=${messageTs}`);
}

// ── Handle reaction_removed (cancel ☎️ reminder) ────────────────────────

async function handleReactionRemoved(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const reaction = event.reaction as string;
  if (!PHONE_REACTIONS.includes(reaction)) return;

  const userId = event.user as string;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = item.channel as string;
  const messageTs = item.ts as string;

  await deletePhoneReminder(env.NOTIFY_CACHE, userId, channel, messageTs);
  console.log(`Phone reminder removed: user=${userId}, channel=${channel}, threadTs=${messageTs}`);

  // Notify user that reminder was cancelled
  const config = getConfig(env);
  if (config.slackBotToken) {
    const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
    if (dmChannelId) {
      await chatPostMessage(
        config.slackBotToken,
        dmChannelId,
        "☎️ リマインドを解除しました。"
      );
    }
  }
}

// ── Handle ✅ reaction (reaction_added event) ──────────────────────────────

async function handleReactionAdded(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const reaction = event.reaction as string;

  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = item.channel as string;
  const messageTs = item.ts as string;

  console.log(`handleReactionAdded: reaction=${reaction}, channel=${channel}, messageTs=${messageTs}`);

  // ── ☎️ phone reaction → thread reminder DM ─────────────────────────────
  if (PHONE_REACTIONS.includes(reaction)) {
    await handlePhoneReaction(env, event);
    return;
  }

  // ── Any reaction on a phone reminder DM → stop the reminder ───────────
  const dmRef = await getPhoneReminderDm(env.NOTIFY_CACHE, channel, messageTs);
  if (dmRef) {
    await deletePhoneReminder(env.NOTIFY_CACHE, dmRef.userId, dmRef.channel, dmRef.threadTs);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      "✅ リマインドを停止しました。"
    );
    console.log(`Phone reminder stopped via DM reaction: user=${dmRef.userId}, thread=${dmRef.threadTs}`);
    return;
  }

  // Only handle ✅ (white_check_mark) below
  if (reaction !== "white_check_mark") return;

  // Check if there's a pending Notion action for this message
  const pending = await getPendingAction(env.NOTIFY_CACHE, channel, messageTs);
  console.log(`Pending action lookup: ${pending ? `found ${pending.actions.length} actions` : "NOT FOUND"}`);
  if (!pending) {
    // Also check if this is a PM thread confirmation (Step 8)
    const today = toJstDateString();
    const pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    if (
      pmThread &&
      pmThread.state === "pending" &&
      pmThread.channel === channel &&
      pmThread.ts === messageTs
    ) {
      // PM reacted ✅ to the daily report — interpret as full approval
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

      await chatPostMessage(
        config.slackBotToken,
        channel,
        summaryMsg,
        undefined,
        messageTs
      );

      // Step 9: Channel-wide completion notification
      const pmoChannel = config.slackPmoChannelId;
      if (pmoChannel) {
        await sendCompletionNotification(
          config.slackBotToken,
          pmoChannel,
          results,
          config.dryRun
        );
      }
    }
    return;
  }

  // Check if this contains task creation actions
  const createActions = pending.actions.filter((a) => a.action === "create_task");
  if (createActions.length > 0) {
    // Pre-fetch user maps once (avoids repeated API calls per task)
    const dbUserMap = config.taskDbId
      ? await buildUserMapFromDatabase(config.notionToken, config.taskDbId)
      : new Map<string, string>();
    const notionUserMap = await fetchNotionUserMap(config.notionToken);
    const userMaps = { dbUserMap, notionUserMap };

    // Create all tasks in parallel
    const taskResults = await Promise.all(
      createActions.map(async (createAction) => {
        const newTask = JSON.parse(createAction.new_value) as NewTask & { sprintId?: string; projectIds?: string[]; project?: string | null; description?: string };
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

        // Append description as page content if available
        if (result.pageId && newTask.description) {
          try {
            await appendPageContent(config.notionToken, result.pageId, newTask.description);
            console.log(`Description appended to page ${result.pageId}`);
          } catch (err) {
            console.warn(`Failed to append description: ${(err as Error).message}`);
          }
        }

        console.log(`Task creation executed: "${newTask.task_name}"`);
        return { result, newTask };
      })
    );

    const allResults = taskResults.map((r) => r.result.message);
    const notificationLines = taskResults.map(
      (r) => `・タスク追加: ${r.newTask.task_name}（担当: ${r.newTask.assignee}、期限: ${r.newTask.due}、SP: ${r.newTask.sp}）`
    );

    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    // Clean up thread-level reference to prevent stale lookups
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }

    await chatPostMessage(
      config.slackBotToken,
      channel,
      allResults.join("\n\n"),
      undefined,
      messageTs
    );

    // Step 9: Channel-wide completion notification
    const pmoChannelForCreate = config.slackPmoChannelId;
    if (pmoChannelForCreate && !config.dryRun) {
      await sendCompletionNotification(
        config.slackBotToken,
        pmoChannelForCreate,
        notificationLines,
        false
      );
    }

    return;
  }

  // Execute the pending Notion update actions
  const results = await executeNotionActions(
    config.notionToken,
    pending.actions,
    config.dryRun
  );

  await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
  // Clean up thread-level reference to prevent stale lookups
  if (pending.threadTs) {
    await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
  }

  const summaryMsg =
    results.length > 0
      ? `✅ Notion更新完了\n\n更新内容:\n${results.join("\n")}`
      : "✅ 更新する内容がありませんでした。";

  await chatPostMessage(
    config.slackBotToken,
    channel,
    summaryMsg,
    undefined,
    messageTs
  );

  // Step 9: Channel-wide completion notification
  const pmoChannelForUpdate = config.slackPmoChannelId;
  if (pmoChannelForUpdate) {
    await sendCompletionNotification(
      config.slackBotToken,
      pmoChannelForUpdate,
      results,
      config.dryRun
    );
  }

  console.log(`Executed ${pending.actions.length} Notion actions from reaction_added`);
}

// ── Handle assignee thread replies (message event in tracked thread) ───────

async function handleAssigneeReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = event.channel as string;
  const threadTs = event.thread_ts as string;
  const text = (event.text as string) ?? "";
  const user = (event.user as string) ?? "";

  const threadState = await getThreadState(env.NOTIFY_CACHE, channel, threadTs);
  if (!threadState) return;

  // Already replied — check for additional progress, otherwise treat as casual chat
  if (threadState.state === "replied") {
    let hasAdditionalProgress = false;
    try {
      hasAdditionalProgress = await evaluateAssigneeReply(
        config,
        text,
        threadState.assigneeName,
        threadState.tasks
      );
    } catch (err) {
      console.error("evaluateAssigneeReply failed (post-reply)", (err as Error).message);
    }

    if (hasAdditionalProgress) {
      await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
        text,
        userId: user,
        receivedAt: new Date().toISOString()
      });
      await chatPostMessage(config.slackBotToken, channel, "追加情報ありがとうございます！反映しますね :+1:", undefined, threadTs);
      console.log(`Additional progress from ${threadState.assigneeName} in thread ${threadTs}`);
    } else {
      await chatPostMessage(config.slackBotToken, channel, "ありがとうございます！頑張ってくださいね :blush:", undefined, threadTs);
      console.log(`Casual reply from ${threadState.assigneeName} in thread ${threadTs} (already replied)`);
    }
    return;
  }

  // LLM judges if the reply is substantive
  let isValid = false;
  try {
    isValid = await evaluateAssigneeReply(
      config,
      text,
      threadState.assigneeName,
      threadState.tasks
    );
  } catch (err) {
    console.error("evaluateAssigneeReply failed, treating as valid", (err as Error).message);
    isValid = true; // fail-open so replies aren't lost
  }

  if (isValid) {
    // Good reply: save to KV, mark as replied, stop reminders
    await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
      text,
      userId: user,
      receivedAt: new Date().toISOString()
    });
    await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
      ...threadState,
      state: "replied"
    });
    await chatPostMessage(config.slackBotToken, channel, "確認できました！今日も頑張りましょう :muscle:", undefined, threadTs);
    console.log(`Valid reply from ${threadState.assigneeName} in thread ${threadTs}`);
  } else {
    // Insufficient reply: don't save, keep pending so reminders continue
    await chatPostMessage(config.slackBotToken, channel, "もう少し具体的にお願い！", undefined, threadTs);
    console.log(`Insufficient reply from ${threadState.assigneeName} in thread ${threadTs}`);
  }
}

// ── Handle PM DM thread reply (message event → Step 8) ────────────────────

async function handlePmReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  const channel = event.channel as string;
  const threadTs = event.thread_ts as string;
  const text = (event.text as string) ?? "";

  const today = toJstDateString();
  const pmThread = await getPmThread(env.NOTIFY_CACHE, today);

  if (
    !pmThread ||
    pmThread.state !== "pending" ||
    pmThread.channel !== channel ||
    pmThread.ts !== threadTs
  ) {
    return;
  }

  console.log(`PM replied in thread ${threadTs}; processing Step 8`);

  try {
    const proposal = JSON.parse(pmThread.proposalJson) as AllocationProposal;
    const actions = await interpretPmReply(config, proposal, text);

    // Build confirmation message for PM
    const actionLines = actions.actions
      .map((a) => `・${a.task_name}: ${a.action} → ${a.new_value}`)
      .join("\n");
    const confirmText =
      actions.actions.length > 0
        ? `以下の更新を実行します。問題なければ ✅ をリアクションしてください:\n\n${actionLines}`
        : "更新する内容が見当たりませんでした。もう少し具体的に教えてください。";

    const confirmMsg = await chatPostMessage(
      config.slackBotToken,
      channel,
      confirmText,
      actions.actions.length > 0 ? buildApprovalButtons("task_action") : undefined,
      threadTs
    );

    if (actions.actions.length > 0) {
      // Save pending action keyed by the confirmation message ts
      await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
        actions: actions.actions,
        requestedBy: (event.user as string) ?? "",
        requestedAt: new Date().toISOString()
      });
    }

    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" });
  } catch (err) {
    console.error("handlePmReply failed", (err as Error).message);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `❌ エラー: ${(err as Error).message}`,
      undefined,
      threadTs
    );
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleSlackEvents(
  request: Request,
  env: Bindings,
  ctx?: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Parse body first (needed for url_verification)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // URL verification — no signature check needed
  if (payload.type === "url_verification") {
    return new Response(
      JSON.stringify({ challenge: payload.challenge }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Ignore Slack retries (X-Slack-Retry-Num > 0)
  const retryNum = request.headers.get("x-slack-retry-num");
  if (retryNum && parseInt(retryNum, 10) > 0) {
    return new Response("ok");
  }

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

  if (payload.type !== "event_callback") {
    return new Response("ok");
  }

  const event = (payload.event as Record<string, unknown>) ?? {};
  const eventType = event.type as string | undefined;
  const botId = event.bot_id as string | undefined;
  const subtype = event.subtype as string | undefined;

  // Extract bot user ID from Slack authorizations for accurate mention detection
  const authorizations = payload.authorizations as Array<{ user_id: string }> | undefined;
  const botUserId = authorizations?.[0]?.user_id;

  // Helper: run async work in background via ctx.waitUntil, or fall back to await
  const bg = (work: Promise<void>) => {
    if (ctx) {
      ctx.waitUntil(work.catch((err) => console.error("bg task failed:", err)));
    } else {
      // No ctx (e.g. tests) — await inline
      return work;
    }
    return Promise.resolve();
  };

  // ── reaction_added ──────────────────────────────────────────────────────
  if (eventType === "reaction_added") {
    await bg(handleReactionAdded(env, event));
    return new Response("ok");
  }

  // ── reaction_removed (cancel ☎️ reminder) ──────────────────────────────
  if (eventType === "reaction_removed") {
    await bg(handleReactionRemoved(env, event));
    return new Response("ok");
  }

  // ── app_mention ─────────────────────────────────────────────────────────
  if (eventType === "app_mention" && !botId) {
    await bg(handleMention(env, event));
    return new Response("ok");
  }

  // ── message (thread replies only, not from bots) ────────────────────────
  if (eventType === "message" && !botId && !subtype) {
    const threadTs = event.thread_ts as string | undefined;
    const channel = event.channel as string | undefined;

    if (channel && threadTs) {
      const rawText = (event.text as string) ?? "";
      // Check if the bot itself is mentioned (not just any @mention)
      const isBotMentioned = botUserId
        ? rawText.includes(`<@${botUserId}>`)
        : /<@[A-Z0-9]+>/.test(rawText); // fallback if authorizations unavailable

      if (!isBotMentioned) {
        await bg((async () => {
          const handled = await handleProjectSelectionReply(env, event);
          if (!handled) {
            const createRef = await getPendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
            if (createRef) {
              // Pending action exists — route to handleMention for modification
              // (even if the text mentions other users like @assignee)
              await handleMention(env, event);
            } else {
              await handleAssigneeReply(env, event);
              await handlePmReply(env, event);
            }
          }
        })());
      }
      // isBotMentioned === true → app_mention handler will process this
    }
  }

  return new Response("ok");
}
