# Suggested Commands
- Install deps: `npm install`
- Local dev (wrangler): `npm run dev`
- Deploy to Cloudflare: `npm run deploy`
- Add secrets (examples): `wrangler secret put OPENAI_API_KEY`, `wrangler secret put NOTION_OAUTH_ACCESS_TOKEN`, `wrangler secret put SLACK_WEBHOOK_URL`
- Configure KV binding IDs in `wrangler.toml` before deploy.
- Manual HTTP trigger (after deploy): `curl -XPOST https://<worker>/run-now?approved=true` (approval query required if REQUIRE_APPROVAL=always).