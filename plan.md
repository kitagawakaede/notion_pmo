# 実装完了: 提案後のメンション修正対応 + スプリント制御

## 問題分析

### 問題1: `hasBotMention` 判定が全 @メンションにマッチ

```
message イベント（スレッド内返信）
  └─ hasBotMention = /<@[A-Z0-9]+>/.test(rawText)
      ├─ true  → 何もしない（app_mention イベントに任せる）
      └─ false → pendingCreateRef チェック → handleMention or handleAssigneeReply
```

`/<@[A-Z0-9]+>/` が ANY @メンションにマッチするため、「担当を @田中 に変更して」のような返信がドロップされる。

### 問題2: スプリントがハードコードされている

`handleMention` 内のタスク作成で `sprintId: summary.sprint.id` が常にセットされ、LLMがスプリント制御できない。
バックログとしての起票も不可能。

### 問題3: ✅実行後に `pendingCreateRef` が未削除

`handleReactionAdded` で `pendingAction` は削除されるが `pendingCreateRef` は残り、stale ref が発生。

---

## 実装内容

### 変更1: `new_tasks` スキーマに `sprint` フィールド追加（schema.ts）

- Zod スキーマ: `sprint: z.string().nullable()` を追加
- JSON Schema: `sprint: { type: ["string", "null"] }` を追加
- LLMが `sprint` の有無を制御可能に

### 変更2: LLM プロンプトに sprint 制御の説明追加（llmAnalyzer.ts）

- `create_task` セクション: sprint フィールドの説明（available_sprints から名前指定、null = バックログ）
- 保留中タスク修正セクション: sprint 修正ルール（「スプリント外して」→ null、「現スプリントに追加」→ スプリント名）
- `pendingCreateTasks` パラメータ型に `sprint` を追加

### 変更3: sprintId ハードコード削除 + バックログ対応（slackEvents.ts）

- `sprintId: summary.sprint.id` のハードコードを削除
- LLM の `newTask.sprint` から `allSprints` を名前マッチして `sprintId` を解決
- `sprint` が null → `sprintId` なし（バックログとして起票）
- 確認メッセージにスプリント表示を追加（`・スプリント: {名前} or バックログ`）
- `new_value` に `sprintName` を保存（修正時の引き継ぎ用）

### 変更4: ボットUserIDの正確な判定（slackEvents.ts）

- `payload.authorizations[0].user_id` からボットUserIDを取得
- `isBotMentioned` 判定を `rawText.includes(<@${botUserId}>)` に変更
- フォールバック: `authorizations` がない場合は従来の ANY メンション判定

### 変更5: `pendingCreateRef` クリーンアップ（workflow.ts + slackEvents.ts）

- `PendingNotionAction` に `threadTs?: string` フィールドを追加
- `savePendingAction` の全呼び出しに `threadTs` を追加（handleMention create_task x2, update x1, handleProjectSelectionReply x1）
- `handleReactionAdded` の create_task / update 実行後に `deletePendingCreateRef(channel, pending.threadTs)` を追加

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/schema.ts` | `mentionIntentSchema` の `new_tasks` に `sprint` フィールド (nullable) 追加 |
| `src/llmAnalyzer.ts` | システムプロンプトに sprint 制御説明追加、`pendingCreateTasks` 型に `sprint` 追加 |
| `src/slackEvents.ts` | sprintId ハードコード削除、hasBotMention 修正、pendingCreateRef クリーンアップ |
| `src/workflow.ts` | `PendingNotionAction` に `threadTs` フィールド追加 |

---

## テスト観点

| シナリオ | 期待動作 |
|---|---|
| タスク作成時「スプリントはまだ設定しないで」 | sprint=null → バックログとして起票 |
| タスク作成時「現スプリントに入れて」 | sprint=スプリント名 → スプリント紐付きで起票 |
| 提案後「スプリント外して」と修正 | pending タスクの sprint が null に更新される |
| 提案後「担当を @田中 に変更して」（ボット未メンション） | `isBotMentioned=false` → pendingCreateRef 経由で handleMention に到達 |
| 提案後「@ボット 期限を変更して」 | `app_mention` 経由で handleMention に到達（既存動作） |
| ✅リアクション後の同スレッド返信 | stale `pendingCreateRef` がなく fresh 処理 |
| プロジェクト選択待ちスレッドでの番号返信 | `handleProjectSelectionReply` が正常動作（既存動作） |
