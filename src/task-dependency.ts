/**
 * Task dependency detection and ordering.
 *
 * Analyzes task titles and descriptions to infer dependencies:
 * 1. Explicit textual dependencies ("after X", "depends on", "requires")
 * 2. Implicit file-based conflicts (same file/directory referenced)
 *
 * No LLM calls — uses fast keyword/pattern matching only.
 */

import type { Task } from "./api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Dependency {
  /** Task that must complete first */
  from: string;
  /** Task that depends on `from` */
  to: string;
  /** Reason for the dependency */
  reason: string;
  /** Dependency type */
  type: "explicit" | "file_conflict";
}

export interface TaskWithOrder extends Task {
  /** True if this task can run in parallel with other ready tasks */
  parallelReady: boolean;
  /** IDs of tasks this one depends on */
  dependsOn: string[];
}

// ---------------------------------------------------------------------------
// Patterns for explicit dependency detection
// ---------------------------------------------------------------------------

const EXPLICIT_DEPENDENCY_PATTERNS: RegExp[] = [
  /(?:の後に|のあとに|を前提に|に依存|が完了してから|が終わってから|の完了後)/,
  /(?:after|depends?\s+on|requires|prerequisite|blocked\s+by|must\s+complete\s+first)/i,
];

// ---------------------------------------------------------------------------
// File/path extraction from text
// ---------------------------------------------------------------------------

const FILE_PATH_PATTERN = /(?:^|\s|[`"'(])([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,10})(?:\s|$|[`"'),])/g;
const DIR_PATH_PATTERN = /(?:^|\s|[`"'(])((?:src|lib|api|app|pages|components|handlers|utils|tests?|__tests__)\/[a-zA-Z0-9_\-./]+)/g;

/**
 * Extract file/directory paths mentioned in text.
 */
export function extractPaths(text: string): string[] {
  if (!text) return [];
  const paths = new Set<string>();

  // File paths (e.g., "api-client.ts", "src/foo/bar.ts")
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const p = match[1];
    // Filter out common false positives
    if (!p.includes("/") && !p.match(/\.(ts|tsx|js|jsx|json|yaml|yml|md|css|html|sql|sh)$/)) continue;
    paths.add(p);
  }

  // Directory paths (e.g., "src/commands/", "handlers/git-merge")
  for (const match of text.matchAll(DIR_PATH_PATTERN)) {
    paths.add(match[1]);
  }

  return Array.from(paths);
}

/**
 * Get the directory component of a path for conflict detection.
 * "src/commands/run-loop.ts" -> "src/commands"
 */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

/**
 * Check if two sets of paths overlap (same file or same directory).
 */
export function pathsOverlap(pathsA: string[], pathsB: string[]): string | null {
  for (const a of pathsA) {
    for (const b of pathsB) {
      // Exact same file
      if (a === b) return `same file: ${a}`;
      // Same directory (only if both have directory components)
      const dirA = dirOf(a);
      const dirB = dirOf(b);
      if (dirA && dirB && dirA === dirB) return `same directory: ${dirA}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency detection
// ---------------------------------------------------------------------------

/**
 * Detect dependencies between tasks using keyword and file-path analysis.
 *
 * Returns a list of directed dependencies (from -> to means "from" must complete before "to").
 */
export function detectDependencies(tasks: Task[]): Dependency[] {
  const deps: Dependency[] = [];

  // Build a map of task text -> task for matching
  const taskTexts = tasks.map((t) => ({
    task: t,
    text: `${t.title}\n${t.description || ""}`,
    paths: extractPaths(`${t.title}\n${t.description || ""}`),
  }));

  for (let i = 0; i < taskTexts.length; i++) {
    const current = taskTexts[i];

    // 1. Check explicit dependency keywords in current task's text
    for (const pattern of EXPLICIT_DEPENDENCY_PATTERNS) {
      if (pattern.test(current.text)) {
        // Try to find which other task it references
        for (let j = 0; j < taskTexts.length; j++) {
          if (i === j) continue;
          const other = taskTexts[j];
          // Check if the current task's text mentions the other task's title (or a significant part)
          const otherTitle = other.task.title.toLowerCase();
          const words = otherTitle.split(/\s+/).filter((w) => w.length > 3);
          const matchCount = words.filter((w) => current.text.toLowerCase().includes(w)).length;
          if (words.length > 0 && matchCount >= Math.ceil(words.length * 0.5)) {
            deps.push({
              from: other.task.id,
              to: current.task.id,
              reason: `explicit: "${current.task.title}" references "${other.task.title}"`,
              type: "explicit",
            });
          }
        }
      }
    }

    // 2. Check file-based conflicts
    if (current.paths.length > 0) {
      for (let j = i + 1; j < taskTexts.length; j++) {
        const other = taskTexts[j];
        if (other.paths.length === 0) continue;

        const overlap = pathsOverlap(current.paths, other.paths);
        if (overlap) {
          // Higher priority task goes first
          const currentPri = parsePriority(current.task.priority);
          const otherPri = parsePriority(other.task.priority);

          if (currentPri <= otherPri) {
            deps.push({
              from: current.task.id,
              to: other.task.id,
              reason: `file_conflict: ${overlap}`,
              type: "file_conflict",
            });
          } else {
            deps.push({
              from: other.task.id,
              to: current.task.id,
              reason: `file_conflict: ${overlap}`,
              type: "file_conflict",
            });
          }
        }
      }
    }
  }

  return deps;
}

function parsePriority(p: string | number | undefined): number {
  if (typeof p === "number") return p;
  if (typeof p === "string") {
    const n = parseInt(p.replace("p", ""), 10);
    return isNaN(n) ? 99 : n;
  }
  return 99;
}

// ---------------------------------------------------------------------------
// Topological sort with cycle handling
// ---------------------------------------------------------------------------

/**
 * Sort tasks by dependency order. Tasks with no dependencies come first.
 * Marks each task with `parallelReady` (can run now) and `dependsOn` (blockers).
 *
 * @param completedTaskIds - IDs of tasks already completed (used to resolve deps)
 */
export function sortByDependency(
  tasks: Task[],
  deps: Dependency[],
  completedTaskIds: Set<string> = new Set(),
): TaskWithOrder[] {
  // Build adjacency lists
  const taskIds = new Set(tasks.map((t) => t.id));
  const inDeps = new Map<string, string[]>(); // task -> list of tasks it depends on
  const outDeps = new Map<string, string[]>(); // task -> list of tasks that depend on it

  for (const t of tasks) {
    inDeps.set(t.id, []);
    outDeps.set(t.id, []);
  }

  for (const dep of deps) {
    // Only consider deps where both tasks are in our list
    if (!taskIds.has(dep.from) || !taskIds.has(dep.to)) continue;
    // Skip if the dependency is already completed
    if (completedTaskIds.has(dep.from)) continue;

    inDeps.get(dep.to)!.push(dep.from);
    outDeps.get(dep.from)!.push(dep.to);
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    inDegree.set(t.id, inDeps.get(t.id)!.length);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    // Sort queue by priority (lower priority number = higher priority)
    queue.sort((a, b) => {
      const ta = tasks.find((t) => t.id === a)!;
      const tb = tasks.find((t) => t.id === b)!;
      return parsePriority(ta.priority) - parsePriority(tb.priority);
    });

    const current = queue.shift()!;
    sorted.push(current);

    for (const next of outDeps.get(current) ?? []) {
      const newDegree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) queue.push(next);
    }
  }

  // Handle cycles: any tasks not in sorted list have circular deps — add them at the end
  const remaining = tasks.filter((t) => !sorted.includes(t.id));
  for (const t of remaining) {
    sorted.push(t.id);
  }

  // Build result
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return sorted.map((id) => {
    const task = taskMap.get(id)!;
    const blockers = (inDeps.get(id) ?? []).filter((depId) => !completedTaskIds.has(depId));
    return {
      ...task,
      parallelReady: blockers.length === 0,
      dependsOn: blockers,
    };
  });
}
