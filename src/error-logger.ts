/**
 * Structured error logging for CLI.
 *
 * Logs errors with codes, context, and optional file persistence.
 * Designed to correlate with API request_ids for end-to-end debugging.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Error Codes ────────────────────────────────────────────

export const CLI_ERR = {
  // Agent lifecycle
  AGENT_SPAWN_FAILED: "CLI_AGENT_SPAWN_FAILED",
  AGENT_TIMEOUT: "CLI_AGENT_TIMEOUT",
  AGENT_CRASH: "CLI_AGENT_CRASH",

  // Git operations
  GIT_CLONE_FAILED: "CLI_GIT_CLONE_FAILED",
  GIT_MERGE_FAILED: "CLI_GIT_MERGE_FAILED",
  GIT_PUSH_FAILED: "CLI_GIT_PUSH_FAILED",
  GIT_WORKTREE_FAILED: "CLI_GIT_WORKTREE_FAILED",

  // API communication
  API_REQUEST_FAILED: "CLI_API_REQUEST_FAILED",
  API_AUTH_FAILED: "CLI_API_AUTH_FAILED",
  API_TIMEOUT: "CLI_API_TIMEOUT",

  // Review
  REVIEW_LLM_FAILED: "CLI_REVIEW_LLM_FAILED",
  REVIEW_LLM_TIMEOUT: "CLI_REVIEW_LLM_TIMEOUT",
  REVIEW_PARSE_FAILED: "CLI_REVIEW_PARSE_FAILED",
  REVIEW_API_FAILED: "CLI_REVIEW_API_FAILED",

  // Template actions
  ACTION_FAILED: "CLI_ACTION_FAILED",
  MEMORY_INJECT_FAILED: "CLI_MEMORY_INJECT_FAILED",
  MEMORY_COLLECT_FAILED: "CLI_MEMORY_COLLECT_FAILED",

  // General
  CONFIG_INVALID: "CLI_CONFIG_INVALID",
  UNEXPECTED: "CLI_UNEXPECTED",
} as const;

export type CliErrorCode = typeof CLI_ERR[keyof typeof CLI_ERR];

// ── Log Entry ──────────────────────────────────────────────

export interface ErrorLogEntry {
  timestamp: string;
  code: CliErrorCode;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

// ── Logger ─────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".toban", "logs");
const LOG_FILE = path.join(LOG_DIR, "error.log");
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

let initialized = false;

function ensureLogDir() {
  if (initialized) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Rotate if too large
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const backup = LOG_FILE + ".old";
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(LOG_FILE, backup);
      }
    }
    initialized = true;
  } catch { /* best effort */ }
}

export function logError(
  code: CliErrorCode,
  message: string,
  context?: Record<string, unknown>,
  error?: unknown,
): void {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    code,
    message,
    ...(context ? { context } : {}),
    ...(error instanceof Error ? { stack: error.stack } : {}),
  };

  // Console output (always)
  const debug = process.env.DEBUG === "1";
  const line = `[${entry.code}] ${entry.message}`;
  if (debug && entry.stack) {
    console.error(line + "\n" + entry.stack);
  }

  // File output (best effort)
  ensureLogDir();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch { /* non-fatal */ }
}

/**
 * Wrap an async function with error logging.
 * Returns the result or undefined on error.
 */
export async function withErrorLog<T>(
  code: CliErrorCode,
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(code, message, context, err);
    return undefined;
  }
}
