import type { AppConfig } from "./config";
import type { SprintTasksSummary } from "./schema";

const NOTION_VERSION = "2022-06-28";

export interface NotionTask {
  id: string;
  title: string;
  properties: Record<string, unknown>;
}

export interface NotionTaskSummary {
  id: string;
  title: string;
  status?: string;
  period?: { start?: string | null; end?: string | null };
  planSp?: number | null;
  doneSp?: number | null;
  progressSp?: number | null;
}

export async function fetchTasksInDateRange(
  config: AppConfig,
  start: string,
  end: string
): Promise<NotionTask[]> {
  const databaseId =
    config.taskDbId ||
    (await resolveDatabaseId(config, {
      url: config.taskDbUrl,
      name: config.taskDbName,
      label: "TASK_DB"
    }));

  const body = {
    filter: {
      property: config.notionDateProperty,
      date: {
        on_or_after: start,
        on_or_before: end
      }
    },
    sorts: [{ property: config.notionDateProperty, direction: "ascending" }]
  };

  const res = await fetch(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion API error: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as any;
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((page: any) => {
    const titleProp = page.properties?.名前?.title ?? [];
    const title =
      titleProp.find((t: any) => t.plain_text)?.plain_text ?? "(no title)";
    return {
      id: page.id,
      title,
      properties: page.properties
    };
  });
}

const asNumber = (prop: any): number | null => {
  if (prop?.type === "number" && typeof prop.number === "number") {
    return prop.number;
  }
  if (prop?.rollup?.type === "number" && typeof prop.rollup.number === "number")
    return prop.rollup.number;
  if (prop?.formula?.type === "number" && typeof prop.formula.number === "number")
    return prop.formula.number;
  return null;
};

const COMPLETED_STATUSES = [
  "完了",
  "Done",
  "Closed",
  "完了済み",
  "Completed",
  "Resolved",
  "終了",
  "クローズ"
];

const ACTIVE_STATUSES = ["Active", "進行中", "In Progress", "実行中"];

const normalizeDateString = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  return value.slice(0, 10);
};

const titleFromRichText = (items: any): string => {
  if (!Array.isArray(items)) return "";
  return items.map((item) => item?.plain_text ?? "").join("").trim();
};

const getPropertyByName = (
  props: Record<string, any>,
  names: string[]
): any | undefined => {
  for (const name of names) {
    if (props?.[name]) return props[name];
  }
  return undefined;
};

const findPropertiesByType = (
  props: Record<string, any>,
  type: string
): Array<{ name: string; value: any }> => {
  if (!props) return [];
  const out: Array<{ name: string; value: any }> = [];
  for (const [name, value] of Object.entries(props)) {
    if ((value as any)?.type === type) {
      out.push({ name, value });
    }
  }
  return out;
};

const getTitleFromProperties = (
  props: Record<string, any>,
  names: string[]
): string => {
  const prop =
    getPropertyByName(props, names) ||
    findPropertiesByType(props, "title")[0]?.value;
  const title = titleFromRichText(prop?.title);
  return title || "(no title)";
};

const getStatusName = (prop: any): string | undefined => {
  if (!prop) return undefined;
  if (prop.type === "status") return prop.status?.name ?? undefined;
  if (prop.type === "select") return prop.select?.name ?? undefined;
  return undefined;
};

const getPeopleNames = (prop: any): string[] => {
  if (prop?.type !== "people" || !Array.isArray(prop.people)) return [];
  return prop.people
    .map((p: any) => p?.name)
    .filter((name: unknown): name is string => typeof name === "string");
};

const getDateValue = (prop: any): { start?: string | null; end?: string | null } | undefined => {
  if (prop?.type !== "date") return undefined;
  return prop.date ?? undefined;
};

const isCompletedStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return COMPLETED_STATUSES.some((s) =>
    status.toLowerCase().includes(s.toLowerCase())
  );
};

const isActiveStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return ACTIVE_STATUSES.some((s) =>
    status.toLowerCase().includes(s.toLowerCase())
  );
};

const isDateInRange = (
  target: string,
  start?: string | null,
  end?: string | null
): boolean => {
  const startDate = normalizeDateString(start);
  if (!startDate) return false;
  const endDate = normalizeDateString(end) || startDate;
  return startDate <= target && target <= endDate;
};

const rangesOverlap = (
  startA?: string | null,
  endA?: string | null,
  startB?: string | null,
  endB?: string | null
): boolean => {
  const aStart = normalizeDateString(startA);
  const bStart = normalizeDateString(startB);
  if (!aStart || !bStart) return false;
  const aEnd = normalizeDateString(endA) || aStart;
  const bEnd = normalizeDateString(endB) || bStart;
  return aStart <= bEnd && aEnd >= bStart;
};

const extractNotionIdFromUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    const match = u.pathname.match(/([0-9a-fA-F]{32})/);
    if (match?.[1]) return match[1].replace(/-/g, "");
  } catch {
    // ignore invalid URLs
  }
  return undefined;
};

async function notionRequest(
  config: AppConfig,
  path: string,
  body: Record<string, unknown>
): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion API error: ${res.status} ${detail}`);
  }
  return res.json();
}

async function queryDatabase(
  config: AppConfig,
  databaseId: string,
  body: Record<string, unknown>,
  maxPages = 5
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const payload = {
      page_size: 100,
      ...body,
      ...(cursor ? { start_cursor: cursor } : {})
    };
    const data = await notionRequest(
      config,
      `databases/${databaseId}/query`,
      payload
    );
    const items = Array.isArray(data.results) ? data.results : [];
    results.push(...items);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    page += 1;
  }
  return results;
}

async function searchDatabaseIdByName(
  config: AppConfig,
  name: string
): Promise<string> {
  const data = await notionRequest(config, "search", {
    query: name,
    filter: { property: "object", value: "database" },
    page_size: 20
  });
  const results = Array.isArray(data.results) ? data.results : [];
  const normalized = name.trim().toLowerCase();

  const pickTitle = (db: any) => titleFromRichText(db?.title ?? []);
  const exact = results.find(
    (db: any) => pickTitle(db).trim().toLowerCase() === normalized
  );
  if (exact?.id) return exact.id;

  const partial = results.find((db: any) =>
    pickTitle(db).trim().toLowerCase().includes(normalized)
  );
  if (partial?.id) return partial.id;

  throw new Error(`Database not found by name: ${name}`);
}

async function resolveDatabaseId(
  config: AppConfig,
  options: { url?: string; name?: string; label: string }
): Promise<string> {
  const idFromUrl = extractNotionIdFromUrl(options.url);
  if (idFromUrl) return idFromUrl;
  if (options.name) return searchDatabaseIdByName(config, options.name);
  throw new Error(
    `${options.label} database id is required (set ${options.label}_URL or ${options.label}_NAME)`
  );
}

interface SprintInfo {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  planSp: number | null;
  progressSp: number | null;
  requiredSpPerDay: number | null;
}

interface TaskRow {
  id: string;
  name: string;
  status: string | null;
  priority: string | null;
  sp: number | null;
  due: string | null;
  url?: string | null;
  assignees: string[];
}

const extractSprintInfo = (
  page: any,
  datePropName: string
): SprintInfo | null => {
  const props = page?.properties ?? {};
  const name = getTitleFromProperties(props, ["名前", "Name"]);
  const statusProp =
    getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
    findPropertiesByType(props, "status")[0]?.value ||
    findPropertiesByType(props, "select")[0]?.value;
  const status = getStatusName(statusProp) ?? "-";

  const dateProp =
    getPropertyByName(props, [datePropName]) ||
    findPropertiesByType(props, "date")[0]?.value;
  const period = getDateValue(dateProp);
  const start = normalizeDateString(period?.start);
  const end = normalizeDateString(period?.end) || start;
  if (!start || !end) return null;

  const planSp =
    asNumber(props?.計画SP) ?? asNumber(props?.計画ポイント) ?? asNumber(props?.計画);
  const progressSp =
    asNumber(props?.進捗SP) ??
    asNumber(props?.進捗ポイント) ??
    asNumber(props?.進捗);
  const requiredSpPerDay =
    asNumber(props?.["必要SP/日"]) ??
    asNumber(props?.["必要SP/日数"]) ??
    asNumber(props?.required_sp_per_day);

  return {
    id: page.id,
    name,
    start_date: start,
    end_date: end,
    status,
    planSp,
    progressSp,
    requiredSpPerDay
  };
};

const extractTaskRow = (page: any): TaskRow | null => {
  const props = page?.properties ?? {};
  const name = getTitleFromProperties(props, ["名前", "Name"]);
  const url = typeof page?.url === "string" ? page.url : null;
  const statusProp =
    getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
    (findPropertiesByType(props, "status").length === 1
      ? findPropertiesByType(props, "status")[0].value
      : undefined);
  const priorityProp =
    getPropertyByName(props, ["優先度", "Priority"]) ||
    (findPropertiesByType(props, "select").length === 1
      ? findPropertiesByType(props, "select")[0].value
      : undefined);
  const assigneeProp =
    getPropertyByName(props, ["担当者", "Assignee", "Owner"]) ||
    (findPropertiesByType(props, "people").length === 1
      ? findPropertiesByType(props, "people")[0].value
      : undefined);

  const status = getStatusName(statusProp) ?? null;
  if (isCompletedStatus(status)) return null;

  const priority = getStatusName(priorityProp) ?? null;
  const sp =
    asNumber(props?.SP) ??
    asNumber(props?.ポイント) ??
    asNumber(props?.["Story Points"]);
  const dueProp = getPropertyByName(props, ["期限", "Due", "Due Date"]);
  const dueDate = getDateValue(dueProp);
  const due = normalizeDateString(dueDate?.start ?? dueDate?.end) ?? null;

  const assignees = getPeopleNames(assigneeProp);

  return {
    id: page.id,
    name,
    status,
    priority,
    sp,
    due,
    url,
    assignees
  };
};

const groupTasksByAssignee = (
  tasks: TaskRow[]
): SprintTasksSummary["assignees"] => {
  const grouped = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const names = task.assignees.length ? task.assignees : ["未割当"];
    for (const name of names) {
      const list = grouped.get(name) ?? [];
      list.push(task);
      grouped.set(name, list);
    }
  }

  const sorted = Array.from(grouped.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return sorted.map(([name, list]) => {
    const priorityValue = (value: string | null): number => {
      if (!value) return Number.NEGATIVE_INFINITY;
      const trimmed = value.trim();
      const num = Number(trimmed);
      if (!Number.isNaN(num)) return num;
      return Number.NEGATIVE_INFINITY;
    };

    const tasksSorted = list.sort((a, b) => {
      const aDue = a.due ?? "9999-99-99";
      const bDue = b.due ?? "9999-99-99";
      const dueCompare = aDue.localeCompare(bDue);
      if (dueCompare !== 0) return dueCompare;
      const priorityCompare =
        priorityValue(b.priority) - priorityValue(a.priority);
      if (priorityCompare !== 0) return priorityCompare;
      return a.name.localeCompare(b.name);
    });
    return {
      name,
      tasks: tasksSorted.map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status ?? null,
        priority: task.priority ?? null,
        sp: task.sp ?? null,
        due: task.due ?? null,
        url: task.url ?? null
      }))
    };
  });
};

export async function fetchCurrentSprintTasksSummary(
  config: AppConfig,
  now: Date
): Promise<SprintTasksSummary> {
  const sprintDbId = await resolveDatabaseId(config, {
    url: config.sprintDbUrl,
    name: config.sprintDbName,
    label: "SPRINT_DB"
  });
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });

  const dateProp = config.notionDateProperty;
  const sprintPages = await queryDatabase(
    config,
    sprintDbId,
    {
      sorts: [{ property: dateProp, direction: "descending" }]
    },
    10
  );
  if (sprintPages.length === 0) {
    throw new Error("Sprint DB query returned no results");
  }

  const today = now.toISOString().slice(0, 10);
  const sprintCandidates = sprintPages
    .map((page) => extractSprintInfo(page, dateProp))
    .filter((sprint): sprint is SprintInfo => sprint != null);
  if (sprintCandidates.length === 0) {
    throw new Error("Sprint records did not contain a valid period property");
  }

  let sprint =
    sprintCandidates.find((s) =>
      isDateInRange(today, s.start_date, s.end_date)
    ) ?? sprintCandidates.find((s) => isActiveStatus(s.status));
  if (!sprint) sprint = sprintCandidates[0];

  const taskPages = await queryDatabase(
    config,
    taskDbId,
    {
      filter: {
        property: config.taskSprintRelationProperty,
        relation: { contains: sprint.id }
      }
    },
    10
  );

  const tasks: TaskRow[] = [];
  for (const page of taskPages) {
    const task = extractTaskRow(page);
    if (!task) continue;
    tasks.push(task);
  }

  return {
    sprint: {
      id: sprint.id,
      name: sprint.name,
      start_date: sprint.start_date,
      end_date: sprint.end_date,
      status: sprint.status
    },
    sprint_metrics: {
      plan_sp: sprint.planSp,
      progress_sp: sprint.progressSp,
      required_sp_per_day: sprint.requiredSpPerDay
    },
    assignees: groupTasksByAssignee(tasks)
  };
}

export function summarizeTasks(tasks: NotionTask[]): NotionTaskSummary[] {
  return tasks.map((t) => {
    const p = t.properties as any;
    const period = p?.期間?.date ?? undefined;
    const status = p?.ステータス?.status?.name ?? undefined;
    const planSp =
      asNumber(p?.確定計画SP) ?? asNumber(p?.計画SP) ?? asNumber(p?.計画ポイント);
    const doneSp =
      asNumber(p?.確定完了SP) ?? asNumber(p?.完了SP) ?? asNumber(p?.進捗ポイント);
    const progressSp =
      asNumber(p?.確定進捗SP) ?? asNumber(p?.進捗SP) ?? asNumber(p?.進捗ポイント);

    return {
      id: t.id,
      title: t.title,
      status,
      period,
      planSp,
      doneSp,
      progressSp
    };
  });
}
