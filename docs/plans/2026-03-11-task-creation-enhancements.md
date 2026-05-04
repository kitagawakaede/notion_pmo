# タスク起票時の3点修正 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** タスク起票フローを改善: カテゴリ自動設定、修正ボタン廃止→スレッド返信修正、スレURL+関連資料URLのNotion添付

**Architecture:** LLMレスポンスに`relevant_urls`を追加し、起票確定時にスレッドURL・関連URLをNotionページ本文に追記する。ボタンは承認・キャンセルの2つに減らし、修正はスレッド返信で受け付ける。

**Tech Stack:** TypeScript, Cloudflare Workers, Notion API, Slack API, OpenAI LLM

---

### Task 1: カテゴリプロパティを起票時に設定

**Files:**
- Modify: `src/slackEvents.ts:109-113` (executeTaskCreation の properties 構築部分)

**Step 1: executeTaskCreation にカテゴリプロパティを追加**

`src/slackEvents.ts` の `executeTaskCreation` 関数内、properties 構築部分に1行追加:

```typescript
const properties: Record<string, unknown> = {
  名前: { title: [{ text: { content: task.task_name } }] },
  期限: { date: { start: task.due } },
  SP: { number: task.sp },
  ステータス: { status: { name: task.status } },
  カテゴリ: { select: { name: "タスク" } }
};
```

**Step 2: デプロイして動作確認**

Run: `npx wrangler deploy`

---

### Task 2: 修正ボタン廃止 → 承認・キャンセルの2ボタン + スレッド返信案内

**Files:**
- Modify: `src/slackInteractions.ts:60-86` (buildApprovalButtons)
- Modify: `src/slackInteractions.ts:293-305` (task_action_modify ハンドラのルーティング)
- Modify: `src/slackEvents.ts` (確認メッセージにスレッド返信案内テキストを追加)

**Step 1: buildApprovalButtons から修正ボタンを削除**

`src/slackInteractions.ts` の `buildApprovalButtons` を修正:

```typescript
export function buildApprovalButtons(actionIdPrefix: string): unknown[] {
  return [
    {
      type: "actions",
      block_id: `${actionIdPrefix}_buttons`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 承認", emoji: true },
          style: "primary",
          action_id: `${actionIdPrefix}_approve`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ キャンセル", emoji: true },
          style: "danger",
          action_id: `${actionIdPrefix}_cancel`
        }
      ]
    }
  ];
}
```

**Step 2: task_action_modify のルーティングを削除**

`src/slackInteractions.ts` のハンドラルーティング部分で `task_action_modify` の分岐を削除:

```typescript
// 削除: } else if (actionId === "task_action_modify") {
// 削除:   handler = handleTaskModifyButton(env, payload);
```

注意: `handleTaskModifyButton` 関数自体は残しても良い（dead code cleanup は別途）。

**Step 3: 確認メッセージにスレッド返信での修正案内を追加**

`src/slackEvents.ts` の create_task 確認メッセージ部分。2箇所修正:

(a) `needsDescriptionHearing = false` のケース（ボタン付き確認メッセージ、約行977付近）:

現在:
```typescript
const confirmMsg = await chatPostMessage(
  config.slackBotToken,
  channel,
  `${userMention}${responseText}`,
  buildApprovalButtons("task_action"),
  threadTs
);
```

修正後:
```typescript
const modifyHint = "\n\n_修正したい場合は、修正内容をこのスレッドに返信してください_";
const confirmMsg = await chatPostMessage(
  config.slackBotToken,
  channel,
  `${userMention}${responseText}${modifyHint}`,
  buildApprovalButtons("task_action"),
  threadTs
);
```

(b) update intent の確認メッセージ（約行1028付近）も同様に修正:

```typescript
const modifyHint = "\n\n_修正したい場合は、修正内容をこのスレッドに返信してください_";
const confirmMsg = await chatPostMessage(
  config.slackBotToken,
  channel,
  `${userMention}${confirmText}${modifyHint}`,
  buildApprovalButtons("task_action"),
  threadTs
);
```

**Step 4: デプロイ**

Run: `npx wrangler deploy`

---

### Task 3: LLMレスポンスに relevant_urls を追加

**Files:**
- Modify: `src/schema.ts` (MentionIntent スキーマに relevant_urls を追加)
- Modify: `src/llmAnalyzer.ts` (interpretMention のシステムプロンプトに指示を追加)

**Step 1: MentionIntent スキーマに relevant_urls を追加**

`src/schema.ts` の `mentionIntentSchema` に追加:

```typescript
export const mentionIntentSchema = z.object({
  intent: z.enum(["query", "update", "create_task", "unknown"]),
  response_text: z.string(),
  actions: z.array(
    z.object({
      action: z.enum(["update_assignee", "update_due", "update_sp", "update_status", "update_sprint", "update_project"]),
      page_id: z.string(),
      task_name: z.string(),
      new_value: z.string()
    })
  ),
  new_tasks: z.array(
    z.object({
      task_name: z.string(),
      assignee: z.string(),
      due: z.string(),
      sp: z.number(),
      status: z.string(),
      project: z.string().nullable(),
      description: z.string().nullable(),
      sprint: z.string().nullable()
    })
  ),
  relevant_urls: z.array(z.string()).default([])
});
```

同じく `mentionIntentJsonSchema` にも追加:

```typescript
export const mentionIntentJsonSchema = {
  // ... 既存部分は同じ ...
  schema: {
    // ... 既存プロパティに追加 ...
    properties: {
      // ... 既存のintent, response_text, actions, new_tasks ...
      relevant_urls: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["intent", "response_text", "actions", "new_tasks", "relevant_urls"]
  }
};
```

**Step 2: LLMプロンプトに関連URL抽出の指示を追加**

`src/llmAnalyzer.ts` の `interpretMention` のシステムプロンプト末尾（`■ フォーマットルール` の後）に追加:

```
■ 関連URLの抽出（relevant_urls）:
- intent が "create_task" の場合、thread_context および channel_context 内のメッセージに含まれるURLを分析する
- タスクの内容に関連するURLのみを relevant_urls に含める（設計書、仕様書、参考資料、関連ページなど）
- 関連性の判断基準: タスクの背景・目的・実装に直接関わるURLを優先する
- Bot操作指示のみのメッセージに含まれるURL、Slack内部リンク（slack.com）、明らかに無関係なURLは除外する
- create_task 以外の intent では空配列 [] を返す
```

**Step 3: デプロイ**

Run: `npx wrangler deploy`

---

### Task 4: 起票確定時にスレッドURL + 関連URLをNotionページ本文に追記

**Files:**
- Modify: `src/notionWriter.ts` (appendPageContent を拡張、またはスレURL+関連URL追記用の関数を追加)
- Modify: `src/slackEvents.ts` (確認メッセージ生成時に relevant_urls を保存、起票確定時にNotionページに追記)
- Modify: `src/slackInteractions.ts` (handleTaskActionButton で追記処理を呼び出す)

**Step 1: appendPageContent を拡張してリンクブロックも追記できるようにする**

`src/notionWriter.ts` に新関数を追加:

```typescript
export async function appendLinksToPage(
  token: string,
  pageId: string,
  threadUrl: string,
  relevantUrls: string[]
): Promise<void> {
  const children: unknown[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Slackスレッド" } }]
      }
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: threadUrl, link: { url: threadUrl } } }]
      }
    }
  ];

  if (relevantUrls.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "関連資料" } }]
      }
    });
    for (const url of relevantUrls) {
      children.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: url, link: { url } } }]
        }
      });
    }
  }

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
          body: JSON.stringify({ children })
        }
      );
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Notion appendLinksToPage error [${pageId}]: ${res.status} ${detail}`);
      }
    },
    { label: `Notion appendLinksToPage ${pageId}` }
  );
}
```

**Step 2: タスク作成確認時に relevant_urls を pending action に保存**

`src/slackEvents.ts` の create_task 確認メッセージ生成部分で、`result.relevant_urls` を保存する。

taskActions の new_value JSON に `relevantUrls` を含める:

```typescript
taskActions.push({
  action: "create_task",
  page_id: "",
  task_name: newTask.task_name,
  new_value: JSON.stringify({
    ...newTask,
    ...(resolvedSprintId ? { sprintId: resolvedSprintId } : {}),
    sprintName: newTask.sprint,
    projectIds: resolvedProjectIds,
    ...(taskDescription ? { description: taskDescription } : {}),
    relevantUrls: result.relevant_urls ?? []
  })
});
```

また、pending action に `threadTs` と `channel` を保存（スレッドURL生成用）。これは既に `threadTs` が保存されている（`savePendingAction` の引数）。

**Step 3: handleTaskActionButton でNotion追記処理を呼び出す**

`src/slackInteractions.ts` の `handleTaskActionButton` 内、タスク作成成功後にスレッドURL + 関連URLを追記:

import 追加:
```typescript
import { appendLinksToPage } from "./notionWriter";
```

タスク作成ループ内（`executeTaskCreation` の後、`appendPageContent` と同じ位置）:

```typescript
// Append thread URL and relevant URLs
if (result.pageId) {
  const slackThreadUrl = `https://slack.com/archives/${channel}/p${(threadTs ?? messageTs).replace(".", "")}`;
  const relevantUrls: string[] = newTask.relevantUrls ?? [];
  try {
    await appendLinksToPage(config.notionToken, result.pageId, slackThreadUrl, relevantUrls);
  } catch (err) {
    console.warn(`Failed to append links: ${(err as Error).message}`);
  }
}
```

newTask の型にも `relevantUrls` を追加（JSON.parse 部分）:

```typescript
const newTask = JSON.parse(createAction.new_value) as NewTask & {
  sprintId?: string;
  projectIds?: string[];
  project?: string | null;
  description?: string;
  relevantUrls?: string[];
};
```

**Step 4: デプロイ**

Run: `npx wrangler deploy`

---

## 変更ファイルまとめ

| ファイル | 変更内容 |
|---------|---------|
| `src/slackEvents.ts` | カテゴリプロパティ追加、確認メッセージに修正案内追加、relevant_urls を pending action に保存 |
| `src/slackInteractions.ts` | 修正ボタン削除、modify ルーティング削除、リンク追記処理追加 |
| `src/notionWriter.ts` | `appendLinksToPage()` 関数追加 |
| `src/schema.ts` | MentionIntent に `relevant_urls` フィールド追加 |
| `src/llmAnalyzer.ts` | 関連URL抽出のプロンプト指示追加 |
