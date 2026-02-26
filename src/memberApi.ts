import type { AppConfig } from "./config";
import type { Member } from "./schema";

const NOTION_VERSION = "2022-06-28";

function extractTitle(prop: unknown): string {
  const p = prop as Record<string, unknown> | undefined;
  if (!p) return "";
  const items = (p.title ?? []) as Array<{ plain_text?: string }>;
  return items.map((t) => t.plain_text ?? "").join("").trim();
}

function extractRichText(prop: unknown): string | null {
  const p = prop as Record<string, unknown> | undefined;
  if (!p) return null;
  const items = (p.rich_text ?? []) as Array<{ plain_text?: string }>;
  return items.map((t) => t.plain_text ?? "").join("").trim() || null;
}

function extractNumber(prop: unknown): number | null {
  const p = prop as Record<string, unknown> | undefined;
  if (!p) return null;
  if (typeof p.number === "number") return p.number;
  return null;
}

function membersFromSlackMap(map: Record<string, string>): Member[] {
  return Object.entries(map).map(([name, slackUserId]) => ({
    name,
    slackUserId,
    spRate: 1
  }));
}

export async function fetchMembers(config: AppConfig): Promise<Member[]> {
  if (!config.memberDbId) {
    if (Object.keys(config.memberSlackMap).length > 0) {
      console.log("MEMBER_DB_URL not configured; using MEMBER_SLACK_MAP");
      return membersFromSlackMap(config.memberSlackMap);
    }
    console.warn("MEMBER_DB_URL not configured; returning empty member list");
    return [];
  }

  const res = await fetch(
    `https://api.notion.com/v1/databases/${config.memberDbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ page_size: 100 })
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion members DB error: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as { results?: unknown[] };
  const pages = data.results ?? [];

  const members: Member[] = [];
  for (const page of pages) {
    const p = page as Record<string, unknown>;
    const props = (p.properties ?? {}) as Record<string, unknown>;

    const name = extractTitle(
      props["名前"] ?? props["Name"] ?? props["name"]
    );
    if (!name) continue;

    const slackUserId =
      extractRichText(
        props["Slack User ID"] ??
          props["SlackID"] ??
          props["slack_user_id"] ??
          props["SlackユーザーID"]
      ) ?? undefined;

    const availableHours =
      extractNumber(
        props["今週の稼働可能時間"] ?? props["Available Hours"]
      ) ?? undefined;

    const spRate =
      extractNumber(props["SP換算レート"] ?? props["SP Rate"]) ?? 1;

    const notes =
      extractRichText(props["備考"] ?? props["Notes"]) ?? undefined;

    members.push({ name, slackUserId, availableHours, spRate, notes });
  }

  // Supplement missing Slack IDs from MEMBER_SLACK_MAP (supports partial match)
  for (const member of members) {
    if (!member.slackUserId) {
      const exactMatch = config.memberSlackMap[member.name];
      if (exactMatch) {
        member.slackUserId = exactMatch;
      } else {
        // Partial match: map key "北川" matches member name "北川楓"
        const partialKey = Object.keys(config.memberSlackMap).find(
          (key) => member.name.includes(key)
        );
        if (partialKey) {
          member.slackUserId = config.memberSlackMap[partialKey];
        }
      }
    }
  }

  return members;
}
