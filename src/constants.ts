/**
 * Shared constants — timeouts, intervals, and limits.
 */

export const TIMEOUTS = {
  REVIEWER: 300_000,      // 5 min
  REVIEW_LLM: 120_000,    // 2 min
  CLAUDE_CLI: 180_000,    // 3 min
  GIT_OPERATION: 30_000,  // 30 sec
  SPLIT_TASK: 30_000,     // 30 sec
  /** Warn if agent produces no stdout for this long */
  AGENT_STALL_WARN: 180_000,  // 3 min
  /** Kill agent if no stdout for this long */
  AGENT_STALL_KILL: 300_000,  // 5 min
} as const;

export const INTERVALS = {
  POLL: 30_000,            // 30 sec
  MESSAGE_POLL: 15_000,    // 15 sec
} as const;

export const LIMITS = {
  MAX_DIFF_LINES: 300,
  MAX_RETRIES: 3,
  LOG_BUFFER_SIZE: 200,
} as const;
