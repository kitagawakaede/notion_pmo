# Project Overview
- Purpose: Cloudflare Worker (TypeScript) that pulls sprint data from Notion via the hosted Notion MCP through OpenAI Responses API and posts formatted reports to Slack on a schedule.
- Runtime: Cloudflare Workers with Cron Triggers; KV used for dedupe cache.
- Core pieces: src/index.ts (fetch/scheduled handlers), src/config.ts (env parsing), src/notionMcp.ts (LLM + MCP call), src/slack.ts (payload builder/post), src/schema.ts (Zod validation + JSON schema), src/dedupe.ts (hash + KV dedupe).
- Config: environment variables/Secrets for OpenAI key, Notion OAuth token, Slack webhooks, sprint DB reference, notify properties; defaults stored in wrangler.toml vars. KV binding NOTIFY_CACHE required.
- Scheduling: wrangler.toml cron default `0 0 * * *` (UTC).
- Dependency highlights: wrangler, typescript, zod; workers-types for typing.