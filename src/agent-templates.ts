/**
 * Agent behavior templates — define pre-actions, post-actions, tool
 * restrictions, and prompt customization per task type / role.
 *
 * System defaults are defined here. In the future, user-defined
 * templates can be loaded from the API or a YAML config file.
 */

import fs from "node:fs";
import path from "node:path";
import type { ApiClient, Task } from "./api-client.js";
import * as ui from "./ui.js";
import { logError, CLI_ERR } from "./error-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action executed before or after the agent runs */
export interface TemplateAction {
  /** Action type */
  type: "update_task" | "update_agent" | "git_merge" | "git_push" | "git_auth_check" | "review_changes" | "submit_retro" | "notify_user" | "shell" | "inject_memory" | "collect_memory";
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
      { type: "inject_memory", label: "Inject agent memory into CLAUDE.md" },
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "collect_memory", when: "success", label: "Collect agent memory" },
      { type: "git_merge", when: "success", label: "Merge branch to base" },
      { type: "git_push", when: "success", label: "Push main to remote" },
      { type: "review_changes", when: "success", label: "Auto-review code changes" },
      { type: "update_task", params: { status: "review" }, when: "success", label: "Move task to review" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "notify_user", params: { message: "⚠️ Task \"{{taskTitle}}\" {{status}}" }, when: "failure", label: "Notify user of failure" },
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      completion: `IMPORTANT: Work ONLY on the assigned task described above. Do NOT fix other issues you discover, do NOT refactor unrelated code, do NOT add features not requested. If you find other issues, mention them in your RETRO_JSON suggested_tasks instead.
Focus on files relevant to your task. Do not explore the entire codebase.
Do NOT run git push — the CLI will handle pushing after you finish.
Do NOT call curl or any API endpoints directly — the CLI handles all API communication.

When completing a task:
1. Commit your changes: git add -A && git commit -m "<message>"
2. Output a completion report on a new line in this exact format:
COMPLETION_JSON:{"review_comment":"<summary: what was changed, key files, approach taken>","commits":"<comma-separated commit hashes from git log --format=%H origin/HEAD..HEAD>"}

The CLI will automatically update the task status and submit this data. Do NOT manually call any API.`,
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
      { type: "inject_memory", label: "Inject agent memory into CLAUDE.md" },
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "collect_memory", when: "success", label: "Collect agent memory" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "notify_user", params: { message: "⚠️ Task \"{{taskTitle}}\" {{status}}" }, when: "failure", label: "Notify user of failure" },
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      mode_header: "## READ-ONLY MODE — Do NOT modify any files, create commits, or push code.",
      completion: `Your job is to investigate, analyze, and report findings. Use Read, Grep, Glob, and Bash (for read-only commands like ls, git log, etc.) to gather information.
Do NOT call curl or any API endpoints directly — the CLI handles all API communication.

When your investigation is complete:
1. Write a clear, detailed summary of your findings.
2. Output a completion report on a new line in this exact format:
COMPLETION_JSON:{"review_comment":"<your detailed findings and recommendations>"}

The CLI will automatically update the task status and submit this data.

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
    language?: string;
    engine?: string;
  };
  /** Agent exit code (only available in post_actions) */
  exitCode?: number | null;
  /** Merge function (injected from runner) */
  onMerge?: () => boolean;
  /** Retro submit function (injected from runner) */
  onRetro?: () => Promise<void>;
  /** Broadcast data updates to connected WS clients */
  onDataUpdate?: (entity: string, id: string, changes: Record<string, unknown>) => void;
  /** Broadcast review progress to connected WS clients */
  onReviewUpdate?: (taskId: string, phase: string, reviewComment?: string) => void;
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
          ctx.onDataUpdate?.("task", ctx.task.id, updates);
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
          ctx.onDataUpdate?.("agent", ctx.agentName, { status: status ?? "working", activity: activity ?? `Task ${ctx.task.id}` });
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
            logError(CLI_ERR.GIT_MERGE_FAILED, `git_merge failed: ${msg}`, { taskId: ctx.task.id }, mergeErr);
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
          ctx.onReviewUpdate?.(ctx.task.id, "started");
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
            ui.debug("review", `repo dir: ${revRepoDir}`);
            // Get the merge commit and its details
            const lastCommit = revExec("git log --oneline -1", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();
            const commitBody = revExec("git log -1 --format=%b", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();
            // Use merge commit diff (HEAD^..HEAD for merge, HEAD~1 for regular)
            const parentCount = (revExec("git cat-file -p HEAD", { cwd: revRepoDir, stdio: "pipe" }).toString().match(/^parent /gm) || []).length;
            const diffRef = parentCount >= 2 ? "HEAD^..HEAD" : "HEAD~1";
            const diffStat = revExec(`git diff ${diffRef} --stat`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
            const diffContent = revExec(`git diff ${diffRef} --no-color`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString();

            // Build review summary with commit description + file stats
            const lines = diffContent.split("\n").length;
            const filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

            // LLM review: ask Claude to review the diff against the task requirements
            ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
            let llmReview = "";
            try {
              const { spawn: reviewSpawn } = await import("node:child_process");
              const diffForReview = diffContent.slice(0, 8000); // Limit diff size for prompt
              const lang = ctx.config.language === "ja" ? "Japanese" : "English";
              const reviewPrompt = `You are reviewing code changes made by an AI agent. Reply in ${lang}.

Task: ${ctx.task.title}
Description: ${ctx.task.description || "No description"}

Git diff:
${diffForReview}

You MUST respond with ONLY a JSON object (no markdown, no explanation). Every field is required:

{"requirement_match":"Does the diff address the task? List each requirement and whether met.","files_changed":"List each changed file with a one-line summary.","code_quality":"Issues: naming, complexity, error handling, security. Or 'No issues found'.","test_coverage":"Were tests added/updated? Untested paths or edge cases?","risks":"Regressions, breaking changes, deployment concerns. Or 'None identified'.","verdict":"APPROVE or NEEDS_CHANGES (with items to fix)"}

Respond with the JSON object only. No wrapping markdown code blocks.`;

              const env = { ...process.env };
              delete env.CLAUDECODE;
              const LLM_TIMEOUT = 120_000; // 2 minutes
              llmReview = await new Promise<string>((resolve) => {
                const child = reviewSpawn("claude", ["--print", "--model", "claude-sonnet-4-20250514", reviewPrompt], {
                  env, stdio: ["ignore", "pipe", "pipe"], timeout: LLM_TIMEOUT,
                });
                let out = "";
                let resolved = false;
                child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
                child.on("close", (code) => {
                  if (!resolved) { resolved = true; resolve(out.trim()); }
                  if (code !== 0) ui.warn(`[review] LLM exited with code ${code}`);
                });
                child.on("error", (err) => {
                  if (!resolved) { resolved = true; resolve(""); }
                  ui.warn(`[review] LLM spawn error: ${err.message}`);
                });
                setTimeout(() => {
                  if (!resolved) { resolved = true; resolve(""); }
                  try { child.kill(); } catch {}
                  ui.warn("[review] LLM review timed out (120s)");
                }, LLM_TIMEOUT);
              });
            } catch (llmErr) {
              logError(CLI_ERR.REVIEW_LLM_FAILED, `LLM review failed`, { taskId: ctx.task.id }, llmErr);
              ui.warn(`[review] LLM review failed: ${llmErr instanceof Error ? llmErr.message : llmErr}`);
            }

            // Get commit hash for the merge
            const commitHash = revExec("git rev-parse HEAD", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();

            // Try structured review-report API first
            let reviewSaved = false;
            if (llmReview) {
              try {
                // Parse LLM output as JSON (strip markdown code blocks if present)
                const cleanJson = llmReview.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
                const report = JSON.parse(cleanJson);
                report.commits = commitHash;
                // Normalize verdict to match API enum
                if (report.verdict) {
                  const v = String(report.verdict).toUpperCase().trim();
                  if (v.includes("NEEDS") || v.includes("CHANGE") || v.includes("REJECT")) {
                    report.verdict = "NEEDS_CHANGES";
                  } else {
                    report.verdict = "APPROVE";
                  }
                }
                const res = await fetch(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}/review-report`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.config.apiKey}` },
                  body: JSON.stringify(report),
                });
                if (res.ok) {
                  reviewSaved = true;
                  const reviewJson = JSON.stringify(report);
                  ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: reviewJson, commits: commitHash });
                  ctx.onReviewUpdate?.(ctx.task.id, "completed", reviewJson);
                } else {
                  const errBody = await res.text().catch(() => "");
                  ui.warn(`[review] review-report API ${res.status}: ${errBody.slice(0, 200)}`);
                }
              } catch (parseErr) {
                ui.warn(`[review] Structured review failed: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
              }
            }

            // Fallback: save as plain text review
            if (!reviewSaved) {
              const review = [
                `Agent: ${ctx.agentName}`,
                `Commit: ${lastCommit}`,
                commitBody ? `\n${commitBody}` : "",
                `\nFiles changed: ${filesChanged.length}`,
                diffStat,
                lines > 200 ? `(${lines} lines of diff)` : "",
                llmReview ? `\n--- Code Review ---\n${llmReview}` : "",
              ].filter(Boolean).join("\n").slice(0, 4000);
              await ctx.api.updateTask(ctx.task.id, { review_comment: review, commits: commitHash } as Partial<Task>);
              ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: review, commits: commitHash });
              ctx.onReviewUpdate?.(ctx.task.id, "completed", review);
            }
            ui.info( `[${phase}] ${label}: ${filesChanged.length} files${llmReview ? " + LLM review" : ""}`);
          } catch (revErr) {
            const msg = revErr instanceof Error ? revErr.message : String(revErr);
            logError(CLI_ERR.ACTION_FAILED, `review_changes failed at ${revRepoDir}: ${msg}`, { taskId: ctx.task.id, repoDir: revRepoDir }, revErr);
            ui.warn(`[review] review_changes failed at ${revRepoDir}: ${msg}`);
            ctx.onReviewUpdate?.(ctx.task.id, "failed");
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
        case "inject_memory": {
          // Claude-specific: write agent memories + directory hints into CLAUDE.md
          if (ctx.config.engine !== "claude") {
            ui.debug("template", `inject_memory skipped (engine: ${ctx.config.engine})`);
            break;
          }

          const claudeMdPath = path.join(ctx.config.workingDir, "CLAUDE.md");
          const hasClaudeMd = fs.existsSync(claudeMdPath);
          let injected = 0;

          // If no CLAUDE.md exists, generate directory structure hint
          if (!hasClaudeMd) {
            try {
              const { execSync: lsExec } = await import("node:child_process");
              const tree = lsExec("find . -maxdepth 2 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.wrangler/*' | head -40", {
                cwd: ctx.config.workingDir, stdio: "pipe", timeout: 5000,
              }).toString().trim();
              const hint = `# Repository Structure (auto-generated)\n\n\`\`\`\n${tree}\n\`\`\`\n\nNote: This file was auto-generated because no CLAUDE.md was found.\n`;
              fs.writeFileSync(claudeMdPath, hint);
              ui.info(`[${phase}] Generated CLAUDE.md with directory structure`);
            } catch { /* non-fatal */ }
          }

          // Inject agent memories
          const memories = await ctx.api.fetchAgentMemories(ctx.agentName);
          if (memories.length > 0) {
            const memoryBlock = [
              "<!-- TOBAN_MEMORY_START -->",
              "# Agent Memory (auto-injected by Toban)",
              "",
              ...memories.map((m) => `## ${m.type}: ${m.key}\n${m.content}`),
              "<!-- TOBAN_MEMORY_END -->",
            ].join("\n");

            const existing = fs.existsSync(claudeMdPath)
              ? fs.readFileSync(claudeMdPath, "utf-8")
              : "";
            fs.writeFileSync(claudeMdPath, existing + "\n\n" + memoryBlock + "\n");
            injected = memories.length;
          }

          if (injected > 0 || !hasClaudeMd) {
            ui.info(`[${phase}] ${label}: ${injected} memories${!hasClaudeMd ? " + dir structure" : ""}`);
          }
          break;
        }
        case "collect_memory": {
          // Claude-specific: read .claude/projects/*/memory/*.md and save to API
          if (ctx.config.engine !== "claude") {
            ui.debug("template", `collect_memory skipped (engine: ${ctx.config.engine})`);
            break;
          }
          const claudeDir = path.join(ctx.config.workingDir, ".claude");
          if (!fs.existsSync(claudeDir)) break;

          // Find memory files under .claude/projects/*/memory/
          const memFiles: string[] = [];
          const projectsDir = path.join(claudeDir, "projects");
          if (fs.existsSync(projectsDir)) {
            for (const proj of fs.readdirSync(projectsDir)) {
              const memDir = path.join(projectsDir, proj, "memory");
              if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
                for (const f of fs.readdirSync(memDir)) {
                  if (f.endsWith(".md") && f !== "MEMORY.md") {
                    memFiles.push(path.join("projects", proj, "memory", f));
                  }
                }
              }
            }
          }
          if (memFiles.length === 0) break;

          let saved = 0;
          for (const relFile of memFiles) {
            try {
              const content = fs.readFileSync(path.join(claudeDir, relFile), "utf-8");
              // Parse frontmatter: ---\nname: ...\ntype: ...\n---\nbody
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
              if (!fmMatch) continue;

              const frontmatter = fmMatch[1];
              const body = fmMatch[2].trim();
              const getName = frontmatter.match(/^name:\s*(.+)$/m);
              const getType = frontmatter.match(/^type:\s*(.+)$/m);
              if (!getName || !getType || !body) continue;

              const key = getName[1].trim();
              const memType = getType[1].trim();
              if (!["identity", "feedback", "project", "reference"].includes(memType)) continue;

              await ctx.api.putAgentMemory(ctx.agentName, key, { type: memType, content: body });
              saved++;
            } catch {
              // Skip unparseable files
            }
          }
          if (saved > 0) ui.info(`[${phase}] ${label}: ${saved} memory entries saved`);
          break;
        }
        default:
          ui.warn(`[template] Unknown action type: ${action.type}`);
      }
    } catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `${phase} action "${label}" failed`, { taskId: ctx.task.id, action: action.type, phase }, err);
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
