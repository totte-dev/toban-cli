/**
 * Tracks retry counts per task to prevent infinite NEEDS_CHANGES loops.
 */

/** Map of task ID -> retry count */
export const retryTracker = new Map<string, number>();

const MAX_RETRIES = 3;

/**
 * Check if a task has exceeded the retry limit and return the appropriate status.
 * Increments the retry count for the given task.
 *
 * @returns { retryCount, maxed } — maxed=true means human intervention is needed
 */
export function trackRetry(taskId: string): { retryCount: number; maxed: boolean } {
  const retryCount = (retryTracker.get(taskId) ?? 0) + 1;
  retryTracker.set(taskId, retryCount);
  return { retryCount, maxed: retryCount >= MAX_RETRIES };
}
