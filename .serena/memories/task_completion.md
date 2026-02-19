# Task Completion Checklist
- Ensure required secrets/vars exist: OPENAI_API_KEY, NOTION_OAUTH_ACCESS_TOKEN, SLACK_WEBHOOK_URL, SPRINT_DB_URL or SPRINT_DB_NAME (plus optional NOTIFY_PROPERTIES, SLACK_ERROR_WEBHOOK_URL, DRY_RUN, REQUIRE_APPROVAL).
- KV binding NOTIFY_CACHE configured in wrangler.toml with correct ids.
- Cron schedule in wrangler.toml matches desired time.
- Run `npm run dev` locally to verify build/typing; inspect console for runtime errors.
- For production deploy, run `npm run deploy`.
- Optionally trigger `GET/POST /run-now` to sanity-check after deploy; confirm Slack message delivers or dry-run logs.
- Review npm audit output if required; address vulnerabilities as needed.