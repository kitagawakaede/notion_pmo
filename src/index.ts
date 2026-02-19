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
  fetchCurrentSprintTasksSummary
} from "./notionApi";

export interface Env extends Bindings {}

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
  const dateLabel = `${now.getMonth() + 1}/${now.getDate()}`;
  const todayKey = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
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

async function notifyError(env: Env, config: AppConfig, error: Error) {
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

async function handleHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return jsonResponse({ status: "ok" });
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

  if (path === "/query" && request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
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
    const config = getConfig(env);
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
    return handleHttp(request, env as Env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReport(env as Env, "cron"));
    ctx.waitUntil(runSprintTasksReport(env as Env, "cron"));
    ctx.waitUntil(runAssigneeTasksReport(env as Env, "cron"));
  }
};
