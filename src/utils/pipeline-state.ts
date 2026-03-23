/**
 * Pipeline State — persists merge-pipeline step progress per task.
 *
 * Allows the pipeline to resume from the last successful step on retry,
 * avoiding redundant merge/verify when only push failed.
 *
 * State is stored as JSON in ~/.toban/pipeline/{taskId}.json.
 * Cleared on verify_build failure (Builder must redo) or full success.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PipelineStepState {
  merge_done: boolean;
  merge_commit?: string;  // SHA after merge
  verify_done: boolean;
  push_done: boolean;
  updated_at: string;
  /** Agent branch name — used to skip builder on pipeline retry */
  agent_branch?: string;
  /** Completion JSON from builder — preserved for reviewer */
  completion_json?: string;
}

const STATE_DIR = join(homedir(), ".toban", "pipeline");

function stateFilePath(taskId: string): string {
  return join(STATE_DIR, `${taskId}.json`);
}

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function loadPipelineState(taskId: string): PipelineStepState | null {
  const path = stateFilePath(taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PipelineStepState;
  } catch {
    return null;
  }
}

export function savePipelineState(taskId: string, state: PipelineStepState): void {
  ensureDir();
  state.updated_at = new Date().toISOString();
  writeFileSync(stateFilePath(taskId), JSON.stringify(state, null, 2));
}

export function clearPipelineState(taskId: string): void {
  const path = stateFilePath(taskId);
  try { unlinkSync(path); } catch { /* doesn't exist */ }
}
