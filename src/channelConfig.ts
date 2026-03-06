import { extractNotionIdFromUrl, type AppConfig, type Bindings, getConfig } from "./config";

export interface ChannelConfig {
  taskDbUrl: string;
  sprintDbUrl: string;
  memberDbUrl: string;
  referenceDbUrl?: string;
  pmUserId: string;
  memberMap: Record<string, string>; // Slack User ID -> Notion member name
  projectName?: string;
  googleSheetsId?: string;
  googleSheetsRange?: string;
  registeredAt: string;
  registeredBy: string;
}

const CHANNEL_CONFIG_KEY = (channelId: string) => `channel-config:${channelId}`;
const CHANNEL_LIST_KEY = "channel-config-list";

export async function getChannelConfig(
  kv: KVNamespace,
  channelId: string
): Promise<ChannelConfig | null> {
  const raw = await kv.get(CHANNEL_CONFIG_KEY(channelId));
  if (!raw) return null;
  return JSON.parse(raw) as ChannelConfig;
}

export async function saveChannelConfig(
  kv: KVNamespace,
  channelId: string,
  config: ChannelConfig
): Promise<void> {
  await kv.put(CHANNEL_CONFIG_KEY(channelId), JSON.stringify(config));
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  const list: string[] = listRaw ? JSON.parse(listRaw) : [];
  if (!list.includes(channelId)) {
    list.push(channelId);
    await kv.put(CHANNEL_LIST_KEY, JSON.stringify(list));
  }
}

export async function deleteChannelConfig(
  kv: KVNamespace,
  channelId: string
): Promise<void> {
  await kv.delete(CHANNEL_CONFIG_KEY(channelId));
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  if (listRaw) {
    const list: string[] = JSON.parse(listRaw);
    const filtered = list.filter((id) => id !== channelId);
    await kv.put(CHANNEL_LIST_KEY, JSON.stringify(filtered));
  }
}

export async function listAllChannelConfigs(
  kv: KVNamespace
): Promise<Array<{ channelId: string; config: ChannelConfig }>> {
  const listRaw = await kv.get(CHANNEL_LIST_KEY);
  if (!listRaw) return [];
  const list: string[] = JSON.parse(listRaw);
  const results: Array<{ channelId: string; config: ChannelConfig }> = [];
  for (const channelId of list) {
    const config = await getChannelConfig(kv, channelId);
    if (config) results.push({ channelId, config });
  }
  return results;
}

function invertMap(map: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    result[value] = key;
  }
  return result;
}

export async function resolveConfig(
  env: Bindings,
  channelId: string
): Promise<AppConfig> {
  const base = getConfig(env);
  const channelCfg = await getChannelConfig(env.NOTIFY_CACHE, channelId);
  if (!channelCfg) return base;

  return {
    ...base,
    taskDbId: extractNotionIdFromUrl(channelCfg.taskDbUrl) ?? base.taskDbId,
    taskDbUrl: channelCfg.taskDbUrl,
    sprintDbId: extractNotionIdFromUrl(channelCfg.sprintDbUrl) ?? base.sprintDbId,
    sprintDbUrl: channelCfg.sprintDbUrl,
    memberDbId: extractNotionIdFromUrl(channelCfg.memberDbUrl) ?? base.memberDbId,
    referenceDbId: channelCfg.referenceDbUrl
      ? extractNotionIdFromUrl(channelCfg.referenceDbUrl)
      : base.referenceDbId,
    slackPmUserId: channelCfg.pmUserId,
    memberSlackMap: invertMap(channelCfg.memberMap),
    googleSheetsId: channelCfg.googleSheetsId ?? base.googleSheetsId,
    googleSheetsRange: channelCfg.googleSheetsRange ?? base.googleSheetsRange,
  };
}
