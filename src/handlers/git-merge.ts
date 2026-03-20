/**
 * Handler for the git_merge template action.
 * Merges the agent's worktree branch into the base branch.
 */

import type { TemplateAction, ActionContext } from "../agent-templates.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../error-logger.js";
import { resolveRepoRoot } from "../git-ops.js";

export async function handleGitMerge(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "git_merge";
  const { execSync: gitExec } = await import("node:child_process");
  const { existsSync: gitExists } = await import("node:fs");
  const { join: gitJoin } = await import("node:path");
  // workingDir is the worktree path — we need the main repo root
  const worktreePath = ctx.config.workingDir;
  const repoDir = resolveRepoRoot(worktreePath);
  const baseBranch = ctx.config.baseBranch;

  // Find the agent's worktree branch
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
        // Clean up the empty branch
        if (gitExists(worktreeDir)) {
          const { rmSync } = await import("node:fs");
          try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
        }
        try { gitExec("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
        try { gitExec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
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
        if (gitExists(worktreeDir)) {
          const { rmSync } = await import("node:fs");
          try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
        }
        try { gitExec("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
        try { gitExec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
        return;
      }

      ui.info(`[${phase}] ${label}: ${agentCommits.split("\n").length} commit(s), ${meaningfulFiles.length} file(s)`);
      // Record pre-merge hash for accurate diff in reviewer
      try { ctx.preMergeHash = gitExec("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" }).toString().trim(); } catch { /* non-fatal */ }
      gitExec(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
      gitExec(`git merge --no-ff "${worktreeBranch}" -m "merge: ${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" });
      ui.info( `[${phase}] ${label}: merged ${worktreeBranch}`);

      // Clean up worktree
      if (gitExists(worktreeDir)) {
        const { rmSync } = await import("node:fs");
        try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
      }
      try { gitExec("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
      try { gitExec(`git branch -D "${worktreeBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
    } else {
      ui.info( `[${phase}] ${label}: no agent branch found, skipping`);
    }
  } catch (mergeErr) {
    const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    logError(CLI_ERR.GIT_MERGE_FAILED, `git_merge failed: ${msg}`, { taskId: ctx.task.id }, mergeErr);
    ui.warn(`[template] git_merge failed: ${msg}`);
    try { gitExec("git merge --abort", { cwd: repoDir, stdio: "pipe" }); } catch { /* already clean */ }
  }
}
