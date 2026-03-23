/**
 * Per-task execution logger.
 *
 * Creates a JSON log file per task execution at ~/.toban/logs/tasks/{taskId}.jsonl
 * Each line is a timestamped event. Claude Code can read these files for debugging.
 *
 * Usage:
 *   const log = createTaskLogger(taskId);
 *   log.event("pickup", { agent: "builder", template: "implementation" });
 *   log.event("completion_parse", { source: "stream_result", review_comment: "..." });
 *   log.event("post_action", { action: "spawn_reviewer", result: "skipped", reason: "no merge" });
 *   log.stdout(lines);  // persist last N stdout lines
 *   log.close();
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TASKS_LOG_DIR = path.join(os.homedir(), ".toban", "logs", "tasks");
const MAX_STDOUT_LINES = 50;
const MAX_FILES = 100; // keep last 100 task logs

interface TaskEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface TaskLogger {
  event(name: string, data?: Record<string, unknown>): void;
  stdout(lines: string[]): void;
  close(): void;
}

function ensureDir() {
  try {
    fs.mkdirSync(TASKS_LOG_DIR, { recursive: true });
  } catch { /* best effort */ }
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(TASKS_LOG_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, time: fs.statSync(path.join(TASKS_LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const f of files.slice(MAX_FILES)) {
      fs.unlinkSync(path.join(TASKS_LOG_DIR, f.name));
    }
  } catch { /* best effort */ }
}

function write(filePath: string, entry: TaskEvent) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch { /* best effort */ }
}

export function createTaskLogger(taskId: string): TaskLogger {
  ensureDir();
  cleanOldLogs();

  const shortId = taskId.slice(0, 8);
  const filePath = path.join(TASKS_LOG_DIR, `${shortId}.jsonl`);

  return {
    event(name: string, data?: Record<string, unknown>) {
      write(filePath, { ts: new Date().toISOString(), event: name, data });
    },

    stdout(lines: string[]) {
      const tail = lines.slice(-MAX_STDOUT_LINES);
      write(filePath, {
        ts: new Date().toISOString(),
        event: "stdout_snapshot",
        data: { line_count: lines.length, tail },
      });
    },

    close() {
      write(filePath, { ts: new Date().toISOString(), event: "close" });
    },
  };
}
