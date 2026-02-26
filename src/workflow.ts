// ── JST date utility ─────────────────────────────────────────────────────
/** UTC の Date を JST (UTC+9) の "YYYY-MM-DD" 文字列に変換する */
export function toJstDateString(date: Date = new Date(), offsetDays = 0): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  if (offsetDays !== 0) {
    jst.setUTCDate(jst.getUTCDate() + offsetDays);
  }
  return jst.toISOString().slice(0, 10);
}

export interface ThreadState {
  assigneeName: string;
  tasks: Array<{
    id: string;
    name: string;
    status: string | null;
    sp: number | null;
  }>;
  state: "pending" | "replied" | "processed";
  date: string;
  channel: string;
}

export interface PmThreadState {
  channel: string;
  ts: string;
  proposalJson: string;
  state: "pending" | "processed";
}

export interface StoredReply {
  text: string;
  userId: string;
  receivedAt: string;
}

export interface ActiveThread {
  channel: string;
  ts: string;
  assigneeName: string;
}

export interface PendingNotionAction {
  actions: Array<{
    action: "update_assignee" | "update_due" | "update_sp" | "update_status" | "update_sprint" | "create_task";
    page_id: string;
    task_name: string;
    new_value: string;
  }>;
  requestedBy: string;
  requestedAt: string;
  threadTs?: string;
}

const THREAD_KEY = (channel: string, ts: string) =>
  `thread:${channel}:${ts}`;
const PM_THREAD_KEY = (date: string) => `pm-thread:${date}`;
const REPLY_KEY = (channel: string, ts: string) =>
  `reply:${channel}:${ts}`;
const ACTIVE_THREADS_KEY = (date: string) => `active-threads:${date}`;
const PENDING_ACTION_KEY = (channel: string, ts: string) =>
  `pending-action:${channel}:${ts}`;
const MENTION_HISTORY_KEY = (channel: string, threadTs: string) =>
  `mention-history:${channel}:${threadTs}`;

const DEFAULT_TTL = 7 * 24 * 3600;

export async function saveThreadState(
  kv: KVNamespace,
  channel: string,
  ts: string,
  state: ThreadState,
  ttlSeconds = DEFAULT_TTL
): Promise<void> {
  await kv.put(THREAD_KEY(channel, ts), JSON.stringify(state), {
    expirationTtl: ttlSeconds
  });
}

export async function getThreadState(
  kv: KVNamespace,
  channel: string,
  ts: string
): Promise<ThreadState | null> {
  const raw = await kv.get(THREAD_KEY(channel, ts));
  if (!raw) return null;
  return JSON.parse(raw) as ThreadState;
}

export async function savePmThread(
  kv: KVNamespace,
  date: string,
  state: PmThreadState,
  ttlSeconds = DEFAULT_TTL
): Promise<void> {
  await kv.put(PM_THREAD_KEY(date), JSON.stringify(state), {
    expirationTtl: ttlSeconds
  });
}

export async function getPmThread(
  kv: KVNamespace,
  date: string
): Promise<PmThreadState | null> {
  const raw = await kv.get(PM_THREAD_KEY(date));
  if (!raw) return null;
  return JSON.parse(raw) as PmThreadState;
}

export async function appendReply(
  kv: KVNamespace,
  channel: string,
  threadTs: string,
  reply: StoredReply,
  ttlSeconds = DEFAULT_TTL
): Promise<void> {
  const key = REPLY_KEY(channel, threadTs);
  const existing = await kv.get(key);
  const replies: StoredReply[] = existing ? JSON.parse(existing) : [];
  replies.push(reply);
  await kv.put(key, JSON.stringify(replies), { expirationTtl: ttlSeconds });
}

export async function getReplies(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<StoredReply[]> {
  const raw = await kv.get(REPLY_KEY(channel, threadTs));
  if (!raw) return [];
  return JSON.parse(raw) as StoredReply[];
}

export async function addActiveThread(
  kv: KVNamespace,
  date: string,
  entry: ActiveThread,
  ttlSeconds = DEFAULT_TTL
): Promise<void> {
  const key = ACTIVE_THREADS_KEY(date);
  const existing = await kv.get(key);
  const threads: ActiveThread[] = existing ? JSON.parse(existing) : [];
  threads.push(entry);
  await kv.put(key, JSON.stringify(threads), { expirationTtl: ttlSeconds });
}

export async function getActiveThreads(
  kv: KVNamespace,
  date: string
): Promise<ActiveThread[]> {
  const raw = await kv.get(ACTIVE_THREADS_KEY(date));
  if (!raw) return [];
  return JSON.parse(raw) as ActiveThread[];
}

export async function savePendingAction(
  kv: KVNamespace,
  channel: string,
  ts: string,
  action: PendingNotionAction,
  ttlSeconds = DEFAULT_TTL
): Promise<void> {
  await kv.put(PENDING_ACTION_KEY(channel, ts), JSON.stringify(action), {
    expirationTtl: ttlSeconds
  });
}

export async function getPendingAction(
  kv: KVNamespace,
  channel: string,
  ts: string
): Promise<PendingNotionAction | null> {
  const raw = await kv.get(PENDING_ACTION_KEY(channel, ts));
  if (!raw) return null;
  return JSON.parse(raw) as PendingNotionAction;
}

export async function deletePendingAction(
  kv: KVNamespace,
  channel: string,
  ts: string
): Promise<void> {
  await kv.delete(PENDING_ACTION_KEY(channel, ts));
}

// ── Mention conversation history ────────────────────────────────────────────

export interface MentionMessage {
  role: "user" | "assistant";
  content: string;
}

const MENTION_HISTORY_TTL = 24 * 3600; // 24h
const MAX_HISTORY_TURNS = 10; // 直近5往復まで保持

export async function getMentionHistory(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<MentionMessage[]> {
  const raw = await kv.get(MENTION_HISTORY_KEY(channel, threadTs));
  if (!raw) return [];
  return JSON.parse(raw) as MentionMessage[];
}

export async function appendMentionHistory(
  kv: KVNamespace,
  channel: string,
  threadTs: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const key = MENTION_HISTORY_KEY(channel, threadTs);
  const existing = await kv.get(key);
  const history: MentionMessage[] = existing ? JSON.parse(existing) : [];

  history.push(
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage }
  );

  // 古い履歴を切り捨て
  const trimmed = history.slice(-MAX_HISTORY_TURNS);

  await kv.put(key, JSON.stringify(trimmed), {
    expirationTtl: MENTION_HISTORY_TTL
  });
}

// ── Pending project selection (for multi-candidate disambiguation) ───────

export interface PendingProjectSelection {
  newTask: {
    task_name: string;
    assignee: string;
    due: string;
    sp: number;
    status: string;
    sprintId?: string;
  };
  candidates: Array<{ id: string; name: string }>;
  requestedBy: string;
  requestedAt: string;
  fallbackProjectIds: string[];
}

const PROJECT_SELECTION_KEY = (channel: string, threadTs: string) =>
  `project-selection:${channel}:${threadTs}`;

const PROJECT_SELECTION_TTL = 3600; // 1 hour

export async function savePendingProjectSelection(
  kv: KVNamespace,
  channel: string,
  threadTs: string,
  selection: PendingProjectSelection
): Promise<void> {
  await kv.put(
    PROJECT_SELECTION_KEY(channel, threadTs),
    JSON.stringify(selection),
    { expirationTtl: PROJECT_SELECTION_TTL }
  );
}

export async function getPendingProjectSelection(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<PendingProjectSelection | null> {
  const raw = await kv.get(PROJECT_SELECTION_KEY(channel, threadTs));
  if (!raw) return null;
  return JSON.parse(raw) as PendingProjectSelection;
}

export async function deletePendingProjectSelection(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<void> {
  await kv.delete(PROJECT_SELECTION_KEY(channel, threadTs));
}

// ── Pending create-task thread reference ─────────────────────────────────
// Maps threadTs → confirmMsgTs so we can find the pending create_task action
// when the user asks for modifications in the same thread.

export interface PendingCreateRef {
  confirmMsgTs: string;
}

const PENDING_CREATE_REF_KEY = (channel: string, threadTs: string) =>
  `pending-create-ref:${channel}:${threadTs}`;

export async function savePendingCreateRef(
  kv: KVNamespace,
  channel: string,
  threadTs: string,
  ref: PendingCreateRef
): Promise<void> {
  await kv.put(
    PENDING_CREATE_REF_KEY(channel, threadTs),
    JSON.stringify(ref),
    { expirationTtl: DEFAULT_TTL }
  );
}

export async function getPendingCreateRef(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<PendingCreateRef | null> {
  const raw = await kv.get(PENDING_CREATE_REF_KEY(channel, threadTs));
  if (!raw) return null;
  return JSON.parse(raw) as PendingCreateRef;
}

export async function deletePendingCreateRef(
  kv: KVNamespace,
  channel: string,
  threadTs: string
): Promise<void> {
  await kv.delete(PENDING_CREATE_REF_KEY(channel, threadTs));
}

// ── Phone Reminder (☎️ reaction-based thread reminders) ─────────────────

export interface PhoneReminder {
  userId: string;
  channel: string;
  threadTs: string;
  createdAt: string;
  lastRemindedAt: string;
}

const PHONE_REMINDER_KEY = (userId: string, channel: string, threadTs: string) =>
  `phone-reminder:${userId}:${channel}:${threadTs}`;

const PHONE_REMINDER_TTL = 30 * 24 * 3600; // 30 days

export async function savePhoneReminder(
  kv: KVNamespace,
  userId: string,
  channel: string,
  threadTs: string,
  reminder: PhoneReminder
): Promise<void> {
  await kv.put(
    PHONE_REMINDER_KEY(userId, channel, threadTs),
    JSON.stringify(reminder),
    { expirationTtl: PHONE_REMINDER_TTL }
  );
}

export async function getPhoneReminder(
  kv: KVNamespace,
  userId: string,
  channel: string,
  threadTs: string
): Promise<PhoneReminder | null> {
  const raw = await kv.get(PHONE_REMINDER_KEY(userId, channel, threadTs));
  if (!raw) return null;
  return JSON.parse(raw) as PhoneReminder;
}

export async function deletePhoneReminder(
  kv: KVNamespace,
  userId: string,
  channel: string,
  threadTs: string
): Promise<void> {
  await kv.delete(PHONE_REMINDER_KEY(userId, channel, threadTs));
}

export async function listAllPhoneReminders(
  kv: KVNamespace
): Promise<PhoneReminder[]> {
  const reminders: PhoneReminder[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({
      prefix: "phone-reminder:",
      cursor
    });

    for (const key of result.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        reminders.push(JSON.parse(raw) as PhoneReminder);
      }
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return reminders;
}
