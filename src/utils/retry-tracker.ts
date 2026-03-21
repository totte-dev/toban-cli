/**
 * Tracks retry counts per task to prevent infinite loops.
 *
 * In-memory only — resets on CLI restart. Use task-prefixed keys
 * (e.g. "conflict:taskId") to track different retry contexts independently.
 */

/** Map of key -> retry count (process-lifetime, not persisted) */
const retryTracker = new Map<string, number>();

/** Default max retries for review NEEDS_CHANGES loops */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Increment retry count and check if limit is exceeded.
 *
 * @param key - Unique key (e.g. task ID or "conflict:taskId")
 * @param maxRetries - Override the default limit (default: 3)
 * @returns { retryCount, maxed } — maxed=true means human intervention is needed
 */
export function trackRetry(key: string, maxRetries = DEFAULT_MAX_RETRIES): { retryCount: number; maxed: boolean } {
  const retryCount = (retryTracker.get(key) ?? 0) + 1;
  retryTracker.set(key, retryCount);
  return { retryCount, maxed: retryCount >= maxRetries };
}

/** Clear retry count for a key (e.g. after successful completion). */
export function clearRetry(key: string): void {
  retryTracker.delete(key);
}
