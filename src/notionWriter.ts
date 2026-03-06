import { withRetry } from "./retry";

const NOTION_VERSION = "2022-06-28";

interface PageUpdates {
  /** ISO date string YYYY-MM-DD */
  due?: string;
  /** Story points */
  sp?: number;
  /** Status name as it appears in Notion */
  status?: string;
  /** Assignee name (auto-resolved to Notion user ID) */
  assignee?: string;
}

// ── Notion user ID mapping (name → ID) ─────────────────────────────────────

let cachedUserMap: Map<string, string> | null = null;

/**
 * Notion API users.list で全ユーザーを取得し、名前→ID のマップを返す。
 * 結果はプロセス内キャッシュされる（Worker リクエスト単位でリセット）。
 */
export async function fetchNotionUserMap(
  token: string
): Promise<Map<string, string>> {
  if (cachedUserMap) return cachedUserMap;

  const userMap = new Map<string, string>();
  let nextCursor: string | undefined;

  try {
    do {
      const url = nextCursor
        ? `https://api.notion.com/v1/users?start_cursor=${nextCursor}&page_size=100`
        : "https://api.notion.com/v1/users?page_size=100";

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION
        }
      });

      if (!res.ok) {
        console.warn(`Notion users.list failed: ${res.status}`);
        break;
      }

      const data = (await res.json()) as {
        results: Array<{ id: string; name?: string; type?: string }>;
        has_more: boolean;
        next_cursor?: string;
      };

      for (const user of data.results) {
        if (user.name) {
          userMap.set(user.name, user.id);
        }
      }

      nextCursor = data.has_more ? data.next_cursor : undefined;
    } while (nextCursor);
  } catch (err) {
    console.warn(`Notion users.list error: ${(err as Error).message}`);
  }

  cachedUserMap = userMap;
  console.log(`Notion user map loaded: ${userMap.size} users`);
  return userMap;
}

/**
 * タスクDBの担当者（people）プロパティから名前→IDマップを構築する。
 * users.list が権限不足で空の場合のフォールバック。
 */
export async function buildUserMapFromDatabase(
  token: string,
  databaseId: string
): Promise<Map<string, string>> {
  const userMap = new Map<string, string>();

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ page_size: 100 })
    });

    if (!res.ok) return userMap;

    const data = (await res.json()) as {
      results: Array<{ properties: Record<string, any> }>;
    };

    for (const page of data.results) {
      for (const prop of Object.values(page.properties)) {
        if (prop?.type === "people" && Array.isArray(prop.people)) {
          for (const person of prop.people) {
            if (person.name && person.id) {
              userMap.set(person.name, person.id);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`buildUserMapFromDatabase error: ${(err as Error).message}`);
  }

  console.log(`DB user map built: ${userMap.size} users: ${Array.from(userMap.keys()).join(", ")}`);
  return userMap;
}

async function patchPage(
  token: string,
  pageId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await withRetry(
    async () => {
      const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ properties })
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Notion update error [${pageId}]: ${res.status} ${detail}`);
      }
    },
    { label: `Notion patchPage ${pageId}` }
  );
}

export async function updateTaskPage(
  token: string,
  pageId: string,
  updates: PageUpdates
): Promise<void> {
  const properties: Record<string, unknown> = {};

  if (updates.due !== undefined) {
    properties["期限"] = { date: { start: updates.due } };
  }
  if (updates.sp !== undefined) {
    properties["SP"] = { number: updates.sp };
  }
  if (updates.status !== undefined) {
    properties["ステータス"] = { status: { name: updates.status } };
  }
  if (updates.assignee !== undefined) {
    const userMap = await fetchNotionUserMap(token);
    let notionUserId = userMap.get(updates.assignee);

    // Fallback: resolve from page's parent database if users.list doesn't have the user
    if (!notionUserId && pageId) {
      try {
        const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION
          }
        });
        if (pageRes.ok) {
          const pageData = (await pageRes.json()) as { parent?: { type?: string; database_id?: string } };
          if (pageData.parent?.type === "database_id" && pageData.parent.database_id) {
            const dbUserMap = await buildUserMapFromDatabase(token, pageData.parent.database_id);
            notionUserId = dbUserMap.get(updates.assignee);
          }
        }
      } catch (err) {
        console.warn(`Assignee fallback lookup failed: ${(err as Error).message}`);
      }
    }

    if (notionUserId) {
      properties["担当者"] = { people: [{ id: notionUserId }] };
    } else {
      console.warn(`update_assignee: user "${updates.assignee}" not found in Notion`);
    }
  }

  if (Object.keys(properties).length === 0) return;
  await patchPage(token, pageId, properties);
}

export async function updateTaskProject(
  token: string,
  pageId: string,
  projectIds: string[],
  relationProperty = "プロジェクト"
): Promise<void> {
  const relation = projectIds.map((id) => ({ id }));
  await patchPage(token, pageId, {
    [relationProperty]: { relation }
  });
}

export async function updateTaskSprint(
  token: string,
  pageId: string,
  targetSprintId: string,
  relationProperty = "スプリント"
): Promise<void> {
  const relation = targetSprintId
    ? [{ id: targetSprintId }]
    : [];
  await patchPage(token, pageId, {
    [relationProperty]: { relation }
  });
}

export async function createTaskPage(
  token: string,
  databaseId: string,
  properties: Record<string, unknown>
): Promise<{ id: string; url: string }> {
  let createdPageId = "";
  let createdPageUrl = "";
  await withRetry(
    async () => {
      const res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ parent: { database_id: databaseId }, properties })
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Notion create error: ${res.status} ${detail}`);
      }
      const data = (await res.json()) as { id?: string; url?: string };
      createdPageId = data.id ?? "";
      createdPageUrl = data.url ?? "";
      console.log(`Notion page created: id=${data.id}, url=${data.url}`);
    },
    { label: "Notion createTaskPage" }
  );
  return { id: createdPageId, url: createdPageUrl };
}

export async function appendPageContent(
  token: string,
  pageId: string,
  content: string
): Promise<void> {
  await withRetry(
    async () => {
      const res = await fetch(
        `https://api.notion.com/v1/blocks/${pageId}/children`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            children: [
              {
                object: "block",
                type: "heading_2",
                heading_2: {
                  rich_text: [{ type: "text", text: { content: "概要" } }]
                }
              },
              {
                object: "block",
                type: "paragraph",
                paragraph: {
                  rich_text: [{ type: "text", text: { content } }]
                }
              }
            ]
          })
        }
      );
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(
          `Notion appendPageContent error [${pageId}]: ${res.status} ${detail}`
        );
      }
    },
    { label: `Notion appendPageContent ${pageId}` }
  );
}

export interface ProjectCandidate {
  id: string;
  name: string;
}

/**
 * Notion Search API でプロジェクト名を部分一致検索し、候補を返す。
 */
export async function searchProjectsByName(
  token: string,
  projectName: string
): Promise<ProjectCandidate[]> {
  try {
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: projectName,
        filter: { value: "page", property: "object" },
        page_size: 10
      })
    });

    if (!res.ok) {
      console.warn(`Notion search failed: ${res.status}`);
      return [];
    }

    const data = (await res.json()) as {
      results: Array<{
        id: string;
        properties?: Record<string, any>;
      }>;
    };

    const candidates: ProjectCandidate[] = [];
    for (const page of data.results) {
      const props = page.properties ?? {};
      for (const prop of Object.values(props)) {
        if (prop?.type === "title" && Array.isArray(prop.title)) {
          const title = prop.title.map((t: any) => t.plain_text ?? "").join("");
          if (title && (title.includes(projectName) || projectName.includes(title))) {
            candidates.push({ id: page.id, name: title });
          }
        }
      }
    }

    console.log(`Project search "${projectName}": ${candidates.length} candidates found`);
    return candidates;
  } catch (err) {
    console.warn(`searchProjectsByName error: ${(err as Error).message}`);
    return [];
  }
}
