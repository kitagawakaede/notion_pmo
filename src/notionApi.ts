import { extractNotionIdFromUrl, type AppConfig } from "./config";
import type { SprintTasksSummary } from "./schema";
import { withRetry } from "./retry";
import { toJstDateString } from "./workflow";

const NOTION_VERSION = "2022-06-28";

interface NotionTask {
  id: string;
  title: string;
  properties: Record<string, unknown>;
}

interface NotionTaskSummary {
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

  const data = await withRetry(
    async () => {
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
      return (await res.json()) as any;
    },
    { label: "Notion fetchTasksInDateRange" }
  );
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

export const isCompletedStatus = (status?: string | null): boolean => {
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


async function notionRequest(
  config: AppConfig,
  path: string,
  body: Record<string, unknown>,
  options?: { silent?: boolean }
): Promise<any> {
  return withRetry(
    async () => {
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
    },
    { label: `Notion ${path}`, silent: options?.silent }
  );
}

async function queryDatabase(
  config: AppConfig,
  databaseId: string,
  body: Record<string, unknown>,
  maxPages = 5,
  options?: { silent?: boolean }
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
      payload,
      options
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
  startDate: string | null;
  category: string | null;
  subItem: string | null;
  company: string | null;
  url?: string | null;
  assignees: string[];
  projectIds: string[];
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

/** Fetch page titles by IDs in batch (individual fetches, deduplicated) */
async function fetchPageTitles(
  config: AppConfig,
  pageIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(pageIds)];

  await Promise.all(
    unique.map(async (pageId) => {
      try {
        const res = await withRetry(
          async () => {
            const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
              headers: {
                Authorization: `Bearer ${config.notionToken}`,
                "Notion-Version": NOTION_VERSION
              }
            });
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          },
          { label: `fetchPage ${pageId}` }
        );
        const props = (res as any)?.properties ?? {};
        for (const prop of Object.values(props)) {
          if ((prop as any)?.type === "title" && Array.isArray((prop as any).title)) {
            const title = (prop as any).title
              .map((t: any) => t.plain_text ?? "")
              .join("");
            if (title) {
              result.set(pageId, title);
              break;
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch page title for ${pageId}: ${(err as Error).message}`);
      }
    })
  );

  return result;
}

/** Generate abbreviated project name (e.g. "Mavericks" → "M", "LiftForce" → "LF") */
function abbreviateProjectName(name: string): string {
  // If already short (<=3 chars), use as-is
  if (name.length <= 3) return name;

  // Extract uppercase letters from camelCase/PascalCase (e.g. "LiftForce" → "LF")
  const uppercaseLetters = name.match(/[A-Z]/g);
  if (uppercaseLetters && uppercaseLetters.length >= 2) {
    return uppercaseLetters.join("");
  }

  // Split by spaces/delimiters and take initials
  const words = name.split(/[\s\-_・]+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map((w) => w[0].toUpperCase()).join("");
  }

  // Single word: first 1-2 chars (uppercase for English)
  if (/^[a-zA-Z]/.test(name)) {
    return name.slice(0, 1).toUpperCase();
  }

  // Japanese/other: first char
  return name.slice(0, 1);
}

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

  const categoryProp = getPropertyByName(props, ["大項目", "カテゴリ", "Category"]);
  const category = getStatusName(categoryProp) ?? null;

  const subItemProp = getPropertyByName(props, ["小項目", "Sub Item"]);
  const subItem = getStatusName(subItemProp) ?? null;

  const companyProp = getPropertyByName(props, ["実施社", "Company"]);
  const company = getStatusName(companyProp) ?? null;

  const startDateProp = getPropertyByName(props, ["開始日", "Start Date"]);
  const startDateValue = getDateValue(startDateProp);
  const startDate = normalizeDateString(startDateValue?.start) ?? null;

  // Extract per-task project relation IDs
  const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
  const taskProjectIds: string[] = [];
  if (projectProp?.type === "relation" && Array.isArray(projectProp.relation)) {
    for (const rel of projectProp.relation) {
      if (rel?.id) taskProjectIds.push(rel.id);
    }
  }

  return {
    id: page.id,
    name,
    status,
    priority,
    sp,
    due,
    startDate,
    category,
    subItem,
    company,
    url,
    assignees,
    projectIds: taskProjectIds
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
        startDate: task.startDate ?? null,
        category: task.category ?? null,
        subItem: task.subItem ?? null,
        company: task.company ?? null,
        url: task.url ?? null,
        projectName: null as string | null
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
    {},
    10
  );
  if (sprintPages.length === 0) {
    throw new Error("Sprint DB query returned no results");
  }

  const today = toJstDateString(now);
  const sprintCandidates = sprintPages
    .map((page) => extractSprintInfo(page, dateProp))
    .filter((sprint): sprint is SprintInfo => sprint != null);
  if (sprintCandidates.length === 0) {
    throw new Error("Sprint records did not contain a valid period property");
  }

  console.log("Sprint candidates:", sprintCandidates.map((s) => `${s.name} ${s.start_date}~${s.end_date} [${s.status}]`));
  console.log("Looking for sprint containing today:", today);

  let sprint =
    sprintCandidates.find((s) =>
      isDateInRange(today, s.start_date, s.end_date)
    ) ?? sprintCandidates.find((s) => isActiveStatus(s.status));
  if (!sprint) sprint = sprintCandidates[0];

  console.log("Selected sprint:", sprint.name, sprint.start_date, "~", sprint.end_date);

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
  // Extract project relation — collect from ALL non-completed tasks and pick the most common
  const projectIdCounts = new Map<string, number>();
  for (const page of taskPages) {
    const task = extractTaskRow(page);
    if (!task) continue;
    tasks.push(task);
    const props = page?.properties ?? {};
    const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
    if (projectProp?.type === "relation" && Array.isArray(projectProp.relation)) {
      for (const rel of projectProp.relation) {
        if (rel?.id) {
          projectIdCounts.set(rel.id, (projectIdCounts.get(rel.id) ?? 0) + 1);
        }
      }
    }
  }

  // Sort by frequency (most common first) and deduplicate
  const projectIds = Array.from(projectIdCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  if (projectIds.length > 0) {
    console.log(`Project relations extracted: ${projectIds.join(", ")} (from ${projectIdCounts.size} unique projects)`);
  } else {
    console.warn("No project relations found in sprint tasks");
  }

  // Resolve project IDs to names and assign to tasks
  const allTaskProjectIds = tasks.flatMap((t) => t.projectIds);
  const uniqueProjectIds = [...new Set(allTaskProjectIds)];
  let projectNameMap = new Map<string, string>();
  if (uniqueProjectIds.length > 0) {
    projectNameMap = await fetchPageTitles(config, uniqueProjectIds);
    console.log(`Project names resolved: ${Array.from(projectNameMap.entries()).map(([id, name]) => `${name}(${id.slice(0, 8)})`).join(", ")}`);
  }

  // Build task ID → project name mapping
  const taskProjectNameMap = new Map<string, string>();
  for (const task of tasks) {
    if (task.projectIds.length > 0) {
      const firstName = projectNameMap.get(task.projectIds[0]);
      if (firstName) {
        taskProjectNameMap.set(task.id, firstName);
      }
    }
  }

  const assignees = groupTasksByAssignee(tasks);

  // Assign project names to grouped tasks
  for (const assignee of assignees) {
    for (const task of assignee.tasks) {
      task.projectName = taskProjectNameMap.get(task.id) ?? null;
    }
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
    assignees,
    projectIds
  };
}

interface MemberCapacity {
  name: string;
  totalHours: number;
  remainingHours: number;
  dailyHours: Record<string, number>;
}

// 曜日カラム名 → JS Date.getDay() の値
const DAY_COLUMN_MAP: Record<string, number> = {
  "日曜日": 0, "月曜日": 1, "火曜日": 2, "水曜日": 3,
  "木曜日": 4, "金曜日": 5, "土曜日": 6
};

// スプリントの曜日順（火曜始まり）
const SPRINT_DAY_ORDER = [2, 3, 4, 5, 6, 0, 1]; // 火水木金土日月

/**
 * スプリントページ内のキャパシティ子データベースから
 * 各メンバーの曜日別稼働時間と今日以降の残り稼働時間を取得する
 */
export async function fetchSprintCapacity(
  config: AppConfig,
  sprintPageId: string
): Promise<MemberCapacity[]> {
  // スプリントページの子ブロックを取得
  let blocksData: any;
  try {
    blocksData = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/blocks/${sprintPageId}/children?page_size=100`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Failed to fetch sprint page children: ${res.status} ${detail}`);
        }
        return (await res.json()) as any;
      },
      { label: "Notion fetchSprintCapacity" }
    );
  } catch (err) {
    console.warn((err as Error).message);
    return [];
  }
  const blocks = Array.isArray(blocksData.results) ? blocksData.results : [];

  // キャパシティDBを探す: タイトルマッチ or 曜日カラムを持つDBを検出
  let capacityDbId: string | null = null;
  const childDbs = blocks.filter((b: any) => b.type === "child_database");

  for (const db of childDbs) {
    const title = (db.child_database?.title ?? "") as string;
    if (title.includes("キャパシティ") || title.includes("Capacity")) {
      capacityDbId = db.id;
      break;
    }
  }

  // タイトルでマッチしなかった場合、中身をサンプルして曜日カラムがあるDBを探す
  if (!capacityDbId) {
    for (const db of childDbs) {
      try {
        const sample = await queryDatabase(config, db.id, {}, 1, { silent: true });
        if (sample.length === 0) continue;
        const props = Object.keys(sample[0]?.properties ?? {});
        const hasDayColumns = Object.keys(DAY_COLUMN_MAP).some((day) =>
          props.includes(day)
        );
        if (hasDayColumns) {
          capacityDbId = db.id;
          console.log(`Capacity DB detected by day columns: ${db.id}`);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!capacityDbId) {
    return [];
  }

  // キャパシティDBをクエリ
  const dbResults = await queryDatabase(config, capacityDbId, {}, 3);

  // 今日の曜日（JST）
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayDow = nowJst.getUTCDay(); // 0=日, 1=月, ..., 6=土

  // 今日以降のスプリント曜日を取得
  const todayIndex = SPRINT_DAY_ORDER.indexOf(todayDow);
  const remainingDays = todayIndex >= 0
    ? SPRINT_DAY_ORDER.slice(todayIndex)
    : SPRINT_DAY_ORDER; // 見つからなければ全日

  const capacities: MemberCapacity[] = [];
  for (const page of dbResults) {
    const props = page?.properties ?? {};
    const name = getTitleFromProperties(props, [
      "名前", "Name", "メンバー", "Member"
    ]);
    if (!name || name === "(no title)") continue;

    // 曜日別の稼働時間を取得
    const dailyHours: Record<string, number> = {};
    let totalHours = 0;
    let remainingHours = 0;

    for (const [colName, dow] of Object.entries(DAY_COLUMN_MAP)) {
      const val = asNumber(props[colName]);
      if (val != null) {
        dailyHours[colName] = val;
        totalHours += val;
        if (remainingDays.includes(dow)) {
          remainingHours += val;
        }
      }
    }

    // 合計カラムがあればそちらを使う（ロールアップ等の場合）
    const totalProp = getPropertyByName(props, ["合計", "Total", "合計時間"]);
    const explicitTotal = asNumber(totalProp);
    if (explicitTotal != null) {
      totalHours = explicitTotal;
    }

    if (totalHours === 0 && remainingHours === 0) continue;

    capacities.push({ name, totalHours, remainingHours, dailyHours });
  }

  console.log(`Capacity data: today=${Object.entries(DAY_COLUMN_MAP).find(([,v]) => v === todayDow)?.[0]}, remaining days=${remainingDays.length}`,
    capacities.map((c) => `${c.name}: total=${c.totalHours}h, remaining=${c.remainingHours}h`));

  return capacities;
}

export async function fetchAllSprints(
  config: AppConfig
): Promise<Array<{ id: string; name: string; start_date: string; end_date: string; status: string }>> {
  const sprintDbId = await resolveDatabaseId(config, {
    url: config.sprintDbUrl,
    name: config.sprintDbName,
    label: "SPRINT_DB"
  });

  const dateProp = config.notionDateProperty;
  const sprintPages = await queryDatabase(config, sprintDbId, {}, 10);

  const sprints: Array<{ id: string; name: string; start_date: string; end_date: string; status: string }> = [];
  for (const page of sprintPages) {
    const info = extractSprintInfo(page, dateProp);
    if (!info) continue;
    sprints.push({
      id: info.id,
      name: info.name,
      start_date: info.start_date,
      end_date: info.end_date,
      status: info.status
    });
  }

  return sprints;
}

// ── Reference project page (read-only) ──────────────────────────────────────

export interface ReferenceItem {
  /** Section heading path, e.g. "MTG提出資料 > 1/21㈬定例報告資料" */
  section: string;
  content: string;
}

/**
 * Recursively fetch all text content from a Notion project page (read-only).
 * Used as context for LLM when creating tasks.
 * This page is NEVER written to — only used as reference.
 */
export async function fetchReferenceDbItems(
  config: AppConfig
): Promise<ReferenceItem[]> {
  if (!config.referenceDbId) return [];

  // Also fetch page properties (project name, status, team, etc.)
  const items: ReferenceItem[] = [];

  try {
    const pageRes = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/pages/${config.referenceDbId}`,
          {
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) throw new Error(`Notion page fetch: ${res.status}`);
        return res.json() as Promise<any>;
      },
      { label: "Notion fetchReferencePage" }
    );

    // Extract page-level properties as summary
    const props = pageRes?.properties ?? {};
    const projName = getTitleFromProperties(props, ["プロジェクト名", "名前", "Name", "Title"]);
    const statusProp = getPropertyByName(props, ["ステータス", "Status"]);
    const status = getStatusName(statusProp) ?? "";
    const teamProp = getPropertyByName(props, ["チーム", "Team"]);
    const team = getStatusName(teamProp) ?? "";
    const devTeamProp = getPropertyByName(props, ["開発チーム"]);
    const devTeam = getStatusName(devTeamProp) ?? "";
    const dateProp = getPropertyByName(props, ["日付", "Date"]);
    const dateVal = getDateValue(dateProp);
    const mgr = getPeopleNames(getPropertyByName(props, ["管理者"]));
    const pm = getPeopleNames(getPropertyByName(props, ["PM"]));
    const tanto = getPeopleNames(getPropertyByName(props, ["担当"]));
    const eng = getPeopleNames(getPropertyByName(props, ["エンジニア"]));

    items.push({
      section: "プロジェクト概要",
      content: [
        `プロジェクト名: ${projName}`,
        `ステータス: ${status}`,
        `チーム: ${team}`,
        devTeam ? `開発チーム: ${devTeam}` : "",
        `期間: ${dateVal?.start ?? "?"} 〜 ${dateVal?.end ?? "?"}`,
        mgr.length > 0 ? `管理者: ${mgr.join(", ")}` : "",
        pm.length > 0 ? `PM: ${pm.join(", ")}` : "",
        tanto.length > 0 ? `担当: ${tanto.join(", ")}` : "",
        eng.length > 0 ? `エンジニア: ${eng.join(", ")}` : ""
      ].filter(Boolean).join("\n")
    });
  } catch (err) {
    console.warn(`Reference page properties fetch failed: ${(err as Error).message}`);
  }

  // Recursively read blocks
  await fetchBlocksRecursive(config, config.referenceDbId!, items, "", 0);

  console.log(`Reference page: fetched ${items.length} sections`);
  return items;
}

async function fetchBlocksRecursive(
  config: AppConfig,
  blockId: string,
  items: ReferenceItem[],
  parentSection: string,
  depth: number
): Promise<void> {
  if (depth > 3) return; // Don't go too deep

  let data: any;
  try {
    data = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`,
          {
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) throw new Error(`Notion blocks: ${res.status}`);
        return res.json();
      },
      { label: `Notion blocks ${blockId}` }
    );
  } catch {
    return;
  }

  const blocks = (data as any)?.results ?? [];
  let currentSection = parentSection;
  let textBuffer: string[] = [];

  const flushBuffer = () => {
    if (textBuffer.length > 0 && currentSection) {
      // Append to existing section or create new
      const existing = items.find((i) => i.section === currentSection);
      const text = textBuffer.join("\n");
      if (existing) {
        existing.content += "\n" + text;
      } else {
        items.push({ section: currentSection, content: text });
      }
      textBuffer = [];
    }
  };

  for (const block of blocks) {
    const btype = block.type as string;
    const hasChildren = block.has_children as boolean;

    if (btype === "child_database") {
      // Skip child databases (not accessible / separate concern)
      continue;
    }

    if (btype === "child_page") {
      flushBuffer();
      const pageTitle = block.child_page?.title ?? "";
      const section = parentSection ? `${parentSection} > ${pageTitle}` : pageTitle;
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, section, depth + 1);
      }
      continue;
    }

    // Heading blocks — update current section
    if (btype.startsWith("heading_")) {
      flushBuffer();
      const rt = block[btype]?.rich_text ?? [];
      const text = rt.map((t: any) => t?.plain_text ?? "").join("");
      if (text) {
        currentSection = parentSection ? `${parentSection} > ${text}` : text;
      }
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
      }
      continue;
    }

    // Toggle blocks
    if (btype === "toggle") {
      flushBuffer();
      const rt = block.toggle?.rich_text ?? [];
      const text = rt.map((t: any) => t?.plain_text ?? "").join("");
      const toggleSection = parentSection ? `${parentSection} > ${text}` : text;
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, toggleSection, depth + 1);
      }
      continue;
    }

    // Column list — recurse into children
    if (btype === "column_list" || btype === "column") {
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
      }
      continue;
    }

    // Text content blocks
    const content = block[btype];
    if (content?.rich_text) {
      const text = (content.rich_text as any[]).map((t) => t?.plain_text ?? "").join("");
      if (text.trim()) {
        const prefix =
          btype === "bulleted_list_item" ? "・" :
          btype === "numbered_list_item" ? "- " :
          btype === "callout" ? "📌 " : "";
        textBuffer.push(prefix + text.trim());
      }
    }

    // Code blocks
    if (btype === "code" && content?.rich_text) {
      const code = (content.rich_text as any[]).map((t) => t?.plain_text ?? "").join("");
      if (code.trim()) {
        textBuffer.push("```\n" + code.trim() + "\n```");
      }
    }

    // Recurse if has children (e.g. callout with children)
    if (hasChildren && btype !== "code") {
      flushBuffer();
      await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
    }
  }

  flushBuffer();
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
