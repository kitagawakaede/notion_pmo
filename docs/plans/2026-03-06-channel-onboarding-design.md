# Channel Onboarding & Per-Channel Config Design

## Overview

ボットがどのチャンネルでも動作できるように、チャンネル参加時の初回ヒアリングでプロジェクト設定（Notion DB URL、メンバーマッピング、PM）を収集し、KV に保存する。

## Data Model

### ChannelConfig (KV: `channel-config:{channelId}`)

```typescript
interface ChannelConfig {
  taskDbUrl: string;
  sprintDbUrl: string;
  memberDbUrl: string;
  referenceDbUrl?: string;
  pmUserId: string;           // Slack User ID
  memberMap: Record<string, string>;  // { "U12345": "Notion member name" }
  projectName?: string;
  googleSheetsId?: string;
  googleSheetsRange?: string;
  registeredAt: string;       // ISO 8601
  registeredBy: string;       // Slack User ID
}
```

### KV Keys

| Key | Content | TTL |
|-----|---------|-----|
| `channel-config:{channelId}` | ChannelConfig JSON | permanent |
| `channel-config-list` | registered channel ID array | permanent |

## Onboarding Flow

1. Bot added to channel -> `member_joined_channel` event detected
2. Bot posts greeting with [Setup] button
3. Button click -> Slack modal (`views.open`) with fields:
   - Task DB URL (required)
   - Sprint DB URL (required)
   - Member DB URL (required)
   - Project name (optional)
   - Google Sheets ID (optional)
4. Modal submit -> validation:
   - Extract Notion ID from each URL
   - Verify API access to each DB
   - On failure: modal error "Cannot access DB. Share Notion Integration."
5. Validation passed -> auto member matching:
   - Fetch names from Notion member DB
   - Fetch channel members via `conversations.members`
   - Get `real_name` / `display_name` via `users.info`
   - Partial match Slack names to Notion names
6. Post match results to channel with [Confirm] [Edit] buttons + PM select dropdown
7. Confirm -> save to KV, post "Setup complete!"
   Edit -> accept corrections, re-match

## Integration with Existing Code

### resolveConfig()

```typescript
async function resolveConfig(env: Bindings, channelId: string): Promise<AppConfig> {
  const base = getConfig(env);
  const channelConfig = await getChannelConfig(env.NOTIFY_CACHE, channelId);
  if (!channelConfig) return base;
  return {
    ...base,
    taskDbId: extractNotionIdFromUrl(channelConfig.taskDbUrl) ?? base.taskDbId,
    sprintDbId: extractNotionIdFromUrl(channelConfig.sprintDbUrl) ?? base.sprintDbId,
    memberDbId: extractNotionIdFromUrl(channelConfig.memberDbUrl) ?? base.memberDbId,
    referenceDbId: channelConfig.referenceDbUrl
      ? extractNotionIdFromUrl(channelConfig.referenceDbUrl)
      : base.referenceDbId,
    slackPmUserId: channelConfig.pmUserId,
    memberSlackMap: invertMap(channelConfig.memberMap),
    googleSheetsId: channelConfig.googleSheetsId ?? base.googleSheetsId,
  };
}
```

### File Changes

| File | Change |
|------|--------|
| `src/channelConfig.ts` (new) | KV CRUD, `resolveConfig` |
| `src/onboarding.ts` (new) | Greeting, modal, validation, member matching, confirm flow |
| `src/slackEvents.ts` | Add `member_joined_channel` handler; use `resolveConfig` in mention handling |
| `src/slackInteractions.ts` | Add `view_submission` handler; setup button, confirm/edit buttons, PM select |
| `src/index.ts` | Cron loops over `listAllChannelConfigs()` |
| `src/config.ts` | Relax `SPRINT_DB_URL` / `TASK_DB_URL` required check |
| `src/slackBot.ts` | Add `views.open`, `conversations.members`, `users.info` API calls |

### Settings Update

`@bot settings` mention triggers modal re-open with current values pre-filled.

## Error Handling

| Case | Response |
|------|----------|
| Invalid Notion URL | Modal error |
| DB inaccessible (Integration not shared) | Modal error with instruction |
| Empty member DB | Warning, continue |
| All members matched | Proceed to confirm |
| Partial match | Show unmatched with manual fix option |
| No matches | Prompt manual input |
| Bot re-added to configured channel | "Already configured. Use @bot settings to change." |
| Unregistered channel mention | Fall back to global env config (backward compatible) |

## Slack App Settings

- Add `member_joined_channel` to Bot Events in Event Subscriptions
