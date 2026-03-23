/**
 * Task Scheduler — filters tasks, resolves dependencies, manages concurrency safety.
 * Extracted from run-loop.ts to reduce its responsibilities.
 */

import type { Task } from "../api-client.js";
import type { ApiClient } from "../api-client.js";
import type { SlotScheduler } from "../slot-scheduler.js";
import { WS_MSG } from "../ws-types.js";
import { shouldSplit, autoSplitTasks } from "../task-splitter.js";
import { detectDependencies, sortByDependency } from "../task-dependency.js";
import * as ui from "../ui.js";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { WsChatServer } from "../ws-server.js";

/** Check if a task has structured details (steps or acceptance_criteria). */
function hasStructuredDetails(t: Task): boolean {
  const steps = t.steps as string | string[] | null | undefined;
  const ac = t.acceptance_criteria as string | string[] | null | undefined;
  // Parse JSON string if needed
  const parseArr = (v: string | string[] | null | undefined): string[] => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  };
  return parseArr(steps).length > 0 || parseArr(ac).length > 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSchedulerDeps {
  api: ApiClient;
  apiUrl: string;
  apiKey: string;
  agentName: string;
  scheduler: SlotScheduler;
  wsServer?: WsChatServer | null;
  /** Configured builder concurrency (from plan limits) */
  configuredBuilderConcurrency: number;
  /** Repos registered for this workspace */
  repos: Array<{ repo_name: string; repo_path: string }>;
  tobanHome: string;
  mainGithubRepo?: string | null;
}

/** Agent roles that can own tasks for auto-dispatch */
const AGENT_ROLES = ["builder", "cloud-engineer", "strategist", "marketer", "operator", "qa"];

/** Result of getDispatchableTasks — ready-to-dispatch tasks or idle/wait. */
export type ScheduleResult =
  | { status: "dispatch"; tasks: Task[] }
  | { status: "idle"; waitMultiplier: number };

// ---------------------------------------------------------------------------
// Task Scheduler
// ---------------------------------------------------------------------------

export class TaskScheduler {
  private deps: TaskSchedulerDeps;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Process all tasks for the current sprint tick:
   * 1. Auto-split large tasks
   * 2. Auto-transition todo → in_progress
   * 3. Empty-repo safety (limit concurrency)
   * 4. Dependency ordering
   * 5. Filter ready tasks
   *
   * Returns tasks ready for dispatch, or idle signal.
   */
  async getDispatchableTasks(
    allTasks: Task[],
    sprintStatus: string | undefined,
  ): Promise<ScheduleResult> {
    const { api, scheduler, wsServer } = this.deps;

    // --- Auto-split large tasks ---
    const todoForAgents = allTasks.filter(
      (t) => t.status === "todo" && t.owner && AGENT_ROLES.includes(t.owner) && t.review_verdict !== "ERROR" && t.category !== "destructive" && hasStructuredDetails(t),
    );

    const tasksToSplit = todoForAgents.filter((t) => shouldSplit(t, 8));
    if (tasksToSplit.length > 0) {
      const sprintNum = allTasks[0]?.sprint as number | undefined;
      if (sprintNum != null) {
        const splitResults = await autoSplitTasks(tasksToSplit, sprintNum, {
          minSp: 8,
          apiUrl: this.deps.apiUrl,
          apiKey: this.deps.apiKey,
        });
        const splitIds = new Set(splitResults.filter((r) => !r.skipped).map((r) => r.taskId));
        for (const id of splitIds) {
          wsServer?.broadcast({
            type: WS_MSG.DATA_UPDATE, entity: "task", task_id: id,
            changes: { status: "blocked" }, timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // --- Auto-transition todo → in_progress ---
    for (const t of todoForAgents) {
      if ((t.status as string) === "blocked") continue;
      try {
        await api.updateTask(t.id, { status: "in_progress" } as Partial<Task>);
        t.status = "in_progress" as Task["status"];
        ui.info(`[auto] ${t.owner}/${t.id.slice(0, 8)}: todo → in_progress`);
        wsServer?.broadcast({
          type: WS_MSG.DATA_UPDATE, entity: "task", task_id: t.id,
          changes: { status: "in_progress" }, timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    }

    // --- Empty-repo safety ---
    this.checkEmptyRepoSafety();

    // --- Dependency-aware ordering ---
    const inProgressTasks = allTasks.filter(
      (t) => t.status === "in_progress" && t.owner !== "user",
    );
    const completedTaskIds = new Set(
      allTasks.filter((t) => t.status === "done" || t.status === "review").map((t) => t.id),
    );
    const deps = detectDependencies(inProgressTasks);
    const orderedTasks = sortByDependency(inProgressTasks, deps, completedTaskIds);

    // Filter out tasks blocked by dependencies
    const readyTasks = orderedTasks.filter((t) => {
      if (!t.parallelReady) {
        ui.info(`[deps] ${t.id.slice(0, 8)}: waiting for ${t.dependsOn.map((d) => d.slice(0, 8)).join(", ")}`);
        return false;
      }
      return true;
    });

    if (readyTasks.length === 0) {
      const isIdle = sprintStatus === "review" || sprintStatus === "retrospective" || sprintStatus === "completed";
      await api.updateAgent({
        name: this.deps.agentName, status: "idle",
        activity: isIdle ? `Sprint ${sprintStatus}, waiting` : "Waiting for tasks",
      });
      if (!isIdle && !wsServer?.hasClients) {
        ui.info("No tasks — polling again");
      }
      return { status: "idle", waitMultiplier: isIdle ? 4 : 1 };
    }

    return { status: "dispatch", tasks: readyTasks };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private checkEmptyRepoSafety(): void {
    const { repos, tobanHome, mainGithubRepo, scheduler, configuredBuilderConcurrency, agentName } = this.deps;
    if (repos.length === 0) return;

    const mainRepo = mainGithubRepo
      ? repos.find((r) => r.repo_name === mainGithubRepo || r.repo_path.includes(mainGithubRepo))
      : null;
    const targetRepo = mainRepo || repos[0];
    const sharedRepoDir = join(tobanHome, "manager-repos", "shared", targetRepo.repo_name);
    const managerRepoDir = join(tobanHome, agentName, targetRepo.repo_name);
    const repoDir = existsSync(sharedRepoDir) ? sharedRepoDir : managerRepoDir;

    try {
      const commitCount = parseInt(
        execSync("git rev-list --count HEAD", { cwd: repoDir, stdio: "pipe" }).toString().trim(),
        10,
      );
      if (commitCount <= 1 && scheduler.getMaxConcurrency("builder") > 1) {
        scheduler.reconfigure("builder", 1);
        ui.info(`[safety] Repo has ${commitCount} commit(s) — limiting builders to 1 until first task completes`);
      } else if (commitCount > 1 && scheduler.getMaxConcurrency("builder") < configuredBuilderConcurrency) {
        scheduler.reconfigure("builder", configuredBuilderConcurrency);
        ui.info(`[safety] Repo now has ${commitCount} commits — restoring builder concurrency to ${configuredBuilderConcurrency}`);
      }
    } catch { /* repo not cloned yet or no HEAD */ }
  }
}
