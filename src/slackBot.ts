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

export async function conversationsOpen(
  token: string,
  userId: string
): Promise<string> {
  const data = (await slackApiCall(token, "conversations.open", {
    users: userId
  })) as { channel?: { id?: string } };
  return data.channel?.id ?? "";
}

export async function chatPostMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string
): Promise<PostMessageResult> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks) {
    // Prepend text as a section block so it's visible alongside buttons
    const textBlock = {
      type: "section",
      text: { type: "mrkdwn", text }
    };
    body.blocks = [textBlock, ...blocks];
  }
  if (threadTs) body.thread_ts = threadTs;

  const data = (await slackApiCall(token, "chat.postMessage", body)) as {
    ts: string;
    channel: string;
  };
  return { ts: data.ts, channel: data.channel };
}

export async function chatUpdate(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[]
): Promise<void> {
  const body: Record<string, unknown> = { channel, ts, text };
  if (blocks) body.blocks = blocks;
  await slackApiCall(token, "chat.update", body);
}

export async function viewsOpen(
  token: string,
  triggerId: string,
  view: unknown
): Promise<void> {
  await slackApiCall(token, "views.open", {
    trigger_id: triggerId,
    view
  });
}

export async function conversationsMembers(
  token: string,
  channel: string
): Promise<string[]> {
  const data = (await slackApiCall(token, "conversations.members", {
    channel,
    limit: 200
  })) as { members?: string[] };
  return data.members ?? [];
}

export async function usersInfo(
  token: string,
  userId: string
): Promise<{ realName: string; displayName: string }> {
  const data = (await slackApiCall(token, "users.info", {
    user: userId
  })) as { user?: { real_name?: string; profile?: { display_name?: string } } };
  return {
    realName: data.user?.real_name ?? "",
    displayName: data.user?.profile?.display_name ?? ""
  };
}

export async function authTest(
  token: string
): Promise<{ userId: string; botId: string }> {
  const data = (await slackApiCall(token, "auth.test", {})) as {
    user_id?: string;
    bot_id?: string;
  };
  return {
    userId: data.user_id ?? "",
    botId: data.bot_id ?? ""
  };
}

