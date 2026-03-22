/**
 * Agent behavior templates — define pre-actions, post-actions, tool
 * restrictions, and prompt customization per task type / role.
 *
 * System defaults are defined here. In the future, user-defined
 * templates can be loaded from the API or a YAML config file.
 */

import { execSync } from "node:child_process";
import type { ApiClient, Task } from "./api-client.js";
import * as ui from "./ui.js";
import { logError, CLI_ERR } from "./error-logger.js";
import { trackRetry } from "./utils/retry-tracker.js";
import { handleGitMerge } from "./handlers/git-merge.js";
import { handleGitPush } from "./handlers/git-push.js";
import { handleSpawnReviewer } from "./handlers/spawn-reviewer.js";
import { handleReviewChanges } from "./handlers/review-changes.js";
import { handleInjectMemory, handleCollectMemory } from "./handlers/memory.js";
import { handleFetchRecentChanges, handleRecordChanges } from "./handlers/context-sharing.js";
import { resolveRepoRoot } from "./git-ops.js";
import { getExecError } from "./utils/exec-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action executed before or after the agent runs */
export interface TemplateAction {
  /** Action type */
  type: "update_task" | "update_agent" | "git_merge" | "git_push" | "git_auth_check" | "review_changes" | "spawn_reviewer" | "submit_retro" | "notify_user" | "shell" | "inject_memory" | "collect_memory" | "fetch_recent_changes" | "record_changes" | "verify_build";
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
      { type: "fetch_recent_changes", label: "Fetch recent changes from other agents" },
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "collect_memory", when: "success", label: "Collect agent memory" },
      { type: "record_changes", when: "success", label: "Record change summary for other agents" },
      { type: "git_merge", when: "success", label: "Merge branch to base" },
      { type: "verify_build", when: "success", label: "Verify build and tests pass" },
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
- {{testCommand}} 2>&1 | tail -20

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
    /** Agent's DB engine setting (e.g. "claude-opus") for model resolution */
    agentEngine?: string;
    /** Workspace build command (null = auto-detect, fallback to npm run build) */
    buildCommand?: string | null;
    /** Workspace test command (null = auto-detect, fallback to npm test) */
    testCommand?: string | null;
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
  /** Parsed RETRO_JSON from agent output (Builder's self-assessment: what went well, what to improve) */
  retroJson?: { went_well?: string; to_improve?: string; suggested_tasks?: Array<{ title: string }> };
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
  ui.info(`[template] Executing ${phase}_actions (${actions.length} actions, exitCode=${ctx.exitCode})`);
  for (const action of actions) {
    // Re-evaluate on each iteration (actions like verify_build may change exitCode mid-loop)
    const isSuccess = ctx.exitCode === 0 || ctx.exitCode === undefined;
    // Check `when` condition
    if (action.when === "success" && !isSuccess) { ui.info(`[template]   skip: ${action.label} (when=success, but failed)`); continue; }
    if (action.when === "failure" && isSuccess) continue;

    const label = action.label ?? `${action.type}`;
    try {
      switch (action.type) {
        case "update_task": {
          const updates = { ...(action.params ?? {}) } as Record<string, unknown>;
          // If Reviewer already saved a structured review via review-report API,
          // don't overwrite with Builder's COMPLETION_JSON text
          if (ctx.reviewVerdict && updates.review_comment && updates.status === "review") {
            delete updates.review_comment;
            delete updates.commits;
          }
          // If review verdict is NEEDS_CHANGES, check retry count
          if (updates.status === "review" && ctx.reviewVerdict === "NEEDS_CHANGES") {
            const { retryCount, maxed } = trackRetry(ctx.task.id);

            // Record failure to Failure DB (only on first attempt — avoid retry noise)
            if (retryCount === 1) {
              const reviewComment = typeof ctx.task.review_comment === "string" ? ctx.task.review_comment : undefined;
              ctx.api.recordFailure({
                task_id: ctx.task.id,
                failure_type: "reject",
                summary: `NEEDS_CHANGES: ${ctx.task.title}`,
                agent_name: ctx.agentName,
                sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
                review_comment: reviewComment,
              }).catch(() => { /* best-effort */ });
            }

            if (maxed) {
              updates.status = "review";
              updates.review_comment = `Blocked: task failed ${retryCount} times. Needs human intervention.`;
              ui.error(`[${phase}] Task failed ${retryCount} times — moved to review for human intervention`);
            } else {
              updates.status = "todo";
              ui.warn(`[${phase}] Review verdict: NEEDS_CHANGES (attempt ${retryCount}/3) — resetting to todo`);
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
          await handleGitMerge(action, ctx, phase);
          break;
        }
        case "git_auth_check": {
          const exec = execSync;
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
          await handleGitPush(action, ctx, phase);
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
          await handleSpawnReviewer(action, ctx, phase, actions);
          break;
        }
        case "review_changes": {
          await handleReviewChanges(action, ctx, phase);
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
            execSync(cmd, { cwd: ctx.config.workingDir, stdio: "pipe" });
            ui.info( `[${phase}] ${label}`);
          }
          break;
        }
        case "inject_memory": {
          await handleInjectMemory(action, ctx, phase);
          break;
        }
        case "collect_memory": {
          await handleCollectMemory(action, ctx, phase);
          break;
        }
        case "fetch_recent_changes": {
          await handleFetchRecentChanges(action, ctx, phase);
          break;
        }
        case "record_changes": {
          await handleRecordChanges(action, ctx, phase);
          break;
        }
        case "verify_build": {
          const repoDir = resolveRepoRoot(ctx.config.workingDir);
          const vbBuildCmd = ctx.config.buildCommand || "npm run build";
          const vbTestCmd = ctx.config.testCommand || "npm test";
          const vbTimeout = 180_000; // 3 minutes per command

          // Revert merge on failure (runs before git_push, so no remote damage)
          const revertMerge = () => {
            try {
              execSync("git reset --hard HEAD~1", { cwd: repoDir, stdio: "pipe", timeout: 10_000 });
              ui.warn(`[${phase}] ${label}: reverted merge on main`);
            } catch (revertErr) {
              ui.error(`[${phase}] ${label}: failed to revert merge: ${revertErr}`);
            }
          };

          ui.info(`[${phase}] ${label}: running build (${vbBuildCmd})...`);
          try {
            execSync(vbBuildCmd, { cwd: repoDir, stdio: "pipe", timeout: vbTimeout });
            ui.info(`[${phase}] ${label}: build passed`);
          } catch (buildErr) {
            const detail = getExecError(buildErr);
            ui.error(`[${phase}] ${label}: BUILD FAILED — ${detail.slice(0, 300)}`);
            ctx.exitCode = 1;
            revertMerge();
            ctx.taskLog?.event("action_error", { action: "verify_build", label, error: `Build failed: ${detail.slice(0, 200)}` });
            // Only record failure on first attempt to avoid retry noise
            const { retryCount: buildRetry } = trackRetry(`build:${ctx.task.id}`);
            if (buildRetry <= 1) {
              ctx.api.recordFailure({
                task_id: ctx.task.id,
                failure_type: "verify_build",
                summary: `Build failed: ${vbBuildCmd}\n${detail.slice(0, 500)}`,
                agent_name: ctx.agentName,
                sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
              }).catch(() => { /* best-effort */ });
            }
            break;
          }
          ui.info(`[${phase}] ${label}: running tests (${vbTestCmd})...`);
          try {
            execSync(vbTestCmd, { cwd: repoDir, stdio: "pipe", timeout: vbTimeout });
            ui.info(`[${phase}] ${label}: tests passed`);
          } catch (testErr) {
            const detail = getExecError(testErr);
            ui.error(`[${phase}] ${label}: TESTS FAILED — ${detail.slice(0, 300)}`);
            ctx.exitCode = 1;
            revertMerge();
            ctx.taskLog?.event("action_error", { action: "verify_build", label, error: `Tests failed: ${detail.slice(0, 200)}` });
            const { retryCount: testRetry } = trackRetry(`test:${ctx.task.id}`);
            if (testRetry <= 1) {
              ctx.api.recordFailure({
                task_id: ctx.task.id,
                failure_type: "verify_build",
                summary: `Tests failed: ${vbTestCmd}\n${detail.slice(0, 500)}`,
                agent_name: ctx.agentName,
                sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
              }).catch(() => { /* best-effort */ });
            }
            break;
          }
          ui.info(`[${phase}] ${label}: all checks passed`);
          break;
        }
        default:
          ui.warn(`[template] Unknown action type: ${action.type}`);
      }
      // Don't log action_ok if the action set exitCode (e.g. verify_build failure)
      if (ctx.exitCode === 0 || ctx.exitCode === undefined) {
        ctx.taskLog?.event("action_ok", { action: action.type, label });
      }
    } catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `${phase} action "${label}" failed`, { taskId: ctx.task.id, action: action.type, phase }, err);
      ui.warn(`[template] ${phase} action "${label}" failed: ${err}`);
      ctx.taskLog?.event("action_error", { action: action.type, label, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Get the list of default templates (internal, used by handlers).
 */
export function getDefaultTemplates(): AgentTemplate[] {
  return DEFAULT_TEMPLATES;
}

