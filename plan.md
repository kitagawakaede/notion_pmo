# 実装計画: 提案後のメンション修正対応

## 問題分析

### 現状のメッセージルーティング（slackEvents.ts L1367-1390）

```
message イベント（スレッド内返信）
  └─ hasBotMention = /<@[A-Z0-9]+>/.test(rawText)
      ├─ true  → 何もしない（app_mention イベントに任せる）
      └─ false → pendingCreateRef チェック → handleMention or handleAssigneeReply
```

### 根本原因

**`hasBotMention` のチェックが ANY @メンション にマッチしている（ボット固有IDではない）。**

以下のシナリオで問題が発生する：

1. ユーザーがタスク作成を依頼 → ボットが提案
2. ユーザーが「担当を `<@U_TANAKA>` に変更して」とスレッド返信（ボット宛ではなく、別ユーザーをメンション）
3. `hasBotMention = true`（`<@U_TANAKA>` にマッチ）→ **メッセージ完全スキップ**
4. `app_mention` イベントは発火しない（ボットはメンションされていない）
5. → **修正リクエストが消失する**

同様に、ボットをメンションせずにスレッド返信する場合（「期限変更して」等の単純テキスト）は `pendingCreateRef` 経由で `handleMention` に到達するが、他ユーザーメンション付きだとドロップされる。

### 副次的な問題

1. **✅リアクション後に `pendingCreateRef` が未削除**: `handleReactionAdded` で `pendingAction` は削除されるが、`pendingCreateRef` は残る。次回のスレッド返信で stale ref を検出→クリーンアップ→fresh 処理されるので壊れはしないが、無駄なKVアクセスが発生。

2. **ボット自身のメンション判定にボットUserIDを使っていない**: 現行はANYメンション判定のため、上記の問題が起きる。

---

## 実装内容

### 変更1: ボットUserIDの取得と正確なメンション判定（slackEvents.ts）

**対象**: `handleSlackEvents` 関数（L1280-1393）

Slack Events API の `authorizations` フィールドからボットのUserIDを取得し、`message` イベントのルーティングで正確な判定に使う。

```typescript
// payload から bot user ID を取得
const authorizations = payload.authorizations as Array<{ user_id: string }> | undefined;
const botUserId = authorizations?.[0]?.user_id;
```

`message` イベントのルーティングを以下に変更:

```typescript
if (eventType === "message" && !botId && !subtype) {
  const threadTs = event.thread_ts as string | undefined;
  const channel = event.channel as string | undefined;

  if (channel && threadTs) {
    const rawText = (event.text as string) ?? "";
    // ボット自身へのメンションかどうかを正確に判定
    const isBotMentioned = botUserId
      ? rawText.includes(`<@${botUserId}>`)
      : /<@[A-Z0-9]+>/.test(rawText); // fallback: 従来の挙動

    if (!isBotMentioned) {
      await bg((async () => {
        const handled = await handleProjectSelectionReply(env, event);
        if (!handled) {
          const createRef = await getPendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
          if (createRef) {
            await handleMention(env, event);
          } else {
            await handleAssigneeReply(env, event);
            await handlePmReply(env, event);
          }
        }
      })());
    }
    // isBotMentioned === true → app_mention ハンドラに任せる（重複処理防止）
  }
}
```

**効果**: `<@他ユーザー>` のメンション付き返信がドロップされなくなる。ボット宛メンションのみ `app_mention` に委譲。

### 変更2: ✅実行後の `pendingCreateRef` クリーンアップ（slackEvents.ts）

**対象**: `handleReactionAdded` 関数（L949-1126）

`create_task` アクション実行後、および `update` アクション実行後に、関連する `pendingCreateRef` を削除する。

方法: リアクションが付いたメッセージの `thread_ts` を取得し、`pendingCreateRef` を削除。
Slack API の `conversations.replies` で当該メッセージの `thread_ts` を取得できるが、APIコスト削減のため、`PendingNotionAction` に `threadTs` フィールドを追加して保存時に記録する。

```typescript
// PendingNotionAction に threadTs を追加
export interface PendingNotionAction {
  actions: Array<{...}>;
  requestedBy: string;
  requestedAt: string;
  threadTs?: string;  // ← 追加
}
```

`handleMention` でアクション保存時:
```typescript
await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
  actions: taskActions,
  requestedBy: userId,
  requestedAt: new Date().toISOString(),
  threadTs  // ← 追加
});
```

`handleReactionAdded` でアクション実行後:
```typescript
// 実行後のクリーンアップ
await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
if (pending.threadTs) {
  await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
}
```

### 変更3: スレッド内のペンディングアクション修正への対応強化（slackEvents.ts）

**対象**: `handleSlackEvents` の `message` イベントルーティング

ボットがメンションされている場合でも、同一スレッドにペンディングアクションがある場合は、`app_mention` と `message` の両方で `handleMention` が呼ばれる二重処理を防ぎつつ、確実にルーティングする。

ただし、ボットがメンションされている場合は `app_mention` イベントが確実に発火するため、`message` ハンドラからは処理しない（変更1で十分対応できる）。

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/slackEvents.ts` | message イベントルーティング修正、pendingCreateRef クリーンアップ、PendingAction に threadTs 追加 |
| `src/workflow.ts` | `PendingNotionAction` インターフェースに `threadTs` フィールド追加 |

---

## テスト観点

| シナリオ | 期待動作 |
|---|---|
| ボット提案後、スレッドで `@他ユーザー` 付きで修正依頼 | `handleMention` に到達し、修正が反映される |
| ボット提案後、スレッドでテキストのみで修正依頼 | `pendingCreateRef` 経由で `handleMention` に到達（既存動作、変更なし） |
| ボット提案後、スレッドで `@ボット` 付きで修正依頼 | `app_mention` 経由で `handleMention` に到達（既存動作、変更なし） |
| ✅リアクション後の同スレッド返信 | stale `pendingCreateRef` がなく、fresh 処理される |
| プロジェクト選択待ちスレッドでの番号返信 | `handleProjectSelectionReply` が正常動作（既存動作、変更なし） |
