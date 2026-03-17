/**
 * Agent behavior templates — define pre-actions, post-actions, tool
 * restrictions, and prompt customization per task type / role.
 *
 * System defaults are defined here. In the future, user-defined
 * templates can be loaded from the API or a YAML config file.
 */

import type { ApiClient, Task } from "./api-client.js";
import * as ui from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action executed before or after the agent runs */
export interface TemplateAction {
  /** Action type */
  type: "update_task" | "update_agent" | "git_merge" | "git_push" | "git_auth_check" | "review_changes" | "submit_retro" | "notify_user" | "shell";
  /** Parameters passed to the action */
  params?: Record<string, unknown>;
  /** Human-readable description */
  label?: string;
  /** Only run this action if the condition is met */
  when?: "success" | "failure" | "always";
}

export interface AgentTemplate {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** When this template applies (empty = fallback) */
  match: {
    task_types?: string[];
    roles?: string[];
  };
  /** Tools the agent can use ("all" or specific list) */
  tools: "all" | string[];
  /** Actions to run before the agent starts */
  pre_actions: TemplateAction[];
  /** Actions to run after the agent finishes */
  post_actions: TemplateAction[];
  /** Prompt customization */
  prompt: {
    /** Injected before the task instructions */
    mode_header?: string;
    /** Completion instructions (replaces default commit/push block) */
    completion: string;
    /** Additional rules injected into the prompt */
    rules?: string[];
  };
}

// ---------------------------------------------------------------------------
// Default templates (system-defined)
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATES: AgentTemplate[] = [
  {
    id: "implementation",
    name: "Implementation (default)",
    match: {},
    tools: "all",
    pre_actions: [
      { type: "git_auth_check", label: "Verify git push credentials" },
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "git_merge", when: "success", label: "Merge branch to base" },
      { type: "git_push", when: "success", label: "Push main to remote" },
      { type: "review_changes", when: "success", label: "Auto-review code changes" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "notify_user", params: { message: "⚠️ Task \"{{taskTitle}}\" {{status}}" }, when: "failure", label: "Notify user of failure" },
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      completion: `Focus on files relevant to your task. Do not explore the entire codebase.
Do NOT run git push — the CLI will handle pushing after you finish.

When completing a task:
1. Commit: git add -A && git commit -m "<message>"
2. Collect your commit hashes: COMMITS=$(git log --format="%H" origin/HEAD..HEAD | tr '\\n' ',' | sed 's/,$//')
3. Move task to review with summary and commit hashes:
   curl -s -X PATCH {{apiUrl}}/api/v1/tasks/{{taskId}} -H "Content-Type: application/json" -H "Authorization: Bearer {{apiKey}}" -d "{\\\"status\\\":\\\"review\\\",\\\"review_comment\\\":\\\"<summary of changes, key files>\\\",\\\"commits\\\":\\\"$COMMITS\\\"}"`,
    },
  },
  {
    id: "research",
    name: "Research / Investigation",
    match: {
      task_types: ["research", "investigation", "analysis", "audit"],
    },
    tools: ["Read", "Grep", "Glob", "Bash", "Agent"],
    pre_actions: [
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "notify_user", params: { message: "⚠️ Task \"{{taskTitle}}\" {{status}}" }, when: "failure", label: "Notify user of failure" },
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      mode_header: "## READ-ONLY MODE — Do NOT modify any files, create commits, or push code.",
      completion: `Your job is to investigate, analyze, and report findings. Use Read, Grep, Glob, and Bash (for read-only commands like ls, git log, etc.) to gather information.

When your investigation is complete:
1. Write a clear, detailed summary of your findings.
2. Move the task to review with your findings as the review comment:
   curl -s -X PATCH {{apiUrl}}/api/v1/tasks/{{taskId}} -H "Content-Type: application/json" -H "Authorization: Bearer {{apiKey}}" -d "{\\\"status\\\":\\\"review\\\",\\\"review_comment\\\":\\\"<your detailed findings>\\\"}"

DO NOT: git add, git commit, git push, or modify any files. Only read and analyze.`,
      rules: [
        "You MUST NOT create, edit, write, or delete any files.",
        "You MUST NOT run git add, git commit, git push, or any destructive commands.",
        "Your output is a written report in the review_comment field.",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Template matching
// ---------------------------------------------------------------------------

/**
 * Find the best matching template for a given task.
 * Checks task_types first, then roles, then falls back to default.
 */
export function matchTemplate(
  taskType?: string,
  role?: string,
  templates?: AgentTemplate[]
): AgentTemplate {
  const list = templates ?? DEFAULT_TEMPLATES;

  // 1. Match by task type (most specific)
  if (taskType) {
    const byType = list.find(
      (t) => t.match.task_types?.includes(taskType.toLowerCase())
    );
    if (byType) return byType;
  }

  // 2. Match by role
  if (role) {
    const byRole = list.find(
      (t) => t.match.roles?.includes(role.toLowerCase())
    );
    if (byRole) return byRole;
  }

  // 3. Fallback to default (first template with empty match)
  const fallback = list.find(
    (t) => !t.match.task_types?.length && !t.match.roles?.length
  );
  return fallback ?? DEFAULT_TEMPLATES[0];
}

// ---------------------------------------------------------------------------
// Template variable interpolation
// ---------------------------------------------------------------------------

/** Replace {{var}} placeholders in template strings */
export function interpolate(
  text: string,
  vars: Record<string, string>
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// ---------------------------------------------------------------------------
// Pre/Post action execution
// ---------------------------------------------------------------------------

export interface ActionContext {
  api: ApiClient;
  task: Task;
  agentName: string;
  config: {
    apiUrl: string;
    apiKey: string;
    workingDir: string;
    baseBranch: string;
    sprintNumber?: number;
  };
  /** Agent exit code (only available in post_actions) */
  exitCode?: number | null;
  /** Merge function (injected from runner) */
  onMerge?: () => boolean;
  /** Retro submit function (injected from runner) */
  onRetro?: () => Promise<void>;
}

/**
 * Execute a list of template actions.
 * Filters by `when` condition (success/failure/always).
 */
export async function executeActions(
  actions: TemplateAction[],
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const isSuccess = ctx.exitCode === 0 || ctx.exitCode === undefined;

  ui.info(`[template] Executing ${phase}_actions (${actions.length} actions, exitCode=${ctx.exitCode})`);
  for (const action of actions) {
    // Check `when` condition
    if (action.when === "success" && !isSuccess) { ui.info(`[template]   skip: ${action.label} (when=success, but failed)`); continue; }
    if (action.when === "failure" && isSuccess) continue;

    const label = action.label ?? `${action.type}`;
    try {
      switch (action.type) {
        case "update_task": {
          const updates = action.params ?? {};
          await ctx.api.updateTask(ctx.task.id, updates as Partial<Task>);
          ui.info( `[${phase}] ${label}`);
          break;
        }
        case "update_agent": {
          const { status, activity } = (action.params ?? {}) as {
            status?: string;
            activity?: string;
          };
          await fetch(`${ctx.config.apiUrl}/api/v1/agents`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${ctx.config.apiKey}`,
            },
            body: JSON.stringify({
              name: ctx.agentName,
              status: status ?? "working",
              activity: activity ?? `Task ${ctx.task.id}: ${ctx.task.title}`,
            }),
          });
          ui.info( `[${phase}] ${label}`);
          break;
        }
        case "git_merge": {
          const { execSync: gitExec } = await import("node:child_process");
          const { existsSync: gitExists } = await import("node:fs");
          const { join: gitJoin } = await import("node:path");
          // workingDir is the worktree path — we need the main repo root
          // Worktree is at <repo>/.worktrees/<branch>/, so repo root is 2 levels up
          const worktreePath = ctx.config.workingDir;
          const repoDir = gitExec("git rev-parse --path-format=absolute --git-common-dir", { cwd: worktreePath, stdio: "pipe" })
            .toString().trim().replace(/\/.git$/, "");
          const baseBranch = ctx.config.baseBranch;

          // Find the agent's worktree branch
          try {
            const branches = gitExec("git branch", { cwd: repoDir, stdio: "pipe" }).toString();
            const worktreeBranch = branches.split("\n")
              .map((b) => b.trim().replace(/^[*+]\s+/, ""))
              .find((b) => b.startsWith("agent/"));

            if (worktreeBranch) {
              // Find worktree path for cleanup
              const worktreeDir = gitJoin(repoDir, ".worktrees", worktreeBranch.replace(/\//g, "-"));

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
            ui.warn(`[template] git_merge failed: ${msg}`);
            try { gitExec("git merge --abort", { cwd: repoDir, stdio: "pipe" }); } catch { /* already clean */ }
          }
          break;
        }
        case "git_auth_check": {
          const { execSync: exec } = await import("node:child_process");
          try {
            exec("git ls-remote --exit-code origin HEAD", {
              cwd: ctx.config.workingDir,
              stdio: "pipe",
              timeout: 15_000,
            });
            ui.info( `[${phase}] ${label}: ok`);
          } catch (authErr) {
            const msg = authErr instanceof Error ? authErr.message : String(authErr);
            throw new Error(`Git auth check failed — push will not work. Fix credentials before spawning agent.\n${msg.slice(0, 200)}`);
          }
          break;
        }
        case "git_push": {
          const { execSync: pushExec } = await import("node:child_process");
          // Resolve repo root (workingDir may be a worktree)
          const pushRepoDir = pushExec("git rev-parse --path-format=absolute --git-common-dir", { cwd: ctx.config.workingDir, stdio: "pipe" })
            .toString().trim().replace(/\/.git$/, "");
          try {
            pushExec(`git push origin ${ctx.config.baseBranch}`, {
              cwd: pushRepoDir,
              stdio: "pipe",
            });
            ui.info( `[${phase}] ${label}: pushed ${ctx.config.baseBranch}`);
          } catch (pushErr) {
            const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            ui.warn(`[template] git_push failed: ${msg}`);
          }
          break;
        }
        case "submit_retro": {
          if (ctx.onRetro) {
            await ctx.onRetro();
            ui.info( `[${phase}] ${label}`);
          }
          break;
        }
        case "review_changes": {
          const { execSync: revExec } = await import("node:child_process");
          const { existsSync: revExists } = await import("node:fs");
          // workingDir may be a deleted worktree after git_merge — resolve repo root
          const revRepoDir = (() => {
            // Try workingDir first (may be worktree or repo root)
            if (revExists(ctx.config.workingDir)) {
              try {
                return revExec("git rev-parse --path-format=absolute --git-common-dir", { cwd: ctx.config.workingDir, stdio: "pipe" })
                  .toString().trim().replace(/\/.git$/, "");
              } catch { /* fall through */ }
            }
            // Worktree deleted — walk up to find the repo root
            const { dirname } = require("node:path");
            let dir = ctx.config.workingDir;
            for (let i = 0; i < 5; i++) {
              dir = dirname(dir);
              if (revExists(dir + "/.git")) return dir;
            }
            return ctx.config.workingDir;
          })();
          try {
            // Get the merge commit (most recent) and its diff
            const lastCommit = revExec("git log --oneline -1", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();
            const diffStat = revExec("git diff HEAD~1 --stat", { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
            const diffContent = revExec("git diff HEAD~1 --no-color", { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString();

            // Build review summary (keep it compact for API)
            const lines = diffContent.split("\n").length;
            const filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
            const review = [
              `Commit: ${lastCommit}`,
              `Files changed: ${filesChanged.length}`,
              diffStat,
              lines > 200 ? `(${lines} lines of diff)` : "",
            ].filter(Boolean).join("\n").slice(0, 4000); // Limit size

            await ctx.api.updateTask(ctx.task.id, { review_comment: review } as Partial<Task>);
            ui.info( `[${phase}] ${label}: ${filesChanged.length} files`);
          } catch (revErr) {
            const msg = revErr instanceof Error ? revErr.message : String(revErr);
            ui.warn(`[template] review_changes failed: ${msg}`);
            // Still set a basic comment
            try {
              await ctx.api.updateTask(ctx.task.id, { review_comment: "Auto-review failed. Please review manually." } as Partial<Task>);
            } catch { /* non-fatal */ }
          }
          break;
        }
        case "notify_user": {
          const template = (action.params?.message as string) ?? "Task {{taskTitle}} {{status}}";
          const status = ctx.exitCode === 0 ? "completed" : `failed (exit code: ${ctx.exitCode})`;
          const message = template
            .replace("{{taskTitle}}", ctx.task.title)
            .replace("{{taskId}}", ctx.task.id.slice(0, 8))
            .replace("{{status}}", status);
          try {
            await ctx.api.sendMessage("manager", "user", message);
            ui.info( `[${phase}] ${label}`);
          } catch { /* non-fatal */ }
          break;
        }
        case "shell": {
          const cmd = action.params?.command as string | undefined;
          if (cmd) {
            const { execSync } = await import("node:child_process");
            execSync(cmd, { cwd: ctx.config.workingDir, stdio: "pipe" });
            ui.info( `[${phase}] ${label}`);
          }
          break;
        }
        default:
          ui.warn(`[template] Unknown action type: ${action.type}`);
      }
    } catch (err) {
      ui.warn(`[template] ${phase} action "${label}" failed: ${err}`);
    }
  }
}

/**
 * Get the list of default templates.
 * In the future, this will merge system defaults with user-defined templates
 * loaded from the API or a config file.
 */
export function getTemplates(): AgentTemplate[] {
  return DEFAULT_TEMPLATES;
}
