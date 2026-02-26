import { withRetry } from "./retry";

interface PostMessageResult {
  ts: string;
  channel: string;
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`Slack API HTTP error: ${res.status} ${method}`);
      }

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        ts?: string;
        channel?: string;
        messages?: unknown[];
      };

      if (!data.ok) {
        throw new Error(`Slack API error [${method}]: ${data.error ?? "unknown"}`);
      }

      return data;
    },
    { label: `Slack ${method}` }
  );
}

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  reply_count?: number;
  thread_ts?: string;
}

export async function conversationsHistory(
  token: string,
  channel: string,
  limit = 50,
  oldest?: string
): Promise<SlackMessage[]> {
  const body: Record<string, unknown> = { channel, limit };
  if (oldest) body.oldest = oldest;

  const data = (await slackApiCall(token, "conversations.history", body)) as {
    messages?: Array<{
      ts?: string;
      text?: string;
      user?: string;
      reply_count?: number;
      thread_ts?: string;
    }>;
  };

  return (data.messages ?? []).map((m) => ({
    ts: m.ts ?? "",
    text: m.text ?? "",
    user: m.user ?? "",
    reply_count: m.reply_count,
    thread_ts: m.thread_ts
  }));
}

export async function conversationsReplies(
  token: string,
  channel: string,
  threadTs: string,
  limit = 20,
  includeParent = false
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({
    channel,
    ts: threadTs,
    limit: String(limit)
  });

  const res = await withRetry(
    async () => {
      const r = await fetch(
        `https://slack.com/api/conversations.replies?${params.toString()}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (!r.ok) {
        throw new Error(`Slack API HTTP error: ${r.status} conversations.replies`);
      }
      const d = (await r.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          ts?: string;
          text?: string;
          user?: string;
        }>;
      };
      if (!d.ok) {
        throw new Error(`Slack API error [conversations.replies]: ${d.error ?? "unknown"}`);
      }
      return d;
    },
    { label: "Slack conversations.replies" }
  );

  return (res.messages ?? [])
    .filter((m) => includeParent || m.ts !== threadTs)
    .map((m) => ({
      ts: m.ts ?? "",
      text: m.text ?? "",
      user: m.user ?? ""
    }));
}

export async function chatPostMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string
): Promise<PostMessageResult> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks) body.blocks = blocks;
  if (threadTs) body.thread_ts = threadTs;

  const data = (await slackApiCall(token, "chat.postMessage", body)) as {
    ts: string;
    channel: string;
  };
  return { ts: data.ts, channel: data.channel };
}

