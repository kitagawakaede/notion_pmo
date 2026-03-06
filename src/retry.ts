/**
 * Generic retry wrapper with exponential backoff.
 * Retries on thrown errors. Does not retry on successful return.
 *
 * Logging behaviour:
 *  - silent=true  → no logs at all
 *  - silent=false (default) →
 *      • 4xx (non-retryable): no log (caller is expected to handle)
 *      • retry attempts: warn
 *      • final failure after max retries: error
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; label?: string; silent?: boolean } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 500, label = "API call", silent = false } = options;
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
        // Only log when retries are exhausted (server errors); 4xx is silent by default
        if (!silent && !is4xx && attempt >= maxRetries) {
          console.error(`${label} failed after ${attempt} attempts:`, msg);
        }
        throw err;
      }
      if (!silent) {
        console.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms:`, msg);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
