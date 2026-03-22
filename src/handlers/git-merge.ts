/**
 * Handler for the git_merge template action.
 * Merges the agent's worktree branch into the base branch.
 *
 * Before merging, attempts a rebase onto the base branch to incorporate
 * any commits merged by other agents while this agent was working.
 * If the rebase encounters conflicts, the merge is aborted and the
 * task is escalated to "blocked" status with conflict details.
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Mutex } from "async-mutex";
import type { TemplateAction, ActionContext } from "../agent-templates.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../error-logger.js";
import { resolveRepoRoot } from "../git-ops.js";
import { trackRetry } from "../utils/retry-tracker.js";
import type { Task } from "../api-client.js";

/** Module-level mutex to serialize concurrent merge operations */
const mergeLock = new Mutex();

/** Result of attempting to rebase a branch onto the base */
export interface RebaseResult {
  success: boolean;
  /** Files that had conflicts (only populated on failure) */
  conflictedFiles: string[];
}

/**
 * Attempt to rebase the worktree branch onto the base branch.
 * If conflicts are detected, aborts the rebase and returns the conflicted file list.
 */
export function rebaseOntoBase(
  repoDir: string,
  worktreeBranch: string,
  baseBranch: string,
  exec: typeof execSync = execSync
): RebaseResult {
  try {
    // Switch to the worktree branch for rebasing
    ui.info(`[git_merge] rebase: checkout ${worktreeBranch} in ${repoDir}`);
    exec(`git checkout "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" });
    ui.info(`[git_merge] rebase: rebase onto ${baseBranch}`);
    exec(`git rebase "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
    return { success: true, conflictedFiles: [] };
  } catch (err) {
    const errMsg = err instanceof Error ? (err as { stderr?: Buffer }).stderr?.toString() || err.message : String(err);
    ui.warn(`[git_merge] rebase failed: ${errMsg.slice(0, 300)}`);
    // Rebase failed — extract conflicted files before aborting
    let conflictedFiles: string[] = [];
    try {
      const diffOutput = exec(
        "git diff --name-only --diff-filter=U",
        { cwd: repoDir, stdio: "pipe" }
      ).toString().trim();
      conflictedFiles = diffOutput.split("\n").filter(Boolean);
    } catch {
      // Could not list conflicts — still need to abort
    }

    // Abort the rebase to leave the repo in a clean state
    try {
      exec("git rebase --abort", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // Already clean or no rebase in progress
    }

    return { success: false, conflictedFiles };
  }
}

/**
 * Handle a merge conflict: retry by resetting to todo (up to 2 times),
 * then escalate to blocked with notification.
 * Records conflict to Failure DB and broadcasts via WebSocket.
 */
export async function escalateConflict(
  ctx: ActionContext,
  conflictedFiles: string[],
  worktreeBranch: string
): Promise<void> {
  const fileList = conflictedFiles.length > 0
    ? conflictedFiles.join(", ")
    : "(unknown files)";
  const comment = `Merge conflict on ${worktreeBranch}: ${fileList}`;

  // Track retries — allow 2 auto-retries before blocking
  const MAX_CONFLICT_RETRIES = 2;
  const { retryCount, maxed } = trackRetry(`conflict:${ctx.task.id}`, MAX_CONFLICT_RETRIES);

  if (!maxed) {
    // Auto-retry: reset to todo so the task runs again from latest main
    ui.warn(`[git_merge] Conflict detected (attempt ${retryCount}/${MAX_CONFLICT_RETRIES}) — resetting to todo for retry`);
    try {
      // Persist retry count in context_notes so it survives CLI restarts
      const existingNotes = (ctx.task.context_notes as string) || "";
      const updatedNotes = existingNotes.replace(/\[conflict_retries:\d+\]/, "").trim() + ` [conflict_retries:${retryCount}]`;
      await ctx.api.updateTask(ctx.task.id, {
        status: "todo",
        review_comment: `${comment} — auto-retry ${retryCount}/${MAX_CONFLICT_RETRIES}`,
        context_notes: updatedNotes.trim(),
      } as Partial<Task>);
    } catch {
      ui.warn("[git_merge] Failed to reset task to todo");
    }
    ctx.onDataUpdate?.("task", ctx.task.id, { status: "todo", review_comment: comment });
    // Set exitCode to prevent post-actions from running (skip push, reviewer, etc.)
    ctx.exitCode = 1;
  } else {
    // Max retries exceeded — escalate to blocked
    ui.error(`[git_merge] Conflict detected (${retryCount} attempts) — escalating to blocked`);
    try {
      await ctx.api.updateTask(ctx.task.id, {
        status: "blocked",
        review_comment: `${comment} — blocked after ${retryCount} conflict retries`,
      } as unknown as Parameters<typeof ctx.api.updateTask>[1]);
    } catch {
      ui.warn("[git_merge] Failed to update task status to blocked");
    }
    ctx.onDataUpdate?.("task", ctx.task.id, { status: "blocked", review_comment: comment });

    // Notify user
    try {
      await ctx.api.sendMessage("manager", "user", `Merge conflict on task "${ctx.task.title}" after ${retryCount} retries. Manual resolution required.\nFiles: ${fileList}`);
    } catch { /* non-fatal */ }
  }

  // Record to Failure DB
  ctx.api.recordFailure({
    task_id: ctx.task.id,
    failure_type: "merge_conflict",
    summary: comment,
    agent_name: ctx.agentName,
    sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
  }).catch(() => { /* best-effort */ });
}

/**
 * Clean up worktree directory, prune stale worktree refs, and delete the branch.
 */
function cleanupBranch(
  repoDir: string,
  worktreeDir: string,
  worktreeBranch: string,
  exec: typeof execSync = execSync
): void {
  if (existsSync(worktreeDir)) {
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
  try { exec("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
  try { exec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
}

export async function handleGitMerge(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "git_merge";
  const gitExec = execSync;
  const gitJoin = join;
  // workingDir is the worktree path — we need the main repo root
  const worktreePath = ctx.config.workingDir;
  const repoDir = resolveRepoRoot(worktreePath);
  const baseBranch = ctx.config.baseBranch;

  // Serialize merge operations to prevent concurrent checkout/merge conflicts
  const release = await mergeLock.acquire();
  try {
    // Prefer the branch name from context (set by spawner) to avoid picking up wrong branches
    let worktreeBranch = ctx.agentBranch || null;
    if (!worktreeBranch) {
      // Fallback: scan for agent/ branches (legacy, less reliable with parallel agents)
      const branches = gitExec("git branch", { cwd: repoDir, stdio: "pipe" }).toString();
      worktreeBranch = branches.split("\n")
        .map((b) => b.trim().replace(/^[*+]\s+/, ""))
        .find((b) => b.startsWith("agent/")) || null;
    }

    if (worktreeBranch) {
      // Find worktree path for cleanup
      const worktreeDir = gitJoin(repoDir, ".worktrees", worktreeBranch.replace(/\//g, "-"));

      // Safety check: verify agent actually made commits on the branch
      const agentCommits = gitExec(
        `git log ${baseBranch}..${worktreeBranch} --oneline`,
        { cwd: repoDir, stdio: "pipe" }
      ).toString().trim();

      if (!agentCommits) {
        ui.warn(`[${phase}] ${label}: no agent commits on ${worktreeBranch} — skipping merge`);
        ctx.mergeSkipped = true;
        cleanupBranch(repoDir, worktreeDir, worktreeBranch);
        return;
      }

      // Safety check: verify diff contains real code changes
      const diffFiles = gitExec(
        `git diff ${baseBranch}..${worktreeBranch} --name-only`,
        { cwd: repoDir, stdio: "pipe" }
      ).toString().trim().split("\n").filter(Boolean);
      // Filter out inject_memory artifacts only (.claude/ memory dirs, .toban- messages)
      // CLAUDE.md is meaningful (agent may create/update it as part of the task)
      const meaningfulFiles = diffFiles.filter(
        (f) => !f.startsWith(".claude/") && !f.startsWith(".toban-")
      );

      if (meaningfulFiles.length === 0) {
        ui.warn(`[${phase}] ${label}: only metadata files changed (${diffFiles.join(", ")}) — skipping merge`);
        ctx.mergeSkipped = true;
        cleanupBranch(repoDir, worktreeDir, worktreeBranch);
        return;
      }

      ui.info(`[${phase}] ${label}: ${agentCommits.split("\n").length} commit(s), ${meaningfulFiles.length} file(s)`);

      // ── Remove worktree BEFORE rebase/merge ──
      // git refuses to checkout a branch that's checked out in a worktree,
      // so we must detach the worktree first while keeping the branch.
      if (existsSync(worktreeDir)) {
        try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
        try { gitExec("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
      }

      // Clean working directory to prevent checkout failures
      // verify_build may have left modified files (npm install changes package-lock.json, etc.)
      try { gitExec("git checkout -- .", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
      try { gitExec("git clean -fd", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }

      // ── Rebase onto base branch before merging ──
      // This incorporates any commits merged by other agents while this one was working.
      // If rebase encounters conflicts, we abort and escalate.
      const rebaseResult = rebaseOntoBase(repoDir, worktreeBranch, baseBranch);
      if (!rebaseResult.success) {
        await escalateConflict(ctx, rebaseResult.conflictedFiles, worktreeBranch);
        logError(
          CLI_ERR.GIT_MERGE_FAILED,
          `Rebase conflict on ${worktreeBranch}: ${rebaseResult.conflictedFiles.join(", ")}`,
          { taskId: ctx.task.id }
        );
        // Switch back to base branch before deleting agent branch
        try { gitExec(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
        try { gitExec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
        return;
      }

      // Record pre-merge hash for accurate diff in reviewer
      try { ctx.preMergeHash = gitExec("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" }).toString().trim(); } catch { /* non-fatal */ }
      gitExec(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
      gitExec(`git merge --no-ff "${worktreeBranch}" -m "merge: ${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" });
      ui.info( `[${phase}] ${label}: merged ${worktreeBranch}`);

      // Clean up branch (worktree already removed above)
      try { gitExec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
    } else {
      ui.info( `[${phase}] ${label}: no agent branch found, skipping`);
    }
  } catch (mergeErr) {
    const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    logError(CLI_ERR.GIT_MERGE_FAILED, `git_merge failed: ${msg}`, { taskId: ctx.task.id }, mergeErr);
    ui.warn(`[template] git_merge failed: ${msg}`);
    try { gitExec("git merge --abort", { cwd: repoDir, stdio: "pipe" }); } catch { /* already clean */ }

    // Escalate merge failure to blocked status
    await escalateConflict(ctx, [], ctx.agentBranch ?? "unknown");
  } finally {
    release();
  }
}
