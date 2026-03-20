/**
 * Agent behavior templates — define pre-actions, post-actions, tool
 * restrictions, and prompt customization per task type / role.
 *
 * System defaults are defined here. In the future, user-defined
 * templates can be loaded from the API or a YAML config file.
 */

import fs from "node:fs";
import path from "node:path";

/** Track retry counts per task to prevent infinite NEEDS_CHANGES loops */
const retryTracker = new Map<string, number>();
import type { ApiClient, Task } from "./api-client.js";
import * as ui from "./ui.js";
import { logError, CLI_ERR } from "./error-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action executed before or after the agent runs */
export interface TemplateAction {
  /** Action type */
  type: "update_task" | "update_agent" | "git_merge" | "git_push" | "git_auth_check" | "review_changes" | "spawn_reviewer" | "submit_retro" | "notify_user" | "shell" | "inject_memory" | "collect_memory";
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
  /** Allow task to pass review when agent reports completion without code commits */
  allow_no_commit_completion?: boolean;
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
    allow_no_commit_completion: true,
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
      { type: "spawn_reviewer", when: "success", label: "Spawn Reviewer agent for code review" },
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
    allow_no_commit_completion: true,
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
  {
    id: "content",
    name: "Content / Documentation",
    allow_no_commit_completion: true,
    match: {
      task_types: ["content", "docs", "documentation"],
    },
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
      { type: "spawn_reviewer", when: "success", label: "Spawn Reviewer agent for content review" },
      { type: "update_task", params: { status: "review" }, when: "success", label: "Move task to review" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      completion: `You are writing documentation or content. Focus on clarity, accuracy, and consistency.
IMPORTANT: Only modify files in docs/ or content directories. Do NOT change application code.
Do NOT run git push — the CLI will handle pushing after you finish.

When completing a task:
1. Commit your changes: git add -A && git commit -m "<message>"
2. Output a completion report on a new line in this exact format:
COMPLETION_JSON:{"review_comment":"<summary: what docs were created/updated, key changes>","commits":"<commit hashes>"}`,
      rules: [
        "Only modify documentation files (docs/, README, etc.)",
        "Do NOT change application source code",
        "Verify all links and references are valid",
      ],
    },
  },
  {
    id: "strategy",
    name: "Strategy / Planning",
    allow_no_commit_completion: true,
    match: {
      task_types: ["strategy", "planning"],
    },
    tools: ["Read", "Grep", "Glob", "Bash", "Agent", "WebSearch", "WebFetch"],
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
      { type: "update_agent", params: { status: "idle", activity: "Task failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      mode_header: "## STRATEGY MODE — Analyze, plan, and propose. Do NOT modify code or infrastructure.",
      completion: `You are a strategist. Research, analyze, and produce actionable recommendations.
Use WebSearch and WebFetch for market research, Read/Grep for codebase analysis.
Do NOT call curl or any API endpoints directly.

When your analysis is complete:
1. Write a clear, structured report with findings and recommendations.
2. Output a completion report on a new line:
COMPLETION_JSON:{"review_comment":"<your strategic analysis and recommendations>"}`,
      rules: [
        "You MUST NOT create, edit, write, or delete any files.",
        "Focus on analysis and recommendations, not implementation.",
        "Back claims with data or evidence from your research.",
      ],
    },
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    match: {
      roles: ["reviewer"],
    },
    tools: ["Read", "Grep", "Glob", "Bash", "Agent"],
    pre_actions: [],
    post_actions: [],
    prompt: {
      mode_header: "## REVIEW MODE — Analyze code changes, run tests, report verdict. Do NOT modify any files.",
      completion: `You are reviewing code changes for a task. You have LIMITED TURNS — be fast and direct.

## Step 1 (Turn 1): Run these two commands immediately
- git diff {{diffRef}} --stat
- npm test 2>&1 | tail -20

## Step 2 (Turn 2-3): Quick analysis
- If tests failed → verdict is NEEDS_CHANGES, skip to Step 3
- If diff is empty or metadata-only → verdict is NEEDS_CHANGES, skip to Step 3
- Glance at changed files — do they match the task description?

## Step 3: Output verdict IMMEDIATELY
Output COMPLETION_JSON right now. Do NOT do more analysis. Do NOT read additional files.

## Review Criteria
{{reviewCriteria}}

{{customReviewRules}}

CRITICAL RULES:
- Do NOT modify any files. Do NOT commit. Do NOT push.
- Do NOT explore the codebase beyond the diff. Do NOT read unrelated files.
- Output COMPLETION_JSON within your FIRST 3 TURNS. Every turn without COMPLETION_JSON is wasted.

COMPLETION_JSON:{"verdict":"APPROVE or NEEDS_CHANGES","requirement_match":"met/partial/not — explain","files_changed":"file: summary","code_quality":"issues or clean","test_coverage":"tested or not","risks":"risks or none"}`,
      rules: [
        "You MUST NOT create, edit, write, or delete any files.",
        "You MUST NOT run git add, git commit, git push.",
        "Run tests and read code to inform your review.",
        "Be strict: if changes don't match the task, verdict = NEEDS_CHANGES.",
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
  /** Agent worktree branch name (e.g. agent/builder-abc12345) */
  agentBranch?: string;
  /** Review verdict from LLM review (set by review_changes action) */
  reviewVerdict?: "APPROVE" | "NEEDS_CHANGES";
  /** Hash of HEAD before merge (set by git_merge, used by reviewer for accurate diff) */
  preMergeHash?: string;
  /** Set to true if git_merge was skipped (no agent commits or metadata-only) */
  mergeSkipped?: boolean;
  /** Parsed COMPLETION_JSON from agent output (set by cli.ts after agent finishes) */
  completionJson?: { review_comment?: string; commits?: string };
  /** The matched template for this task */
  template?: AgentTemplate;
  /** Per-task logger for debugging */
  taskLog?: { event(name: string, data?: Record<string, unknown>): void };
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
          const updates = { ...(action.params ?? {}) } as Record<string, unknown>;
          // If review verdict is NEEDS_CHANGES, check retry count
          if (updates.status === "review" && ctx.reviewVerdict === "NEEDS_CHANGES") {
            const MAX_RETRIES = 3;
            const retryCount = (retryTracker.get(ctx.task.id) ?? 0) + 1;
            retryTracker.set(ctx.task.id, retryCount);

            // Record failure to Failure DB
            const reviewComment = typeof ctx.task.review_comment === "string" ? ctx.task.review_comment : undefined;
            ctx.api.recordFailure({
              task_id: ctx.task.id,
              failure_type: "reject",
              summary: retryCount >= MAX_RETRIES
                ? `Blocked after ${retryCount} failed attempts: ${ctx.task.title}`
                : `NEEDS_CHANGES (attempt ${retryCount}): ${ctx.task.title}`,
              agent_name: ctx.config.agentName,
              sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
              review_comment: reviewComment,
            }).catch(() => { /* best-effort */ });

            if (retryCount >= MAX_RETRIES) {
              updates.status = "review";
              updates.review_comment = `Blocked: task failed ${retryCount} times. Needs human intervention.`;
              ui.error(`[${phase}] Task failed ${retryCount} times — moved to review for human intervention`);
            } else {
              updates.status = "todo";
              ui.warn(`[${phase}] Review verdict: NEEDS_CHANGES (attempt ${retryCount}/${MAX_RETRIES}) — resetting to todo`);
            }
          }
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
                break;
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
                break;
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
          break;
        }
        case "git_auth_check": {
          const { execSync: exec } = await import("node:child_process");
          try {
            // Use ls-remote without --exit-code (empty repos return exit 2 with --exit-code)
            exec("git ls-remote origin", {
              cwd: ctx.config.workingDir,
              stdio: "pipe",
              timeout: 15_000,
            });
            ui.info( `[${phase}] ${label}: ok`);
          } catch (authErr) {
            const msg = authErr instanceof Error ? authErr.message : String(authErr);
            // 403/401 = auth failure, other errors might be network
            if (msg.includes("403") || msg.includes("401") || msg.includes("denied")) {
              throw new Error(`Git auth check failed — push will not work. Fix credentials before spawning agent.\n${msg.slice(0, 200)}`);
            }
            // Non-auth errors (empty repo, network timeout) — warn but continue
            ui.warn(`[${phase}] ${label}: ${msg.slice(0, 100)} (continuing anyway)`);
          }
          break;
        }
        case "git_push": {
          if (ctx.mergeSkipped) { ui.info(`[${phase}] ${label}: skipped (no merge)`); break; }
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
        case "spawn_reviewer": {
          if (ctx.mergeSkipped) {
            const allowNoCommit = ctx.template?.allow_no_commit_completion ?? false;
            if (allowNoCommit && ctx.completionJson?.review_comment) {
              ui.info(`[${phase}] ${label}: no code changes, agent reported completion — sending to human review`);
            } else {
              ui.info(`[${phase}] ${label}: skipped (no merge${!ctx.completionJson ? ", no completion" : ""})`);
              ctx.reviewVerdict = "NEEDS_CHANGES";
            }
            break;
          }
          ctx.onReviewUpdate?.(ctx.task.id, "started");
          const { execSync: revExec2 } = await import("node:child_process");
          const { existsSync: revExists2 } = await import("node:fs");
          const { spawn: reviewSpawn2 } = await import("node:child_process");

          // Resolve repo root
          const reviewRepoDir = (() => {
            if (revExists2(ctx.config.workingDir)) {
              try {
                return revExec2("git rev-parse --path-format=absolute --git-common-dir", { cwd: ctx.config.workingDir, stdio: "pipe" })
                  .toString().trim().replace(/\/.git$/, "");
              } catch { /* fall through */ }
            }
            return ctx.config.workingDir;
          })();

          // Get diff ref for the reviewer prompt — use preMergeHash for accurate agent-only diff
          const diffRef = (() => {
            if (ctx.preMergeHash) return `${ctx.preMergeHash}..HEAD`;
            try {
              const parents = revExec2("git cat-file -p HEAD", { cwd: reviewRepoDir, stdio: "pipe" }).toString();
              const parentCount = (parents.match(/^parent /gm) || []).length;
              return parentCount === 0 ? "--root HEAD" : "HEAD~1..HEAD";
            } catch { return "HEAD~1..HEAD"; }
          })();

          // Get diff stat for context
          let filesChanged: string[] = [];
          try {
            const diffStat = revExec2(`git diff ${diffRef} --stat`, { cwd: reviewRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
            filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
          } catch { /* empty */ }

          // Check diff size — too large means task should be split
          let diffLineCount = 0;
          try {
            const diffRaw = revExec2(`git diff ${diffRef} --stat`, { cwd: reviewRepoDir, stdio: "pipe", timeout: 10_000 }).toString();
            const lastLine = diffRaw.trim().split("\n").pop() || "";
            const insertMatch = lastLine.match(/(\d+) insertion/);
            const deleteMatch = lastLine.match(/(\d+) deletion/);
            diffLineCount = (parseInt(insertMatch?.[1] || "0") + parseInt(deleteMatch?.[1] || "0"));
          } catch { /* non-fatal */ }

          if (diffLineCount > 300) {
            ui.warn(`[${phase}] ${label}: diff too large (${diffLineCount} lines) — NEEDS_CHANGES`);
            ctx.reviewVerdict = "NEEDS_CHANGES";
            try {
              await ctx.api.updateTask(ctx.task.id, {
                review_comment: JSON.stringify({
                  verdict: "NEEDS_CHANGES",
                  requirement_match: "not assessed — diff too large",
                  files_changed: filesChanged.join(", "),
                  code_quality: "not assessed",
                  test_coverage: "not assessed",
                  risks: `Diff is ${diffLineCount} lines. Task should be split into smaller subtasks for reliable review.`,
                }),
              } as Partial<Task>);
            } catch { /* non-fatal */ }
            break;
          }

          // Build reviewer prompt
          const taskType = (ctx.task as Record<string, unknown>).type as string || "implementation";
          const { PROMPT_TEMPLATES } = await import("./prompts/templates.js");
          const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

          // Fetch playbook rules for reviewer, including skill rules matching task labels
          let customRules = "";
          const taskLabels: string[] = (() => {
            const raw = (ctx.task as Record<string, unknown>).labels;
            if (Array.isArray(raw)) return raw;
            if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return []; } }
            return [];
          })();
          try { customRules = await ctx.api.fetchPlaybookPrompt("reviewer", taskLabels) || ""; } catch { /* non-fatal */ }

          const reviewerTemplate = DEFAULT_TEMPLATES.find((t) => t.id === "reviewer")!;
          const reviewCriteria = [
            "1. REQUIREMENT MATCH: Do changes address the task description? Unrelated = NEEDS_CHANGES",
            "2. SCOPE: Limited to what the task asks? Out-of-scope = NEEDS_CHANGES",
            "3. MEANINGFUL CHANGES: Real code/content? Metadata-only = NEEDS_CHANGES",
            "4. CODE QUALITY: Readability, security, error handling",
            `5. ${typeHints[taskType] || typeHints.implementation || ""}`,
            "",
            "If tests fail, verdict MUST be NEEDS_CHANGES.",
            "If changes don't match the task, verdict MUST be NEEDS_CHANGES.",
          ].join("\n");

          const reviewPrompt = interpolate(reviewerTemplate.prompt.completion, {
            diffRef,
            taskTitle: ctx.task.title,
            taskDescription: ctx.task.description || "(no description)",
            taskType,
            reviewCriteria,
            customReviewRules: customRules ? `\n${customRules}` : "",
          });

          const fullPrompt = `${reviewerTemplate.prompt.mode_header}\n\nTask: ${ctx.task.title}\nType: ${taskType}\nFiles changed: ${filesChanged.join(", ") || "unknown"}\n\n${reviewPrompt}`;

          // Spawn reviewer as agent process
          ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
          ui.info(`[${phase}] ${label}: spawning Reviewer agent (${filesChanged.length} files)`);

          const REVIEWER_TIMEOUT = 300_000; // 5 minutes
          const reviewResult = await new Promise<string>((resolve) => {
            const env = { ...process.env };
            delete env.CLAUDECODE;
            const child = reviewSpawn2("claude", [
              "--print", "--model", "claude-sonnet-4-20250514", "--max-turns", "5", fullPrompt,
            ], {
              env, cwd: reviewRepoDir, stdio: ["ignore", "pipe", "pipe"], timeout: REVIEWER_TIMEOUT,
            });
            let out = "";
            let resolved = false;
            child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
            child.stderr?.on("data", () => {}); // consume stderr
            child.on("close", () => { if (!resolved) { resolved = true; resolve(out); } });
            child.on("error", () => { if (!resolved) { resolved = true; resolve(out || ""); } });
            setTimeout(() => { if (!resolved) { resolved = true; try { child.kill(); } catch {} resolve(out || ""); } }, REVIEWER_TIMEOUT);
          });

          // Parse COMPLETION_JSON from reviewer output (supports COMPLETION_JSON: prefix and ```json blocks)
          let verdict: "APPROVE" | "NEEDS_CHANGES" = "NEEDS_CHANGES";
          let reviewComment = "";
          const completionMatch = reviewResult.match(/COMPLETION_JSON:(\{[\s\S]*?\})\s*$/m)
            || reviewResult.match(/```json\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/m)
            || reviewResult.match(/(\{[\s\S]*?"verdict"\s*:\s*"(?:APPROVE|NEEDS_CHANGES)"[\s\S]*?\})\s*$/m);
          if (completionMatch) {
            try {
              const report = JSON.parse(completionMatch[1]) as Record<string, unknown>;
              // Normalize verdict
              const v = String(report.verdict || "").toUpperCase();
              verdict = (v.includes("APPROVE") && !v.includes("NEEDS")) ? "APPROVE" : "NEEDS_CHANGES";
              report.verdict = verdict;
              reviewComment = JSON.stringify(report);

              // Save structured review
              try {
                await fetch(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}/review-report`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.config.apiKey}` },
                  body: JSON.stringify(report),
                });
              } catch { /* fallback below */ }
            } catch {
              reviewComment = reviewResult.slice(-2000);
            }
          } else {
            // No COMPLETION_JSON — use raw output as review
            reviewComment = reviewResult.slice(-2000) || "Reviewer agent produced no output";
          }

          // Save review comment if not saved via review-report
          if (!completionMatch) {
            await ctx.api.updateTask(ctx.task.id, { review_comment: reviewComment } as Partial<Task>);
          }

          ctx.reviewVerdict = verdict;
          ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: reviewComment });
          ctx.onReviewUpdate?.(ctx.task.id, "completed", reviewComment);
          ui.info(`[${phase}] ${label}: verdict = ${verdict}`);
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
            // Use merge commit diff (HEAD^..HEAD for merge, HEAD~1 for regular, --root for initial)
            const parentCount = (revExec("git cat-file -p HEAD", { cwd: revRepoDir, stdio: "pipe" }).toString().match(/^parent /gm) || []).length;
            const diffRef = parentCount >= 2 ? "HEAD^..HEAD" : parentCount === 1 ? "HEAD~1" : "--root HEAD";
            const diffStat = revExec(`git diff ${diffRef} --stat`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
            const diffContent = revExec(`git diff ${diffRef} --no-color`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString();

            // Build review summary with commit description + file stats
            const lines = diffContent.split("\n").length;
            const filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

            // Run tests before review to include results in the prompt
            let testResult = "";
            try {
              ctx.onReviewUpdate?.(ctx.task.id, "testing");
              const testOutput = revExec("npm test 2>&1 || true", {
                cwd: revRepoDir, stdio: "pipe", timeout: 60_000,
              }).toString().trim();
              const lastLines = testOutput.split("\n").slice(-10).join("\n");
              const passed = testOutput.includes("passed") && !testOutput.includes("failed");
              testResult = passed
                ? "Tests: ALL PASSED"
                : `Tests: SOME FAILED\n${lastLines}`;
            } catch {
              testResult = "Tests: could not run (no test script or timeout)";
            }

            // LLM review: ask Claude to review the diff against the task requirements
            ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
            let llmReview = "";
            try {
              const { spawn: reviewSpawn } = await import("node:child_process");
              // Keep full diff context but filter out test files for size reduction
              const diffLines = diffContent.split("\n");
              const filteredDiff: string[] = [];
              let inTestFile = false;
              for (const line of diffLines) {
                if (line.startsWith("diff --git")) {
                  inTestFile = /test|spec|__tests__/i.test(line);
                }
                if (!inTestFile) filteredDiff.push(line);
              }
              const diffForReview = (filteredDiff.join("\n") || diffContent).slice(0, 6000);
              const lang = ctx.config.language === "ja" ? "Japanese" : "English";
              const taskType = (ctx.task as Record<string, unknown>).type as string || "implementation";

              // Build review prompt from templates (customizable via prompts/templates.ts)
              const { PROMPT_TEMPLATES } = await import("./prompts/templates.js");
              const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;
              const reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
                projectName: ctx.config.workingDir.split("/").pop() || "unknown",
                language: lang,
                taskTitle: ctx.task.title,
                taskType,
                taskDescription: ctx.task.description || "(no description)",
                taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
                customReviewRules: await (async () => {
                  const labels: string[] = (() => {
                    const raw = (ctx.task as Record<string, unknown>).labels;
                    if (Array.isArray(raw)) return raw;
                    if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return []; } }
                    return [];
                  })();
                  let rules = "";
                  try { rules = await ctx.api.fetchPlaybookPrompt("reviewer", labels) || ""; } catch { /* */ }
                  return rules ? `\n## Project-Specific Review Rules\n${rules}` : "";
                })()
              });
              const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';

              const reviewPrompt = `${reviewSystem}

${testResult}

Diff (${filesChanged.length} files, ${lines} lines):
${diffForReview}

If tests failed, verdict MUST be NEEDS_CHANGES.

${outputFormat}`;

              const env = { ...process.env };
              delete env.CLAUDECODE;
              const LLM_TIMEOUT = 120_000; // 2 minutes
              llmReview = await new Promise<string>((resolve) => {
                const child = reviewSpawn("claude", ["--print", "--model", "claude-sonnet-4-20250514", "--max-turns", "1", reviewPrompt], {
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

            // If LLM timed out or failed, generate a stat-based review
            if (!llmReview) {
              llmReview = JSON.stringify({
                requirement_match: "LLM review timed out — manual review recommended",
                files_changed: filesChanged.map((f) => f).join(", ") || "See diff stat",
                code_quality: "Unable to assess (LLM timeout)",
                test_coverage: "Unable to assess (LLM timeout)",
                risks: "Manual review required — automated review was not completed",
                verdict: "NEEDS_CHANGES",
              });
              ctx.reviewVerdict = "NEEDS_CHANGES";
              ui.info("[review] Generated fallback review (LLM timeout)");
            }

            // Try structured review-report API first
            let reviewSaved = false;
            if (llmReview) {
              try {
                // Parse LLM output as JSON (strip markdown code blocks if present)
                const cleanJson = llmReview.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
                const report = JSON.parse(cleanJson);
                report.commits = commitHash;
                // Append diff stat to files_changed for context
                if (diffStat) {
                  report.files_changed = (report.files_changed || "") + "\n\n" + diffStat;
                }
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
                  ctx.reviewVerdict = report.verdict as "APPROVE" | "NEEDS_CHANGES";
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

            let existing = fs.existsSync(claudeMdPath)
              ? fs.readFileSync(claudeMdPath, "utf-8")
              : "";
            // Remove existing memory block to prevent duplicates
            existing = existing.replace(/<!-- TOBAN_MEMORY_START -->[\s\S]*?<!-- TOBAN_MEMORY_END -->\n?/g, "").trimEnd();
            fs.writeFileSync(claudeMdPath, existing + "\n\n" + memoryBlock + "\n");
            injected = memories.length;
          }

          // Mark CLAUDE.md as assume-unchanged so inject_memory additions don't get committed
          // Agent can still read the file, but git won't track the memory block changes
          if (injected > 0 && hasClaudeMd) {
            try {
              const { execSync: gitExec2 } = await import("node:child_process");
              gitExec2("git update-index --assume-unchanged CLAUDE.md", { cwd: ctx.config.workingDir, stdio: "pipe" });
            } catch { /* non-fatal — worktree may not support this */ }
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
      ctx.taskLog?.event("action_ok", { action: action.type, label });
    } catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `${phase} action "${label}" failed`, { taskId: ctx.task.id, action: action.type, phase }, err);
      ui.warn(`[template] ${phase} action "${label}" failed: ${err}`);
      ctx.taskLog?.event("action_error", { action: action.type, label, error: err instanceof Error ? err.message : String(err) });
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
