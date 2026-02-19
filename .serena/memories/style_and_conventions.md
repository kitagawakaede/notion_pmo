# Style and Conventions
- Language: TypeScript (strict) targeting Cloudflare Workers (ES2022, module bundler resolution).
- Runtime APIs: use native fetch/Web Crypto; avoid Node-only APIs.
- Validation: Zod schemas in src/schema.ts for LLM output; JSON schema sent to OpenAI.
- Config loading centralized in src/config.ts; prefer parsing env there instead of scattered checks.
- Logging: concise console.log/console.error; dry-run logs payloads instead of sending.
- Dedupe: KV-backed hash per sprint (see src/dedupe.ts); TTL default 7 days.
- LLM guardrails: prompt restricts MCP tool use to `search`/`fetch`, read-only.
- Slack formatting: blocks + plaintext fallback built in src/slack.ts.