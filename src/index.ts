import { getConfig, type Bindings, type AppConfig } from "./config";
import { buildDedupKey, hashPayload, isDuplicateAndRemember } from "./dedupe";
import { fetchSprintSummary, fetchFreeText, fetchSprintTasks } from "./notionMcp";
import {
  buildSlackPayload,
  postSlack,
  buildSprintTasksPayload,
  buildTasksPayload,
  buildAssigneeTasksPayload
} from "./slack";
import {
  validateResponse,
  validateSprintTasks,
  type SprintTasksSummary
} from "./schema";
import {
  fetchTasksInDateRange,
  summarizeTasks,
  fetchCurrentSprintTasksSummary,
  fetchSprintCapacity,
  isCompletedStatus
} from "./notionApi";
import { handleSlackEvents } from "./slackEvents";
import { handleSlackInteractions, buildPmReportButtons, buildEodReminderButtons } from "./slackInteractions";
import { fetchMembers } from "./memberApi";
import {
  analyzeTasksAndMembers,
  generateAssigneeMessages,
  interpretRepliesAndPropose,
  matchTasksToSchedule
} from "./llmAnalyzer";
import { chatPostMessage, conversationsReplies, conversationsOpen } from "./slackBot";
import { fetchScheduleData, analyzeScheduleDeviation } from "./sheetsApi";
import {
  saveThreadState,
  savePmThread,
  getPmThread,
  addActiveThread,
  getActiveThreads,
  getReplies,
  toJstDateString,
  listAllPhoneReminders,
  savePhoneReminder
} from "./workflow";

interface Env extends Bindings {}

// ── CJK-aware fixed-width table helpers ────────────────────────────────────

function isWideChar(code: number): boolean {
  return (
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x11a8 && code <= 0x11ff) ||
    // Enclosed Alphanumerics ①②③ etc.
    (code >= 0x2460 && code <= 0x24ff) ||
    // Box Drawing + Block Elements + Geometric Shapes ■□▲△○● etc.
    (code >= 0x2500 && code <= 0x25ff) ||
    // Miscellaneous Symbols + Dingbats ☆★☏ etc.
    (code >= 0x2600 && code <= 0x27bf) ||
    // Miscellaneous Symbols and Arrows
    (code >= 0x2b00 && code <= 0x2bff) ||
    // CJK Radicals → CJK Unified Ideographs (includes Hiragana, Katakana, Kanji)
    (code >= 0x2e80 && code <= 0x9fff) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Vertical Forms + CJK Compatibility Forms
    (code >= 0xfe10 && code <= 0xfe6f) ||
    // Fullwidth Latin / Halfwidth CJK Forms
    (code >= 0xff01 && code <= 0xff60) ||
    // Fullwidth Signs
    (code >= 0xffe0 && code <= 0xffe6) ||
    // Emoji & Symbols (Misc Symbols and Pictographs, Emoticons, etc.)
    (code >= 0x1f000 && code <= 0x1fbff) ||
    // CJK Extensions B–G
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    width += isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function padEndCjk(str: string, targetWidth: number): string {
  const diff = Math.max(0, targetWidth - getDisplayWidth(str));
  // Use full-width space (U+3000) for padding to match CJK glyph width,
  // preventing cumulative sub-pixel drift between CJK text and ASCII spaces.
  const fwSpaces = Math.floor(diff / 2);
  const hwRemainder = diff % 2;
  return str + "\u3000".repeat(fwSpaces) + " ".repeat(hwRemainder);
}

function formatShortDate(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function formatDeadlineTasksTable(
  summary: SprintTasksSummary,
  today: string,
  daysThreshold: number = 2
): string {
  const todayDate = new Date(today + "T00:00:00Z");

  const groups = new Map<
    string,
    Array<{ name: string; status: string; priority: string; sp: string; due: string }>
  >();

  // Build project abbreviation cache
  const projectAbbrCache = new Map<string, string>();
  const abbreviateProject = (name: string): string => {
    if (projectAbbrCache.has(name)) return projectAbbrCache.get(name)!;
    // Short names (<=3 chars): use as-is
    if (name.length <= 3) { projectAbbrCache.set(name, name); return name; }
    // Extract uppercase letters from camelCase/PascalCase
    const uppers = name.match(/[A-Z]/g);
    if (uppers && uppers.length >= 2) { const abbr = uppers.join(""); projectAbbrCache.set(name, abbr); return abbr; }
    // Multi-word: initials
    const words = name.split(/[\s\-_・]+/).filter(Boolean);
    if (words.length >= 2) { const abbr = words.map((w) => w[0].toUpperCase()).join(""); projectAbbrCache.set(name, abbr); return abbr; }
    // Single word: first char uppercase
    const abbr = /^[a-zA-Z]/.test(name) ? name.slice(0, 1).toUpperCase() : name.slice(0, 1);
    projectAbbrCache.set(name, abbr);
    return abbr;
  };

  for (const assignee of summary.assignees) {
    for (const task of assignee.tasks) {
      if (task.status && isCompletedStatus(task.status)) continue;
      if (!task.due) continue;
      const dueDate = new Date(task.due + "T00:00:00Z");
      const daysRemaining = Math.ceil(
        (dueDate.getTime() - todayDate.getTime()) / 86400000
      );
      if (daysRemaining > daysThreshold) continue;
      const group = groups.get(assignee.name) ?? [];
      // Prefix task name with project abbreviation if available
      const projectPrefix = task.projectName
        ? `【${abbreviateProject(task.projectName)}】`
        : "";
      group.push({
        name: projectPrefix + task.name,
        status: task.status ?? "-",
        priority: task.priority ?? "-",
        sp: task.sp != null ? String(task.sp) : "-",
        due: formatShortDate(task.due)
      });
      groups.set(assignee.name, group);
    }
  }

  if (groups.size === 0) {
    return "【残り期限2日のタスク状況】\n```\n該当タスクなし\n```";
  }

  const sections: string[] = ["【残り期限2日のタスク状況】"];
  const headers = ["タスク名", "ステータス", "優先度", "SP", "期限"];

  for (const [assigneeName, tasks] of groups) {
    const colWidths = [
      Math.max(getDisplayWidth(headers[0]), ...tasks.map((t) => getDisplayWidth(t.name))),
      Math.max(getDisplayWidth(headers[1]), ...tasks.map((t) => getDisplayWidth(t.status))),
      Math.max(getDisplayWidth(headers[2]), ...tasks.map((t) => getDisplayWidth(t.priority))),
      Math.max(getDisplayWidth(headers[3]), ...tasks.map((t) => getDisplayWidth(t.sp))),
      Math.max(getDisplayWidth(headers[4]), ...tasks.map((t) => getDisplayWidth(t.due)))
    ];

    const lines: string[] = [];
    lines.push(`*${assigneeName}*`);
    lines.push("```");
    lines.push(
      headers.map((h, i) => padEndCjk(h, colWidths[i])).join("  ")
    );
    lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));
    for (const task of tasks) {
      lines.push(
        padEndCjk(task.name, colWidths[0]) + "  " +
        padEndCjk(task.status, colWidths[1]) + "  " +
        padEndCjk(task.priority, colWidths[2]) + "  " +
        padEndCjk(task.sp, colWidths[3]) + "  " +
        task.due
      );
    }
    lines.push("```");
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

type SprintTasksMeta = {
  metrics: {
    planSp: number | null;
    progressSp: number | null;
    remainingSp: number | null;
    requiredSpPerDay: number | null;
  };
  changes: {
    totalProgressSp: number;
    items: string[];
  };
};

async function buildSprintTasksMeta(
  env: Env,
  summary: SprintTasksSummary,
  config: AppConfig,
  now: Date
): Promise<SprintTasksMeta> {
  const todayKey = toJstDateString(now);
  const dateLabel = todayKey.slice(5).replace("-", "/"); // "MM/DD"
  const yesterdayKey = toJstDateString(now, -1);
  const snapshotKey = `sprint-task-snapshot:${summary.sprint.id}:${todayKey}`;
  const previousKey = `sprint-task-snapshot:${summary.sprint.id}:${yesterdayKey}`;
  const currentSnapshot = summary.assignees.flatMap((assignee) =>
    assignee.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status ?? null,
      sp: task.sp ?? null
    }))
  );
  const previousSnapshot =
    ((await env.NOTIFY_CACHE.get(previousKey, "json")) as
      | typeof currentSnapshot
      | null) ?? [];
  const previousById = new Map(
    previousSnapshot.map((task) => [task.id, task])
  );
  const changeItems: string[] = [];
  let totalProgressSp = 0;

  for (const task of currentSnapshot) {
    const prev = previousById.get(task.id);
    if (!prev) continue;
    if (prev.status === task.status) continue;
    const before = prev.status ?? "-";
    const after = task.status ?? "-";
    changeItems.push(`• ${dateLabel} ${task.name} ${before} → ${after}`);
    if (typeof task.sp === "number") {
      totalProgressSp += task.sp;
    }
  }

  await env.NOTIFY_CACHE.put(snapshotKey, JSON.stringify(currentSnapshot), {
    expirationTtl: config.dedupeTtlSeconds
  });

  const planSp =
    typeof summary.sprint_metrics?.plan_sp === "number"
      ? summary.sprint_metrics.plan_sp
      : null;
  const progressSp =
    typeof summary.sprint_metrics?.progress_sp === "number"
      ? summary.sprint_metrics.progress_sp
      : null;
  const remainingSp =
    planSp != null && progressSp != null ? planSp - progressSp : null;
  const endDate = new Date(`${summary.sprint.end_date}T00:00:00Z`);
  const startDate = new Date(`${summary.sprint.start_date}T00:00:00Z`);
  const totalDays =
    Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const elapsedDays =
    Math.ceil((now.getTime() - startDate.getTime()) / 86400000) + 1;
  const remainingDays = totalDays > 0 ? Math.max(totalDays - elapsedDays, 1) : 1;
  const requiredSpPerDay =
    typeof summary.sprint_metrics?.required_sp_per_day === "number"
      ? summary.sprint_metrics.required_sp_per_day
      : remainingSp != null
      ? Math.round((remainingSp / remainingDays) * 100) / 100
      : null;

  return {
    metrics: {
      planSp,
      progressSp,
      remainingSp,
      requiredSpPerDay
    },
    changes: {
      totalProgressSp,
      items: changeItems
    }
  };
}

async function runReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const raw = await fetchSprintSummary(config, now);
    const summary = validateResponse(raw);
    const dedupKey = buildDedupKey(summary);
    const hash = await hashPayload(summary);
    const isDup = await isDuplicateAndRemember(
      env,
      dedupKey,
      hash,
      config.dedupeTtlSeconds
    );

    if (isDup) {
      console.log("Duplicate notification skipped", { dedupKey, reason });
      return { ok: true, skipped: true, dedupKey };
    }

    const slackPayload = buildSlackPayload(summary);

    if (config.dryRun) {
      console.log("DRY_RUN: payload not sent", slackPayload);
      return { ok: true, dryRun: true, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Slack notification sent", { dedupKey, reason });
    return { ok: true, dedupKey };
  } catch (error) {
    const err = error as Error;
    console.error("runReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

async function runSprintTasksReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const raw = await fetchSprintTasks(config, now);
    const summary = validateSprintTasks(raw);
    const { metrics, changes } = await buildSprintTasksMeta(
      env,
      summary,
      config,
      now
    );

    const dedupKey = `sprint-tasks:${summary.sprint.id}`;
    const hash = await hashPayload(summary);
    const isDup = await isDuplicateAndRemember(
      env,
      dedupKey,
      hash,
      config.dedupeTtlSeconds
    );

    if (isDup) {
      console.log("Duplicate sprint tasks notification skipped", {
        dedupKey,
        reason
      });
      return { ok: true, skipped: true, dedupKey };
    }

    const slackPayload = buildSprintTasksPayload(
      summary,
      metrics,
      changes
    );

    if (config.dryRun) {
      console.log("DRY_RUN: sprint tasks payload not sent", slackPayload);
      return { ok: true, dryRun: true, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Sprint tasks notification sent", { dedupKey, reason });
    return { ok: true, dedupKey };
  } catch (error) {
    const err = error as Error;
    console.error("runSprintTasksReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

async function runAssigneeTasksReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const { metrics, changes } = await buildSprintTasksMeta(
      env,
      summary,
      config,
      now
    );
    const slackPayload = buildAssigneeTasksPayload(summary, {
      metrics,
      changes
    });
    const count = summary.assignees.reduce(
      (total, assignee) => total + assignee.tasks.length,
      0
    );

    if (config.dryRun) {
      console.log("DRY_RUN: assignee tasks payload not sent", {
        reason,
        count
      });
      return { ok: true, dryRun: true, count, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Assignee tasks notification sent", { reason, count });
    return { ok: true, count };
  } catch (error) {
    const err = error as Error;
    console.error("runAssigneeTasksReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

// ── SP consumption rate calculation ────────────────────────────────────────

interface TaskSnapshot {
  id: string;
  name: string;
  status: string | null;
  sp: number | null;
}

/**
 * Calculate average daily SP consumption over the past 7 days from KV snapshots.
 * Returns the average, or null if insufficient data.
 */
export async function calculateAvgDailySpConsumption(
  kv: KVNamespace,
  sprintId: string,
  today: string
): Promise<{ avgDailySp: number; daysWithData: number } | null> {
  const todayDate = new Date(today + "T00:00:00Z");
  let totalCompletedSp = 0;
  let daysWithData = 0;

  for (let i = 1; i <= 7; i++) {
    const d = new Date(todayDate);
    d.setUTCDate(d.getUTCDate() - i);
    const dateKey = d.toISOString().slice(0, 10);

    const prevD = new Date(d);
    prevD.setUTCDate(prevD.getUTCDate() - 1);
    const prevDateKey = prevD.toISOString().slice(0, 10);

    const currentRaw = await kv.get(`sprint-task-snapshot:${sprintId}:${dateKey}`, "json") as TaskSnapshot[] | null;
    const prevRaw = await kv.get(`sprint-task-snapshot:${sprintId}:${prevDateKey}`, "json") as TaskSnapshot[] | null;

    if (!currentRaw || !prevRaw) continue;

    const prevById = new Map(prevRaw.map((t) => [t.id, t]));
    let dailySp = 0;

    for (const task of currentRaw) {
      const prev = prevById.get(task.id);
      if (!prev) continue;
      if (isCompletedStatus(task.status) && !isCompletedStatus(prev.status)) {
        dailySp += task.sp ?? 0;
      }
    }

    totalCompletedSp += dailySp;
    daysWithData++;
  }

  if (daysWithData === 0) return null;
  return {
    avgDailySp: totalCompletedSp / daysWithData,
    daysWithData
  };
}

/**
 * Fallback: calculate average daily SP from sprint data + current tasks.
 *
 * 1. plan_sp があれば: progress_sp = plan_sp - remaining_sp → avgDaily = progress_sp / elapsed_days
 * 2. plan_sp がなくても: remaining_sp / remaining_days で「必要ペース」を返す（判定基準として使える）
 */
export function calcAvgDailySpFromSprint(
  summary: SprintTasksSummary,
  today: string
): number | null {
  const startDate = new Date(summary.sprint.start_date + "T00:00:00Z");
  const endDate = new Date(summary.sprint.end_date + "T00:00:00Z");
  const todayDate = new Date(today + "T00:00:00Z");

  const elapsedMs = todayDate.getTime() - startDate.getTime();
  const elapsedDays = Math.max(Math.ceil(elapsedMs / 86400000), 1);

  // Sum remaining SP from current (non-completed) tasks
  const remainingSp = summary.assignees.reduce(
    (sum, a) => sum + a.tasks.reduce((s, t) => s + (t.sp ?? 0), 0),
    0
  );

  // Try sprint-level progress_sp first
  let progressSp = summary.sprint_metrics?.progress_sp;

  // If not available, derive from plan_sp - remaining_sp
  if (typeof progressSp !== "number" && typeof summary.sprint_metrics?.plan_sp === "number") {
    progressSp = summary.sprint_metrics.plan_sp - remainingSp;
  }

  // If we have progress data, calculate actual daily pace
  if (typeof progressSp === "number" && progressSp > 0) {
    return Math.round((progressSp / elapsedDays) * 100) / 100;
  }

  // Last resort: use remaining SP / remaining days as baseline pace
  const remainingMs = endDate.getTime() - todayDate.getTime();
  const remainingDays = Math.max(Math.ceil(remainingMs / 86400000), 1);
  if (remainingSp > 0) {
    return Math.round((remainingSp / remainingDays) * 100) / 100;
  }

  return null;
}



/**
 * Detect Doing tasks that have had no status change for 2+ days (Step 2-A).
 * Returns a list of stagnant task IDs and names.
 */
export async function detectStagnantDoingTasks(
  kv: KVNamespace,
  sprintId: string,
  today: string,
  currentTasks: TaskSnapshot[]
): Promise<Array<{ id: string; name: string; staleDays: number }>> {
  const stagnant: Array<{ id: string; name: string; staleDays: number }> = [];
  const DOING_STATUSES = ["doing", "進行中", "in progress", "実行中"];

  // Current Doing tasks
  const doingTasks = currentTasks.filter((t) =>
    t.status && DOING_STATUSES.some((s) => t.status!.toLowerCase().includes(s))
  );

  if (doingTasks.length === 0) return [];

  // Check 2 days ago snapshot
  const twoDaysAgo = new Date(today + "T00:00:00Z");
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  const twoDaysAgoKey = twoDaysAgo.toISOString().slice(0, 10);

  const oldSnapshot = await kv.get(
    `sprint-task-snapshot:${sprintId}:${twoDaysAgoKey}`,
    "json"
  ) as TaskSnapshot[] | null;

  if (!oldSnapshot) return [];

  const oldById = new Map(oldSnapshot.map((t) => [t.id, t]));

  for (const task of doingTasks) {
    const old = oldById.get(task.id);
    if (!old) continue;
    // Same status for 2+ days
    if (old.status === task.status) {
      stagnant.push({ id: task.id, name: task.name, staleDays: 2 });
    }
  }

  return stagnant;
}

/**
 * Compare current task snapshot with 7-day-old KV snapshot.
 * Returns completed tasks and newly added tasks during the period.
 */
export async function calculateWeeklyDiff(
  kv: KVNamespace,
  sprintId: string,
  today: string,
  currentTasks: TaskSnapshot[]
): Promise<{
  periodStart: string;
  periodEnd: string;
  completedTasks: Array<{ id: string; name: string; sp: number | null }>;
  totalCompletedSp: number;
  newTasks: Array<{ id: string; name: string; sp: number | null }>;
  totalNewSp: number;
} | null> {
  const todayDate = new Date(today + "T00:00:00Z");
  const weekAgo = new Date(todayDate);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);

  const oldSnapshot = await kv.get(
    `sprint-task-snapshot:${sprintId}:${weekAgoKey}`,
    "json"
  ) as TaskSnapshot[] | null;

  if (!oldSnapshot) return null;

  const oldById = new Map(oldSnapshot.map((t) => [t.id, t]));
  const currentById = new Map(currentTasks.map((t) => [t.id, t]));

  // Tasks that were not completed in old snapshot but are now completed (or removed from current = completed)
  const completedTasks: Array<{ id: string; name: string; sp: number | null }> = [];
  for (const old of oldSnapshot) {
    if (isCompletedStatus(old.status)) continue; // already completed back then
    const current = currentById.get(old.id);
    // Task removed from current sprint (completed) or status changed to completed
    if (!current || isCompletedStatus(current.status)) {
      completedTasks.push({ id: old.id, name: old.name, sp: old.sp });
    }
  }

  // Tasks in current snapshot that didn't exist in old snapshot = newly added
  const newTasks: Array<{ id: string; name: string; sp: number | null }> = [];
  for (const task of currentTasks) {
    if (!oldById.has(task.id)) {
      newTasks.push({ id: task.id, name: task.name, sp: task.sp });
    }
  }

  const totalCompletedSp = completedTasks.reduce((sum, t) => sum + (t.sp ?? 0), 0);
  const totalNewSp = newTasks.reduce((sum, t) => sum + (t.sp ?? 0), 0);

  return {
    periodStart: weekAgoKey,
    periodEnd: today,
    completedTasks,
    totalCompletedSp,
    newTasks,
    totalNewSp
  };
}

// ── PMO AI Agent flows ─────────────────────────────────────────────────────

/** Member notification flow: Steps 1-4 (20:00 JST = 11:00 UTC, night before) */
async function runMorningFlow(
  env: Env,
  reason: string,
  targetName?: string | null
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping morning flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const now = new Date();
    const today = toJstDateString(now);
    const yesterdayKey = toJstDateString(now, -1);

    // Step 1: Fetch tasks and members
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const members = await fetchMembers(config);

    // Save current task snapshot for change detection
    const currentSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );
    await env.NOTIFY_CACHE.put(
      `task-snapshot:${today}`,
      JSON.stringify(currentSnapshot),
      { expirationTtl: config.dedupeTtlSeconds }
    );

    const previousSnapshot =
      ((await env.NOTIFY_CACHE.get(
        `task-snapshot:${yesterdayKey}`,
        "json"
      )) as typeof currentSnapshot | null) ?? [];

    // Google Sheets schedule data (best-effort: skip on error)
    let scheduleData: Awaited<ReturnType<typeof fetchScheduleData>> | null = null;
    try {
      scheduleData = await fetchScheduleData(config);
      if (scheduleData.rows.length > 0) {
        const deviation = analyzeScheduleDeviation(scheduleData, today);
        console.log("Schedule analysis:", deviation.summary);
      }
    } catch (err) {
      console.warn("Google Sheets fetch skipped:", (err as Error).message);
    }

    // Calculate average daily SP consumption for 🟢🟡🔴 judgment
    // Priority: 7-day KV history > sprint-level calculation
    const spConsumption = await calculateAvgDailySpConsumption(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today
    );
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    let avgDailySpSource = spConsumption ? "kv_7day" : null;

    if (avgDailySp == null) {
      avgDailySp = calcAvgDailySpFromSprint(summary, today);
      if (avgDailySp != null) avgDailySpSource = "sprint_progress";
    }
    console.log("SP consumption rate:", { avgDailySp, source: avgDailySpSource });

    // Step 2-A: Detect stagnant Doing tasks (no change for 2+ days)
    const stagnantTasks = await detectStagnantDoingTasks(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today,
      currentSnapshot
    );
    if (stagnantTasks.length > 0) {
      console.log("Stagnant Doing tasks detected:", stagnantTasks);
    }

    // Step 1.5: Match Notion tasks to spreadsheet items (LLM-based)
    let taskScheduleMapping = null;
    if (scheduleData && scheduleData.rows.length > 0) {
      try {
        taskScheduleMapping = await matchTasksToSchedule(config, summary, scheduleData);
        const matched = taskScheduleMapping.mappings.filter((m) => m.confidence !== "none");
        console.log(`Task-schedule mapping: ${matched.length}/${taskScheduleMapping.mappings.length} tasks matched`);
        for (const m of matched) {
          console.log(`  [${m.confidence}] ${m.task_name.slice(0, 40)} → ${m.schedule_category} / ${m.schedule_item}`);
        }
      } catch (err) {
        console.warn("Task-schedule matching skipped:", (err as Error).message);
      }
    }

    // Step 2: LLM analysis (with schedule data + SP consumption + stagnant tasks + mapping)
    const analysis = await analyzeTasksAndMembers(
      config,
      summary,
      members,
      previousSnapshot,
      scheduleData,
      avgDailySp,
      stagnantTasks,
      taskScheduleMapping
    );
    console.log("Morning flow: analysis complete", {
      schedule_status: analysis.schedule_status
    });

    // Step 3: Generate per-assignee messages
    const messages = await generateAssigneeMessages(
      config,
      analysis,
      summary,
      members
    );

    // Step 4: Send messages via Slack Bot Token
    const channel = config.slackPmoChannelId ?? "";
    let sent = 0;

    if (!channel) {
      console.warn("SLACK_PMO_CHANNEL_ID not set; skipping morning flow");
      return { ok: true, skipped: true, reason: "no pmo channel" };
    }

    // Filter by member whitelist, then by target name if specified
    const whitelist = config.memberWhitelist;
    let filteredMessages = whitelist.length > 0
      ? messages.filter((m) =>
          whitelist.some((name) =>
            m.assignee_name.includes(name) || name.includes(m.assignee_name)
          )
        )
      : messages;

    if (targetName) {
      filteredMessages = filteredMessages.filter((m) =>
        m.assignee_name.includes(targetName) || targetName.includes(m.assignee_name)
      );
      console.log(`Morning flow: targeting "${targetName}", ${filteredMessages.length}/${messages.length} messages`);
    }

    if (whitelist.length > 0) {
      console.log(`Morning flow: whitelist active, ${filteredMessages.length}/${messages.length} members`);
    }

    for (const msg of filteredMessages) {
      // Match member by exact name or partial match (e.g. "北川" matches "北川楓")
      const member = members.find(
        (m) => m.name === msg.assignee_name || msg.assignee_name.includes(m.name)
      );
      // Always post to PMO channel; mention the member if we have their Slack user ID
      const mention = member?.slackUserId ? `<@${member.slackUserId}> ` : "";
      const messageText = mention + msg.message_text;

      if (config.dryRun) {
        console.log(`DRY_RUN: would send to ${channel}\n${messageText}`);
        continue;
      }

      const result = await chatPostMessage(
        config.slackBotToken,
        channel,
        messageText
      );

      // Save thread state so Events API can route replies
      const assigneeTasks =
        summary.assignees.find((a) => a.name === msg.assignee_name)?.tasks ?? [];
      await saveThreadState(env.NOTIFY_CACHE, result.channel, result.ts, {
        assigneeName: msg.assignee_name,
        tasks: assigneeTasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status ?? null,
          sp: t.sp ?? null
        })),
        state: "pending",
        date: today,
        channel: result.channel
      });

      await addActiveThread(env.NOTIFY_CACHE, today, {
        channel: result.channel,
        ts: result.ts,
        assigneeName: msg.assignee_name
      });

      sent++;
    }

    console.log("Morning flow complete", { reason, sent });
    return { ok: true, reason, sent, dryRun: config.dryRun };
  } catch (error) {
    const err = error as Error;
    console.error("runMorningFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/** Reminder flow: 09:00 JST = 00:00 UTC */
async function runReminderFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping reminder flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const today = toJstDateString();
    const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today);
    let reminded = 0;

    for (const thread of activeThreads) {
      const replies = await getReplies(
        env.NOTIFY_CACHE,
        thread.channel,
        thread.ts
      );

      if (replies.length === 0) {
        if (config.dryRun) {
          console.log(`DRY_RUN: would remind ${thread.assigneeName}`);
          continue;
        }
        await chatPostMessage(
          config.slackBotToken,
          thread.channel,
          `リマインド: 本日のタスク状況について返信をお願いします。`,
          undefined,
          thread.ts
        );
        reminded++;
      }
    }

    console.log("Reminder flow complete", { reason, reminded });
    return { ok: true, reason, reminded };
  } catch (error) {
    const err = error as Error;
    console.error("runReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/** PM report flow: Steps 6-7 (10:00 JST = 01:00 UTC) */
async function runEveningFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping evening flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const now = new Date();
    const today = toJstDateString(now);

    // Collect replies from all active threads
    const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today);
    const replyMap = new Map<string, Awaited<ReturnType<typeof getReplies>>>();

    for (const thread of activeThreads) {
      const replies = await getReplies(
        env.NOTIFY_CACHE,
        thread.channel,
        thread.ts
      );
      replyMap.set(thread.assigneeName, replies);
    }

    // Refresh task summary and members for context
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const members = await fetchMembers(config);

    const previousSnapshot =
      ((await env.NOTIFY_CACHE.get(
        `task-snapshot:${today}`,
        "json"
      )) as Array<{
        id: string;
        name: string;
        status: string | null;
        sp: number | null;
      }> | null) ?? [];

    // スプリントページのキャパシティDBからメンバー稼働時間を取得
    const capacities = await fetchSprintCapacity(config, summary.sprint.id);
    if (capacities.length > 0) {
      for (const member of members) {
        const cap = capacities.find(
          (c) => c.name === member.name || c.name.includes(member.name) || member.name.includes(c.name)
        );
        if (cap) {
          // 残り稼働時間（今日以降）を使用
          member.availableHours = cap.remainingHours;
        }
      }
      console.log("Capacity data merged into members", {
        count: capacities.length,
        data: capacities.map((c) => `${c.name}: ${c.totalHours}h`)
      });
    }

    // Google Sheets schedule data (best-effort: skip on error)
    let scheduleData: Awaited<ReturnType<typeof fetchScheduleData>> | null = null;
    try {
      scheduleData = await fetchScheduleData(config);
      if (scheduleData.rows.length > 0) {
        const deviation = analyzeScheduleDeviation(scheduleData, today);
        console.log("Schedule analysis:", deviation.summary);
      }
    } catch (err) {
      console.warn("Google Sheets fetch skipped:", (err as Error).message);
    }

    // Calculate average daily SP consumption for 🟢🟡🔴 judgment
    const spConsumption = await calculateAvgDailySpConsumption(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today
    );
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    if (avgDailySp == null) {
      avgDailySp = calcAvgDailySpFromSprint(summary, today);
    }

    // Calculate yesterday's consumed SP from 5AM progress_sp snapshots
    // (前日AM5時→当日AM5時の進捗SPの差)
    const yesterdayKey = toJstDateString(now, -1);
    const todayProgressSpRaw = await env.NOTIFY_CACHE.get(
      `progress-sp-5am:${summary.sprint.id}:${today}`,
      "json"
    ) as { progress_sp: number | null } | null;
    const yesterdayProgressSpRaw = await env.NOTIFY_CACHE.get(
      `progress-sp-5am:${summary.sprint.id}:${yesterdayKey}`,
      "json"
    ) as { progress_sp: number | null } | null;

    let yesterdayCompletedSp = 0;
    if (todayProgressSpRaw?.progress_sp != null && yesterdayProgressSpRaw?.progress_sp != null) {
      yesterdayCompletedSp = todayProgressSpRaw.progress_sp - yesterdayProgressSpRaw.progress_sp;
      console.log(`Yesterday consumed SP (5AM snapshots): ${yesterdayCompletedSp} (${yesterdayProgressSpRaw.progress_sp} → ${todayProgressSpRaw.progress_sp})`);
    } else {
      // Fallback: task status change method
      const yesterdaySnapshotRaw = await env.NOTIFY_CACHE.get(
        `sprint-task-snapshot:${summary.sprint.id}:${yesterdayKey}`,
        "json"
      ) as Array<{ id: string; name: string; status: string | null; sp: number | null }> | null;

      if (yesterdaySnapshotRaw) {
        const prevById = new Map(yesterdaySnapshotRaw.map((t) => [t.id, t]));
        const currentSnapshot = summary.assignees.flatMap((a) =>
          a.tasks.map((t) => ({ id: t.id, status: t.status ?? null, sp: t.sp ?? null }))
        );
        for (const task of currentSnapshot) {
          const prev = prevById.get(task.id);
          if (!prev) continue;
          if (isCompletedStatus(task.status) && !isCompletedStatus(prev.status)) {
            yesterdayCompletedSp += task.sp ?? 0;
          }
        }
        const currentIds = new Set(currentSnapshot.map((t) => t.id));
        for (const prev of yesterdaySnapshotRaw) {
          if (!currentIds.has(prev.id) && !isCompletedStatus(prev.status)) {
            yesterdayCompletedSp += prev.sp ?? 0;
          }
        }
      }
      console.log(`Yesterday completed SP (fallback): ${yesterdayCompletedSp}`);
    }

    // Step 2-A: Detect stagnant Doing tasks
    const eveningSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );
    const stagnantTasks = await detectStagnantDoingTasks(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today,
      eveningSnapshot
    );

    // Match Notion tasks to spreadsheet items (LLM-based)
    let taskScheduleMapping = null;
    if (scheduleData && scheduleData.rows.length > 0) {
      try {
        taskScheduleMapping = await matchTasksToSchedule(config, summary, scheduleData);
        const matched = taskScheduleMapping.mappings.filter((m) => m.confidence !== "none").length;
        console.log(`Task-schedule mapping: ${matched}/${taskScheduleMapping.mappings.length} tasks matched`);
      } catch (err) {
        console.warn("Task-schedule matching skipped:", (err as Error).message);
      }
    }

    // Step 2 (light): re-analyze with today's data (with schedule data + SP consumption + stagnant tasks + mapping)
    const analysis = await analyzeTasksAndMembers(
      config,
      summary,
      members,
      previousSnapshot,
      scheduleData,
      avgDailySp,
      stagnantTasks,
      taskScheduleMapping
    );

    // Step 6: Interpret replies and propose allocations (with schedule data)
    const proposal = await interpretRepliesAndPropose(
      config,
      analysis,
      replyMap,
      activeThreads,
      members,
      scheduleData,
      summary,
      avgDailySp,
      yesterdayCompletedSp
    );
    console.log("Evening flow: proposal generated", {
      allocations: proposal.task_allocations.length
    });

    // Build deadline tasks table programmatically and inject into pm_report
    const deadlineTable = formatDeadlineTasksTable(summary, today);
    let pmReport = proposal.pm_report;
    const memberCapacityIdx = pmReport.indexOf("【メンバー稼働余力】");
    if (memberCapacityIdx >= 0) {
      pmReport =
        pmReport.slice(0, memberCapacityIdx) +
        deadlineTable +
        "\n\n" +
        pmReport.slice(memberCapacityIdx);
    } else {
      pmReport += "\n\n" + deadlineTable;
    }

    // Step 7: Send PM daily report to PMO channel (mention PM)
    const channel = config.slackPmoChannelId ?? "";
    if (!channel) {
      console.warn("SLACK_PMO_CHANNEL_ID not set; skipping PM report");
      return { ok: true, skipped: true, reason: "no pmo channel" };
    }

    const pmMention = config.slackPmUserId ? `<@${config.slackPmUserId}> ` : "";
    const pmReportText = pmMention + pmReport;

    if (config.dryRun) {
      console.log("DRY_RUN: PM report not sent", pmReportText.slice(0, 200));
      return { ok: true, dryRun: true, reason };
    }

    const pmResult = await chatPostMessage(
      config.slackBotToken,
      channel,
      pmReportText,
      buildPmReportButtons()
    );

    // Save PM thread so Events API can route PM's reply (Step 8)
    await savePmThread(env.NOTIFY_CACHE, today, {
      channel: pmResult.channel,
      ts: pmResult.ts,
      proposalJson: JSON.stringify(proposal),
      state: "pending"
    });

    console.log("Evening flow complete", { reason, pmThreadTs: pmResult.ts });
    return { ok: true, reason, pmThreadTs: pmResult.ts };
  } catch (error) {
    const err = error as Error;
    console.error("runEveningFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/** PM reminder: hourly 11:00-19:00 JST = 02:00-10:00 UTC */
async function runPmReminderFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);

    if (!config.slackBotToken) {
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const today = toJstDateString();
    const pmThread = await getPmThread(env.NOTIFY_CACHE, today);

    if (!pmThread || pmThread.state !== "pending") {
      console.log("PM reminder: no pending PM thread for today");
      return { ok: true, skipped: true, reason: "no pending pm thread" };
    }

    const channel = pmThread.channel;
    const pmMention = config.slackPmUserId ? `<@${config.slackPmUserId}> ` : "";

    if (config.dryRun) {
      console.log("DRY_RUN: would send PM reminder");
      return { ok: true, dryRun: true, reason };
    }

    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${pmMention}リマインド: 本日のPMOレポートへの返信がまだのようです。割り振り提案の承認・修正をお願いします！`,
      undefined,
      pmThread.ts
    );

    console.log("PM reminder sent", { reason, today });
    return { ok: true, reason, reminded: true };
  } catch (error) {
    const err = error as Error;
    console.error("runPmReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

async function notifyError(_env: Env, config: AppConfig, error: Error) {
  if (!config.slackErrorWebhookUrl) return;
  const message = {
    text: `:rotating_light: Notion Sprint notifier failed\n${error.message}`
  };
  try {
    await postSlack(config.slackErrorWebhookUrl, message);
  } catch (err) {
    console.error("Failed to send error notification", err);
  }
}

// ── Progress SP Snapshot (05:00 JST = 20:00 UTC) ─────────────────────────

/** Save sprint progress_sp snapshot at 5AM JST for daily consumption calculation */
async function runProgressSpSnapshot(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const today = toJstDateString(now);
    const summary = await fetchCurrentSprintTasksSummary(config, now);

    const progressSp = summary.sprint_metrics?.progress_sp ?? null;
    const snapshotKey = `progress-sp-5am:${summary.sprint.id}:${today}`;

    await env.NOTIFY_CACHE.put(snapshotKey, JSON.stringify({
      progress_sp: progressSp,
      timestamp: now.toISOString()
    }), { expirationTtl: config.dedupeTtlSeconds });

    console.log(`Progress SP snapshot saved: ${snapshotKey} = ${progressSp}`);
    return { ok: true, reason, progressSp, date: today };
  } catch (error) {
    const err = error as Error;
    console.error("runProgressSpSnapshot failed", err);
    return { ok: false, error: err.message };
  }
}

// ── End-of-Day Reminder Flow (midnight JST) ──────────────────────────────

async function runEodReminderFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);

    if (!config.slackBotToken) {
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const today = toJstDateString();
    const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today);

    if (activeThreads.length === 0) {
      console.log("EOD reminder: no active threads for today");
      return { ok: true, skipped: true, reason: "no active threads" };
    }

    let reminded = 0;
    for (const thread of activeThreads) {
      if (config.dryRun) {
        console.log(`DRY_RUN: would send EOD reminder to ${thread.assigneeName}`);
        continue;
      }

      await chatPostMessage(
        config.slackBotToken,
        thread.channel,
        `お疲れ様です！🌙 本日のタスクのステータスを更新しましょう！\n進捗があれば共有してください。`,
        buildEodReminderButtons(),
        thread.ts
      );
      reminded++;
    }

    console.log("EOD reminder flow complete", { reason, reminded });
    return { ok: true, reason, reminded };
  } catch (error) {
    const err = error as Error;
    console.error("runEodReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

// ── Phone Reminder Flow (☎️ hourly DM reminders) ──────────────────────────

async function runPhoneReminderFlow(
  env: Env,
  trigger: "cron" | "manual"
): Promise<{ ok: boolean; message: string }> {
  const config = getConfig(env);
  if (!config.slackBotToken) {
    return { ok: false, message: "SLACK_BOT_TOKEN not configured" };
  }

  const reminders = await listAllPhoneReminders(env.NOTIFY_CACHE);
  if (reminders.length === 0) {
    console.log(`runPhoneReminderFlow(${trigger}): no active reminders`);
    return { ok: true, message: "No active phone reminders" };
  }

  const now = new Date();
  let sentCount = 0;

  for (const reminder of reminders) {
    // Check if 1 hour has passed since last reminder
    const lastReminded = new Date(reminder.lastRemindedAt);
    const msSinceLastRemind = now.getTime() - lastReminded.getTime();
    if (msSinceLastRemind < 60 * 60 * 1000) continue;

    try {
      // Fetch latest thread content
      const messages = await conversationsReplies(
        config.slackBotToken,
        reminder.channel,
        reminder.threadTs,
        100,
        true
      );

      if (messages.length === 0) continue;

      const threadContent = messages
        .map((m) => `<@${m.user}>: ${m.text}`)
        .join("\n\n");

      const threadLink = `https://slack.com/archives/${reminder.channel}/p${reminder.threadTs.replace(".", "")}`;

      const dmText =
        `☎️ *スレッドリマインド*\n` +
        `<${threadLink}|スレッドを見る>\n\n` +
        `───────────────\n` +
        `${threadContent}\n` +
        `───────────────\n` +
        `_☎️ リアクションを外すとリマインドを解除できます。_`;

      const dmChannelId = await conversationsOpen(config.slackBotToken, reminder.userId);
      if (!dmChannelId) continue;

      await chatPostMessage(config.slackBotToken, dmChannelId, dmText);

      // Update lastRemindedAt
      await savePhoneReminder(
        env.NOTIFY_CACHE,
        reminder.userId,
        reminder.channel,
        reminder.threadTs,
        { ...reminder, lastRemindedAt: now.toISOString() }
      );

      sentCount++;
    } catch (err) {
      console.error(`Phone reminder failed for user=${reminder.userId} thread=${reminder.threadTs}:`, err);
    }
  }

  const msg = `Sent ${sentCount} phone reminders out of ${reminders.length} active (trigger=${trigger})`;
  console.log(`runPhoneReminderFlow: ${msg}`);
  return { ok: true, message: msg };
}

// ── HTTP handler ───────────────────────────────────────────────────────────

async function handleHttp(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return jsonResponse({ status: "ok" });
  }

  // Slack Events API
  if (path === "/slack/events" && request.method === "POST") {
    return handleSlackEvents(request, env, ctx);
  }

  // Slack Reaction handler (Step 8 confirmation via emoji reaction)
  if (path === "/slack/reaction" && request.method === "POST") {
    // Reaction events come via Events API; this endpoint is a convenience alias
    return handleSlackEvents(request, env, ctx);
  }

  // Slack Interactivity (button clicks, select menus, etc.)
  if (path === "/slack/interactions" && request.method === "POST") {
    return handleSlackInteractions(request, env, ctx);
  }

  if (path === "/run-now") {
    const config = getConfig(env);
    if (
      config.requireApproval === "always" &&
      url.searchParams.get("approved") !== "true"
    ) {
      return jsonResponse(
        { ok: false, message: "approval required (add ?approved=true)" },
        403
      );
    }
    const result = await runReport(env, "manual");
    return jsonResponse(result);
  }

  if (path === "/run-sprint-tasks") {
    const config = getConfig(env);
    if (
      config.requireApproval === "always" &&
      url.searchParams.get("approved") !== "true"
    ) {
      return jsonResponse(
        { ok: false, message: "approval required (add ?approved=true)" },
        403
      );
    }
    const result = await runSprintTasksReport(env, "manual");
    return jsonResponse(result);
  }

  // PMO AI Agent flow triggers (manual)
  if (path === "/pmo/morning") {
    const target = url.searchParams.get("target");
    const result = await runMorningFlow(env, "manual", target);
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/reminder") {
    const result = await runReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/evening") {
    const result = await runEveningFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/pm-reminder") {
    const result = await runPmReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/phone-reminder") {
    const result = await runPhoneReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/eod-reminder") {
    const result = await runEodReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/progress-snapshot") {
    const result = await runProgressSpSnapshot(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/query" && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body?.prompt || typeof body.prompt !== "string") {
      return jsonResponse({ ok: false, error: "prompt is required" }, 400);
    }
    const config = getConfig(env);
    try {
      const text = await fetchFreeText(config, body.prompt, new Date());
      return jsonResponse({ ok: true, text });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  if (path === "/notion-tasks" && request.method === "GET") {
    const config = getConfig(env);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    try {
      if ((start && !end) || (!start && end)) {
        return jsonResponse(
          { ok: false, error: "start and end must be provided together" },
          400
        );
      }
      if (start && end) {
        const tasks = await fetchTasksInDateRange(config, start, end);
        return jsonResponse({ ok: true, count: tasks.length, tasks });
      }
      const now = new Date();
      const summary = await fetchCurrentSprintTasksSummary(config, now);
      const count = summary.assignees.reduce(
        (total, assignee) => total + assignee.tasks.length,
        0
      );
      return jsonResponse({ ok: true, mode: "current_sprint", count, summary });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  if (path === "/notion-tasks/notify-assignees") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (start || end) {
      return jsonResponse(
        { ok: false, error: "this endpoint does not accept start/end params" },
        400
      );
    }
    const result = await runAssigneeTasksReport(env, "manual");
    const status = result.ok ? 200 : 500;
    return jsonResponse(result, status);
  }

  if (path === "/notion-tasks/notify") {
    const config = getConfig(env);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    try {
      if ((start && !end) || (!start && end)) {
        return jsonResponse(
          { ok: false, error: "start and end must be provided together" },
          400
        );
      }
      if (start && end) {
        const tasks = await fetchTasksInDateRange(config, start, end);
        const summaries = summarizeTasks(tasks);
        const slackPayload = buildTasksPayload(summaries, { start, end });
        if (config.dryRun) {
          console.log("DRY_RUN: notion-tasks payload", slackPayload);
          return jsonResponse({
            ok: true,
            dryRun: true,
            count: summaries.length
          });
        }
        if (!config.slackWebhookUrl) {
          return jsonResponse({ ok: false, error: "SLACK_WEBHOOK_URL not set" }, 500);
        }
        await postSlack(config.slackWebhookUrl, slackPayload);
        return jsonResponse({ ok: true, count: summaries.length });
      }

      const now = new Date();
      const summary = await fetchCurrentSprintTasksSummary(config, now);
      const { metrics, changes } = await buildSprintTasksMeta(
        env,
        summary,
        config,
        now
      );
      const slackPayload = buildSprintTasksPayload(summary, metrics, changes);
      const count = summary.assignees.reduce(
        (total, assignee) => total + assignee.tasks.length,
        0
      );
      if (config.dryRun) {
        console.log("DRY_RUN: sprint tasks payload", slackPayload);
        return jsonResponse({ ok: true, dryRun: true, count });
      }
      if (!config.slackWebhookUrl) {
        return jsonResponse({ ok: false, error: "SLACK_WEBHOOK_URL not set" }, 500);
      }
      await postSlack(config.slackWebhookUrl, slackPayload);
      return jsonResponse({ ok: true, count });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  return jsonResponse({ message: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleHttp(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Branch by cron expression
    if (event.cron === "0 20 * * *") {
      // 05:00 JST — Save progress SP snapshot
      ctx.waitUntil(runProgressSpSnapshot(env, "cron"));
    } else if (event.cron === "0 0 * * *") {
      // 09:00 JST — Member notification
      ctx.waitUntil(runMorningFlow(env, "cron"));
    } else if (event.cron === "10,20,30,40,50 0 * * *") {
      // 09:10-09:50 JST — Member reminder (every 10 min)
      ctx.waitUntil(runReminderFlow(env, "cron"));
    } else if (event.cron === "0 1 * * *") {
      // 10:00 JST — PM report (Steps 6-7)
      ctx.waitUntil(runEveningFlow(env, "cron"));
    } else if (event.cron === "0 2-10 * * *") {
      // 11:00-19:00 JST (hourly) — PM reminder if unreplied
      ctx.waitUntil(runPmReminderFlow(env, "cron"));
    } else if (event.cron === "15 * * * *") {
      // Every hour at :15 — ☎️ Phone reminder DMs
      ctx.waitUntil(runPhoneReminderFlow(env, "cron"));
    } else if (event.cron === "0 15 * * *") {
      // 00:00 JST (midnight) — EOD status update reminder
      ctx.waitUntil(runEodReminderFlow(env, "cron"));
    } else {
      // Fallback: legacy reports
      ctx.waitUntil(runReport(env, "cron"));
      ctx.waitUntil(runSprintTasksReport(env, "cron"));
      ctx.waitUntil(runAssigneeTasksReport(env, "cron"));
    }
  }
};
