/**
 * Shared constants — timeouts, intervals, and limits.
 */

export const TIMEOUTS = {
  REVIEWER: 300_000,      // 5 min
  REVIEW_LLM: 120_000,    // 2 min
  CLAUDE_CLI: 180_000,    // 3 min
  GIT_OPERATION: 30_000,  // 30 sec
  SPLIT_TASK: 30_000,     // 30 sec
} as const;

export const INTERVALS = {
  POLL: 30_000,            // 30 sec
  MESSAGE_POLL: 10_000,    // 10 sec
} as const;

export const LIMITS = {
  MAX_DIFF_LINES: 300,
  MAX_RETRIES: 3,
  LOG_BUFFER_SIZE: 200,
} as const;
