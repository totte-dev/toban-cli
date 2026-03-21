/**
 * Task auto-splitting — detects large tasks (SP >= threshold) and splits
 * them into smaller subtasks using LLM.
 *
 * Extracted from run-loop.ts for testability and reuse.
 */

import { spawn } from "node:child_process";
import { resolveModel } from "./agent-engine.js";
import { createAuthHeaders, type Task } from "./api-client.js";
import { parseTaskLabels } from "./utils/parse-labels.js";
import { TIMEOUTS } from "./constants.js";
import * as ui from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubtaskDef {
  title: string;
  description: string;
  owner: string;
  type: string;
  priority: string;
  story_points: number;
}

export interface SplitResult {
  taskId: string;
  subtasks: SubtaskDef[];
  skipped: boolean;
  reason?: string;
}

export interface SplitConfig {
  /** Minimum story points to trigger auto-split (default: 8) */
  minSp: number;
  apiUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// LLM-based splitting (mockable via splitFn parameter)
// ---------------------------------------------------------------------------

/**
 * Call LLM to split a task into subtasks.
 * Default implementation uses Claude CLI; can be replaced for testing.
 */
export async function splitTaskWithLLM(task: Task): Promise<SubtaskDef[]> {
  const prompt = `Split this task into 2-4 smaller subtasks (each 2-5 story points, 1-2 files max).

Task: ${task.title}
Description: ${task.description || "(none)"}
Owner: ${task.owner || "builder"}
Type: ${task.type || "feature"}

Rules:
- Each subtask should be independently implementable
- Total SP of subtasks should roughly equal the original (${task.story_points ?? 8} SP)
- Include specific file paths or areas in each subtask description
- If tasks have dependencies, note them in the description (e.g. "After subtask 1 completes...")

Output ONLY a JSON array, no markdown:
[{"title":"...","description":"specific files and acceptance criteria","owner":"builder","type":"feature","priority":"p2","story_points":3}]`;

  return new Promise((resolve) => {
    const child = spawn("claude", ["--print", "--model", resolveModel("claude-haiku"), "--max-turns", "1", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUTS.SPLIT_TASK,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => {
      try {
        const match = out.match(/\[[\s\S]*\]/);
        if (match) {
          const subtasks = JSON.parse(match[0]) as SubtaskDef[];
          if (Array.isArray(subtasks) && subtasks.length >= 2) {
            // Validate each subtask has required fields
            const valid = subtasks.filter(
              (s) => s.title && typeof s.story_points === "number" && s.story_points >= 1 && s.story_points <= 5
            );
            if (valid.length >= 2) {
              resolve(valid);
              return;
            }
          }
        }
      } catch { /* parse failed */ }
      resolve([]);
    });
    child.on("error", () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a task should be auto-split.
 * Returns false if SP < threshold or if task has `auto_split: false` label.
 */
export function shouldSplit(task: Task, minSp: number): boolean {
  const sp = task.story_points as number | null;
  if (!sp || sp < minSp) return false;

  // Check for auto_split: false label
  const labels = parseTaskLabels(task);
  if (labels.includes("auto_split:false") || labels.includes("no_split")) return false;

  // Don't split already-split tasks or sub-tasks
  if ((task.status as string) === "blocked" || task.status === "done") return false;
  if (task.parent_task) return false;

  return true;
}

/**
 * Process a list of tasks: split large ones, return list of split results.
 * Creates subtasks via API and updates parent task status.
 *
 * @param splitFn - LLM split function (injectable for testing)
 */
export async function autoSplitTasks(
  tasks: Task[],
  sprintNumber: number,
  config: SplitConfig,
  splitFn: (task: Task) => Promise<SubtaskDef[]> = splitTaskWithLLM,
): Promise<SplitResult[]> {
  const results: SplitResult[] = [];

  for (const task of tasks) {
    if (!shouldSplit(task, config.minSp)) continue;

    ui.info(`[auto-split] ${task.id.slice(0, 8)}: SP=${task.story_points} — splitting into subtasks`);

    try {
      const subtasks = await splitFn(task);
      if (subtasks.length === 0) {
        results.push({ taskId: task.id, subtasks: [], skipped: true, reason: "LLM returned no valid subtasks" });
        ui.warn(`[auto-split] ${task.id.slice(0, 8)}: LLM returned no valid subtasks — keeping original`);
        continue;
      }

      // Create subtasks via API
      const headers = createAuthHeaders(config.apiKey);
      for (const sub of subtasks) {
        await fetch(`${config.apiUrl}/api/v1/tasks`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...sub,
            sprint: sprintNumber,
            parent_task: task.id,
            status: "todo",
          }),
        });
      }

      // Mark parent as blocked (subtasks must complete first)
      await fetch(`${config.apiUrl}/api/v1/tasks/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "blocked" }),
      });

      results.push({ taskId: task.id, subtasks, skipped: false });
      ui.info(`[auto-split] Created ${subtasks.length} subtasks for ${task.id.slice(0, 8)}, parent blocked`);
    } catch (err) {
      results.push({ taskId: task.id, subtasks: [], skipped: true, reason: String(err) });
      ui.warn(`[auto-split] Failed for ${task.id.slice(0, 8)}: ${err}`);
    }
  }

  return results;
}
