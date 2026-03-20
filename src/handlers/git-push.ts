/**
 * Handler for the git_push template action.
 * Pushes the base branch to the remote origin.
 */

import type { TemplateAction, ActionContext } from "../agent-templates.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../error-logger.js";

export async function handleGitPush(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "git_push";
  if (ctx.mergeSkipped) { ui.info(`[${phase}] ${label}: skipped (no merge)`); return; }
  const { execSync: pushExec } = await import("node:child_process");
  // Resolve repo root (workingDir may be a worktree)
  const pushRepoDir = pushExec("git rev-parse --path-format=absolute --git-common-dir", { cwd: ctx.config.workingDir, stdio: "pipe" })
    .toString().trim().replace(/\/.git$/, "");
  // Stash any unstaged changes (e.g. inject_memory's CLAUDE.md modifications)
  try {
    pushExec("git stash --include-untracked", { cwd: pushRepoDir, stdio: "pipe" });
  } catch { /* nothing to stash */ }
  try {
    pushExec(`git push origin ${ctx.config.baseBranch}`, {
      cwd: pushRepoDir,
      stdio: "pipe",
    });
    ui.info( `[${phase}] ${label}: pushed ${ctx.config.baseBranch}`);
  } catch {
    // Push rejected (remote ahead) — pull rebase and retry
    try {
      pushExec(`git pull --rebase origin ${ctx.config.baseBranch}`, { cwd: pushRepoDir, stdio: "pipe" });
      pushExec(`git push origin ${ctx.config.baseBranch}`, { cwd: pushRepoDir, stdio: "pipe" });
      ui.info( `[${phase}] ${label}: pushed ${ctx.config.baseBranch} (after rebase)`);
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logError(CLI_ERR.GIT_PUSH_FAILED, `git_push failed after rebase: ${msg}`, { taskId: ctx.task.id, repoDir: pushRepoDir }, retryErr);
      ui.warn(`[template] git_push failed after rebase: ${msg}`);
    }
  }
  // Restore stashed changes (non-fatal if nothing was stashed)
  try {
    pushExec("git stash pop", { cwd: pushRepoDir, stdio: "pipe" });
  } catch { /* no stash to pop */ }
}
