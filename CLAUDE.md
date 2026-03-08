# Development Rules — notion-sprint-worker

Cloudflare Worker + Slack Bot + Notion API + OpenAI LLM のプロジェクト。
実装時に必ず守るルールを記載する。

## 1. Cloudflare Workers の制約

### waitUntil() を長時間処理に使わない
- Free プランの `ctx.waitUntil()` は **30秒で打ち切られる**
- LLM 呼び出し + Notion API + Slack 返信は 30秒を超えることが多い
- **正しいパターン**: `TransformStream` でストリーミングレスポンスを返し、処理完了まで Worker を生存させる
- 参考実装: `src/slackEvents.ts` の `respondAndProcess()`

```ts
// NG — 30秒で処理がキャンセルされる
ctx.waitUntil(handleMention(env, event));
return new Response("ok");

// OK — Worker が処理完了まで生存する
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
const task = (async () => {
  try { await handleMention(env, event); }
  finally { await writer.write(new TextEncoder().encode("ok")); await writer.close(); }
})();
if (ctx) ctx.waitUntil(task);
return new Response(readable, { status: 200 });
```

### cron トリガーは最大 5 個
- Cloudflare Free プランの上限は 5 cron triggers
- 新しい定期処理を追加する場合は既存の cron に JST 時間帯ゲーティングで相乗りさせる

## 2. Slack API

### blocks がある場合 text は表示されない
- `chat.postMessage` に `blocks` を渡すと、`text` フィールドは通知プレビュー専用になり画面に表示されない
- テキストを表示したい場合は `section` ブロックとして `blocks` 配列に含めること
- `chatPostMessage()` in `src/slackBot.ts` が自動で text を section block として先頭に挿入するようになっている

### Interactivity URL の設定
- ボタン等のインタラクティブコンポーネントを使う場合、Slack App Settings の Interactivity & Shortcuts で Request URL を設定する必要がある
- URL: `https://notion-sprint-worker.kaede-pmo.workers.dev/slack/interactions`

## 3. Notion API アクション

### 全アクションを有効にすること
- `update_assignee`, `update_due`, `update_sp`, `update_status`, `update_sprint`, `create_task` は全て実際に Notion を更新する
- `[NOT ACTIVE]` や `（未有効）` のようなガードを入れない。実装したら有効にすること
- `notionWriter.ts` の `updateTaskPage()` で担当者変更は `properties["担当者"]` に people を設定する
- ユーザーマッピングは `fetchNotionUserMap()` で取得する

### ユーザー名マッピング
- LLM が返す `new_value` は日本語の担当者名（例: 「古鉄朋也 / Tomoya Kotetsu」）
- `fetchNotionUserMap()` で Notion ユーザー ID に変換してから API を呼ぶ
- マッチしない場合は warn ログを出し、ユーザーに「Notion ユーザー未検出」と伝える

## 4. エラーハンドリング


### 想定内のエラーにログを出さない
- Notion API の 4xx エラー（アクセス権限なし等）は想定内 — warn/error ログを出さない
- `withRetry()` はデフォルトで 4xx を silent にしている
- キャパシティ DB が存在しない場合など、データが取れなくても正常動作すること
- LLM プロンプトでも「データが null なら登録を促すな、あるデータだけで回答しろ」と指示済み

### .catch(() => fallback) パターン
- 補助データの取得は `.catch(() => [])` or `.catch(() => null)` で失敗を許容する
- メインのスプリントデータ取得が失敗した場合のみユーザーにエラーメッセージを返す

## 5. KV ストレージ

- バインディング名: `NOTIFY_CACHE`
- キーの命名規則: `{機能名}:{識別子}` (例: `phone-reminder:{userId}:{channel}:{threadTs}`)
- TTL はデフォルト 7 日間 (`DEFAULT_TTL = 7 * 24 * 3600`)
- Phone reminder は 30 日間

## 6. デプロイ

- 修正後は都度デプロイする（確認不要）
- コマンド: `npx wrangler deploy`
- コミットは明示的に指示があった場合のみ行う
