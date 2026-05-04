# notion-sprint-worker

Notion + Slack + Google Sheets + OpenAI LLM を連携した、Cloudflare Workers 上で動く Slack PMO ボット。
スプリントのタスク進捗管理・メンバー通知・PMレポート生成を自動化する。

---

## アーキテクチャ概要

- **Runtime**: Cloudflare Workers（cron 5本：5時 / 9時 / 9:10-50 / 10時 / 毎時）
- **状態保存**: Workers KV (`NOTIFY_CACHE`) で全状態管理（スレッド・リマインダ・スナップショット等）
- **Slack**: Events API + Interactions（HMAC-SHA256 検証）
- **LLM**: OpenAI `gpt-4.1-mini`（`/v1/responses` + Structured Output）
- **データソース**: Notion API 直叩き + Google Sheets（マスタースケジュール）

### 主なフロー

| 時刻 (JST) | フロー | 内容 |
|---|---|---|
| 05:00 | `runProgressSpSnapshot` | スプリントの進捗SPを KV に保存（消化SP計算用） |
| 09:00 | `runMorningFlow` | 各担当者へ進捗確認メッセージを LLM 生成 → Slack 投稿 |
| 09:10〜09:50 (10分毎) | `runReminderFlow` | 未返信メンバーへリマインド |
| 10:00 | `runEveningFlow` | 返信を集約 → PMレポート＋割り振り提案 |
| 毎時 :00/:15 | 複合 | ☎️ リマインド・PM未返信リマインド・EOD・cron 監視・catch-up |

加えて、☎️ リアクションでメッセージを DM に転送し、指定時刻にリマインドする機能あり。

---

## セットアップ

### 必要なもの

- Node.js 18+
- Cloudflare アカウント（Workers + KV のアクセス権）
- `.dev.vars`（環境変数。リポジトリには含まれていない。リポオーナーから別途受領）

### 手順

```bash
git clone https://github.com/kitagawakaede/notion_pmo.git
cd notion_pmo
npm install

# 受け取った .dev.vars をプロジェクト直下に配置（拡張子なし、先頭ドット）

npx wrangler login        # Cloudflare 認証
npx wrangler dev          # ローカル動作確認
```

`http://localhost:8787/health` にアクセスして `{"status":"ok",...}` が返れば起動成功。

### 本番デプロイ

```bash
npx wrangler deploy
```

→ 即時に `notion-sprint-worker.kaede-pmo.workers.dev` に反映される。

---

## ⚠️ 開発時の注意事項

### 本番環境を直接触る

- 本番運用中の Slack ボットです
- **`wrangler dev` でも本番の Slack / Notion / KV を触ります**（dev/prod 分離なし）
- 大きい変更を試すときは `.dev.vars` で `DRY_RUN=true` にすると、Slack 投稿・Notion 更新がスキップされる
- `wrangler deploy` は即本番反映なので、PR レビュー後の実行を推奨

### シークレット管理

- `.dev.vars` は `.gitignore` 済。**git に絶対 push しない**
- 万が一漏えいした場合はリポオーナーへ即連絡（トークンローテーション可能）

### Cloudflare Workers の制約

- Free プランの `ctx.waitUntil()` は **30秒で打ち切られる**
- LLM 呼び出し + Notion API + Slack 返信は 30秒を超えるため、`TransformStream` でストリーミングレスポンスを返して Worker を生存させるパターンを使うこと
- 詳細は [`CLAUDE.md`](./CLAUDE.md) 参照

### Slack API の罠

- `chat.postMessage` で `blocks` を指定すると `text` フィールドは画面に表示されない（通知プレビュー専用になる）
- `chatPostMessage()` in `src/slackBot.ts` が自動で text を section block として先頭挿入する

---

## ディレクトリ構成

```
src/
├── index.ts              # エントリポイント (fetch / scheduled handler)
├── config.ts             # 環境変数のパース
├── channelConfig.ts      # チャンネル別設定（per-channel onboarding）
├── workflow.ts           # KV 操作（スレッド状態・リマインダ・ハートビート）
├── slackEvents.ts        # Slack Events API ハンドラ（メンション・返信・リアクション）
├── slackInteractions.ts  # Slack ボタン・モーダル ハンドラ
├── slackBot.ts           # Slack Bot Token 経由の API 呼び出し
├── slack.ts              # Slack Webhook 経由の API 呼び出し（旧式）
├── notionApi.ts          # Notion DB 読み取り
├── notionWriter.ts       # Notion ページ作成・更新
├── notionMcp.ts          # Notion MCP server 経由のフェッチ
├── llmAnalyzer.ts        # OpenAI で分析・メッセージ生成・返信解釈
├── schema.ts             # Zod + JSON Schema（LLM Structured Output 用）
├── memberApi.ts          # Notion メンバー DB から取得
├── sheetsApi.ts          # Google Sheets API（マスタースケジュール）
├── onboarding.ts         # チャンネル招待時の setup モーダル
├── dedupe.ts             # 重複排除（payload ハッシュ + KV TTL）
└── retry.ts              # withRetry（4xx silent / 5xx リトライ）

docs/plans/               # 設計ドキュメント
task/pmo-agent-spec.md    # PMOエージェント仕様書 v1.0
CLAUDE.md                 # 開発ルール（必読）
```

---

## ドキュメント

- [`CLAUDE.md`](./CLAUDE.md) — 開発時の必須ルール（Cloudflare 30秒制限・Slack blocks・Notion API・KV キー命名 など）
- [`docs/plans/morning-evening-flow.md`](./docs/plans/morning-evening-flow.md) — 朝夜フローの設計
- [`docs/plans/2026-03-06-channel-onboarding-design.md`](./docs/plans/2026-03-06-channel-onboarding-design.md) — チャンネルオンボーディング設計
- [`docs/plans/2026-03-11-task-creation-enhancements.md`](./docs/plans/2026-03-11-task-creation-enhancements.md) — タスク起票機能の改善
- [`task/pmo-agent-spec.md`](./task/pmo-agent-spec.md) — PMOエージェント仕様書

---

## 管理用 HTTP エンドポイント

`https://notion-sprint-worker.kaede-pmo.workers.dev` 配下:

| Path | 用途 |
|---|---|
| `GET /health` | ヘルスチェック・cron ハートビート |
| `POST /slack/events` | Slack Events API 受信 |
| `POST /slack/interactions` | Slack ボタンクリック等 |
| `GET /pmo/morning` | 朝フロー手動実行 |
| `GET /pmo/evening` | 夜フロー手動実行 |
| `GET /pmo/progress-snapshot` | 進捗SPスナップショット手動実行 |
| `GET /pmo/pm-debug` | PMスレッド状態の確認 |
| `GET /pmo/pm-dismiss` | PMスレッドを processed に変更（リマインド停止） |

---

## トラブルシュート

### cron が動いていない

`/health` で `crons` のハートビート時刻を確認。watchdog が PMユーザーに DM で警告を出す仕組みあり（[`runCronHealthCheck`](./src/index.ts)）。手動実行は上記エンドポイントから。

### Slack に投稿されない

- `SLACK_BOT_TOKEN` の権限確認（`chat:write` 必須）
- ボットが対象チャンネルに招待されているか
- `DRY_RUN=true` になっていないか

### Notion 更新が失敗する

- Integration がデータベースに接続されているか（Notion 側でデータベース → Connections）
- 担当者名が `fetchNotionUserMap()` で解決できるか（ログに warn が出る）
