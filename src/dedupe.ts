import type { Bindings } from "./config";
import type { SprintSummary } from "./schema";

const encoder = new TextEncoder();

export async function hashPayload(input: unknown): Promise<string> {
  const text =
    typeof input === "string" ? input : JSON.stringify(input, null, 0);
  const buffer = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildDedupKey(summary: SprintSummary): string {
  return `sprint:${summary.sprint.id}`;
}

export async function isDuplicateAndRemember(
  env: Bindings,
  key: string,
  hash: string,
  ttlSeconds: number
): Promise<boolean> {
  const existing = await env.NOTIFY_CACHE.get(key);
  if (existing === hash) {
    return true;
  }
  await env.NOTIFY_CACHE.put(key, hash, { expirationTtl: ttlSeconds });
  return false;
}
