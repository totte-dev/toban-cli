/**
 * Handler for the git_push template action.
 * Pushes the base branch to the remote origin.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TemplateAction, ActionContext } from "../agents/agent-templates.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../services/error-logger.js";
import { resolveRepoRoot, setupGitCredentialHelper, cleanRepoAuth } from "../services/git-ops.js";

export async function handleGitPush(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "git_push";
  if (ctx.mergeSkipped) { ui.info(`[${phase}] ${label}: skipped (no merge)`); return; }
  const pushExec = execSync;
  // Resolve repo root (workingDir may be a worktree)
  const pushRepoDir = resolveRepoRoot(ctx.config.workingDir);

  // Refresh credential helper with current API key before push
  // (prevents stale tokens from previous sessions)
  const tobanHome = join(homedir(), ".toban");
  const helperPath = setupGitCredentialHelper(tobanHome, ctx.config.apiUrl, ctx.config.apiKey);
  cleanRepoAuth(pushRepoDir, helperPath);

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
      ui.error(`[${phase}] ${label}: push FAILED — changes are local only: ${msg}`);
      ctx.exitCode = 1;
    }
  }
  // Restore stashed changes (non-fatal if nothing was stashed)
  try {
    pushExec("git stash pop", { cwd: pushRepoDir, stdio: "pipe" });
  } catch { /* no stash to pop */ }
}
