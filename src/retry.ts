/**
 * Generic retry wrapper with exponential backoff.
 * Retries on thrown errors. Does not retry on successful return.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 500, label = "API call" } = options;
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      // Don't retry on client errors (4xx) — they won't succeed on retry
      const msg = (err as Error).message ?? "";
      const is4xx = /\b(400|401|403|404)\b/.test(msg);
      if (is4xx || attempt >= maxRetries) {
        if (attempt >= maxRetries) {
          console.error(`${label} failed after ${attempt} attempts:`, msg);
        } else {
          console.warn(`${label} non-retryable error:`, msg);
        }
        throw err;
      }
      console.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms:`, msg);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
