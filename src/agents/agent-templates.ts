/**
 * Agent behavior templates — define pre-actions, post-actions, tool
 * restrictions, and prompt customization per task type / role.
 *
 * System defaults are defined here. In the future, user-defined
 * templates can be loaded from the API or a YAML config file.
 */

import { execSync } from "node:child_process";
import type { ApiClient, Task } from "../services/api-client.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../services/error-logger.js";
import type { GuardrailConfig } from "../utils/guardrail.js";
import { handleGitMerge } from "../pipeline/git-merge.js";
import { handleGitPush } from "../pipeline/git-push.js";
import { handleMergePipeline } from "../pipeline/merge-pipeline.js";
import { handleVerifyBuild } from "../pipeline/verify-build.js";
import { handleSpawnReviewer } from "../pipeline/spawn-reviewer.js";
import { handleReviewChanges } from "../pipeline/review-changes.js";
import { handleInjectMemory, handleCollectMemory } from "../pipeline/memory.js";
import { handleFetchRecentChanges, handleRecordChanges } from "../pipeline/context-sharing.js";
import { handleRuleMatch } from "../pipeline/rule-match.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action executed before or after the agent runs */
export interface TemplateAction {
  /** Action type */
  type: "update_task" | "update_agent" | "git_merge" | "git_push" | "git_auth_check" | "review_changes" | "spawn_reviewer" | "submit_retro" | "notify_user" | "shell" | "inject_memory" | "collect_memory" | "fetch_recent_changes" | "record_changes" | "verify_build" | "merge_pipeline" | "rule_match";
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
      { type: "merge_pipeline", when: "success", label: "Merge, verify build, push" },
      { type: "rule_match", when: "success", label: "Match diff against playbook rules" },
      // Slot released here — spawn_reviewer runs after idle, doesn't block next task
      { type: "update_task", params: { status: "review" }, when: "success", label: "Move task to review" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "spawn_reviewer", when: "success", label: "Spawn Reviewer agent for code review (async)" },
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
COMPLETION_JSON:{"review_comment":"<detailed summary — see below>","commits":"<comma-separated commit hashes from git log --format=%H origin/HEAD..HEAD>","builder_record":{"intent":"<why this change was needed>","changes_summary":["<change 1>","<change 2>"],"risks":["<risk 1>"]},"build_command":"<optional: custom build command if not npm run build>","test_command":"<optional: custom test command if not npm test, e.g. cd api && npm test>"}

review_comment MUST include ALL of these sections (2-4 sentences each):
- **Why**: What problem this solves and why the change was needed
- **What**: Specific changes made (new files, modified logic, removed code)
- **Files**: Key files changed and what was done in each
- **Decisions**: Any design choices made and why (e.g. "used X instead of Y because...")
- **Testing**: How the changes were verified (tests added, manual checks)

builder_record fields:
- intent: 1-2 sentence summary of WHY the change was needed (not what was done)
- changes_summary: array of key changes (e.g. ["Added JWT validation middleware", "Guarded 3 API endpoints"])
- risks: array of known risks or empty array (e.g. ["No integration tests for edge case X"])

build_command / test_command: ONLY include these if the default (npm run build / npm test) won't work for your changes. For monorepo subdirectories, specify the correct command (e.g. "cd api && npm test"). Omit if defaults are correct.

Bad example: "Implemented the feature"
Good example: "Why: Auth middleware was missing, causing unauthenticated API access. What: Added JWT verification + session management. Files: middleware/auth.ts (new, 45 lines), routes/index.ts (added auth guard to 3 endpoints). Decisions: Self-implemented JWT instead of express-jwt to avoid adding a dependency. Testing: Added 5 unit tests for token validation edge cases."

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
      { type: "update_task", params: { status: "review" }, when: "success", label: "Move task to review" },
      { type: "submit_retro", when: "success", label: "Submit retrospective" },
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
      { type: "spawn_reviewer", when: "success", label: "Spawn Reviewer agent for content review (async)" },
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
COMPLETION_JSON:{"review_comment":"<detailed summary: Why this doc was needed, What was created/updated, Key sections added, Decisions on structure/format>","commits":"<commit hashes>"}`,
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
    id: "story-decompose",
    name: "Story Decomposition",
    allow_no_commit_completion: true,
    match: {
      task_types: ["decompose"],
    },
    tools: ["Read", "Grep", "Glob", "Bash"],
    pre_actions: [
      { type: "inject_memory", label: "Inject agent memory into CLAUDE.md" },
      { type: "update_task", params: { status: "in_progress" }, label: "Mark task in_progress" },
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ],
    post_actions: [
      { type: "save_decomposition", when: "success", label: "Save decomposition to API" },
      { type: "update_agent", params: { status: "idle", activity: "Decomposition complete" }, when: "success", label: "Report agent idle" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset task to todo on failure" },
      { type: "update_agent", params: { status: "idle", activity: "Decomposition failed" }, when: "failure", label: "Report agent idle" },
    ],
    prompt: {
      mode_header: "## DECOMPOSE MODE — Read code, analyze, and decompose a Story into tasks. Do NOT modify any files.",
      completion: `You are a Story decomposition agent. Your job is to read the codebase and break a Story into concrete, implementable tasks.

## Story
Title: {{storyTitle}}
Description: {{storyDescription}}
{{storyFeedback}}

## Instructions
1. Read the codebase to understand the current architecture and relevant files
2. Decompose the Story into 2-6 tasks that together fulfill the Story's intent
3. For each task, provide:
   - title: concise, starts with a verb
   - acceptance_criteria: 2-5 testable conditions (REQUIRED, be specific)
   - files_hint: files likely to be modified (REQUIRED, use actual paths from the codebase)
   - priority: p1 (must-have) / p2 (should-have) / p3 (nice-to-have)
   - story_points: 1 (trivial) / 2 (small) / 3 (medium) / 5 (large)
   - type: feature / bug / chore / infra
   - steps: optional brief implementation notes (the agent will figure out the details)
4. Also suggest existing backlog tasks that relate to this Story (by ID prefix)

## Quality rules
- acceptance_criteria MUST be verifiable (build passes, behavior changes, test exists)
- files_hint MUST reference real files you found in the codebase
- Each task should be completable independently by one agent
- Order tasks by dependency (foundational first)

## Output
Output ONLY valid JSON on a new line:
COMPLETION_JSON:{"summary":"1-2 sentence rationale","tasks":[{"title":"...","acceptance_criteria":["..."],"files_hint":["..."],"priority":"p1","story_points":3,"type":"feature","steps":["optional"]}],"related_backlog":["8char-id"],"total_sp":0}`,
      rules: [
        "You MUST NOT create, edit, write, or delete any files.",
        "You MUST read actual source code to determine files_hint — do not guess.",
        "acceptance_criteria must be specific and testable, not vague.",
      ],
    },
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    match: {
      roles: ["reviewer"],
    },
    tools: ["Read", "Grep", "Glob", "Bash"],
    pre_actions: [],
    post_actions: [],
    prompt: {
      mode_header: "## REVIEW MODE — Analyze code changes ONLY. Do NOT run tests, do NOT modify files.",
      completion: `You are reviewing code changes for a task. Tests have ALREADY PASSED in verify_build. Your job is CODE REVIEW ONLY.

You have LIMITED TURNS (max 5) — be fast and direct. Do NOT run tests.

## Step 1 (Turn 1): Read the diff
- git diff {{diffRef}} --stat
- git diff {{diffRef}}

## Step 2 (Turn 2): Quick analysis
- If diff is empty or metadata-only → verdict is NEEDS_CHANGES
- Do the changes match the task description?
- Code quality: readability, security, error handling
- Are there obvious bugs or missing edge cases?

## Step 3: Output verdict IMMEDIATELY
Output COMPLETION_JSON right now. Do NOT read additional files. Do NOT run tests.

## Review Criteria
{{reviewCriteria}}

{{customReviewRules}}

CRITICAL RULES:
- Do NOT modify any files. Do NOT commit. Do NOT push.
- Do NOT explore the codebase beyond the diff. Do NOT read unrelated files.
- Output COMPLETION_JSON within your FIRST 3 TURNS. Every turn without COMPLETION_JSON is wasted.

COMPLETION_JSON:{"verdict":"APPROVE or NEEDS_CHANGES","requirement_match":"met/partial/not — explain","files_changed":"file.ts (+10 -3): summary of change","code_quality":"issues or clean","test_coverage":"tested or not","risks":"risks or none"}`,
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
    /** Guardrail config from workspace settings */
    guardrailConfig?: GuardrailConfig | null;
    /** Whether running in auto mode */
    autoMode?: boolean;
  };
  /** Agent exit code (only available in post_actions) */
  exitCode?: number | null;
  /** Agent worktree branch name (e.g. agent/builder-abc12345) */
  agentBranch?: string;
  /** Review verdict from LLM review (set by review_changes action) */
  reviewVerdict?: "APPROVE" | "NEEDS_CHANGES";
  /** Hash of HEAD before merge (set by git_merge, used by reviewer for accurate diff) */
  preMergeHash?: string;
  /** Hash of the merge commit itself (set by git_merge, used to bound reviewer diff) */
  mergeCommit?: string;
  /** Set to true if git_merge was skipped (no agent commits or metadata-only) */
  mergeSkipped?: boolean;
  /** Parsed COMPLETION_JSON from agent output (set by cli.ts after agent finishes) */
  completionJson?: Record<string, unknown>;
  /** Raw agent stdout lines (for templates that need to re-parse output) */
  agentStdout?: string[];
  /** Parsed RETRO_JSON from agent output (Builder's self-assessment: what went well, what to improve) */
  retroJson?: { went_well?: string; to_improve?: string; suggested_tasks?: Array<{ title: string }> };
  /** Structured builder record extracted from COMPLETION_JSON */
  builderRecord?: import("../utils/completion-schema.js").BuilderRecord;
  /** Accumulated review record (builder → reviewer → manager) */
  reviewRecord?: import("../utils/completion-schema.js").ReviewRecord;
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
  /** Event emitter for structured event recording */
  eventEmitter?: import("../utils/event-emitter.js").EventEmitter;
  /** Agent's stderr lines (for infra error classification) */
  agentStderr?: string[];
  /** Job queue for enrich/review jobs (if available) */
  jobQueue?: import("../services/job-queue.js").JobQueue;
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
          // Note: NEEDS_CHANGES retry logic is handled by spawn_reviewer itself
          // (runs async after slot release, self-contained retry + auto-transition)
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
        case "save_decomposition": {
          // Parse COMPLETION_JSON and save decomposed tasks via API
          // Try completionJson first, then re-extract from stdout if tasks array is missing
          let decomp: {
            summary?: string;
            tasks?: Array<{
              title: string;
              acceptance_criteria?: string[];
              files_hint?: string[];
              priority?: string;
              story_points?: number;
              type?: string;
              steps?: string[];
            }>;
            related_backlog?: string[];
            total_sp?: number;
          } = (ctx.completionJson ?? {}) as typeof decomp;

          // If tasks missing, try to re-extract from agent stdout
          if (!decomp.tasks?.length && ctx.agentStdout?.length) {
            for (const line of ctx.agentStdout) {
              const text = typeof line === "string" ? line : "";
              // Direct COMPLETION_JSON line
              const directMatch = text.match(/COMPLETION_JSON:\s*(\{[\s\S]*\})\s*$/);
              if (directMatch) {
                try { decomp = JSON.parse(directMatch[1]); break; } catch { /* continue */ }
              }
              // Stream-json result event containing COMPLETION_JSON
              try {
                const ev = JSON.parse(text);
                if (ev.type === "result" && typeof ev.result === "string") {
                  const m = ev.result.match(/COMPLETION_JSON:\s*(\{[\s\S]*\})\s*$/);
                  if (m) { try { decomp = JSON.parse(m[1]); break; } catch { /* continue */ } }
                }
              } catch { /* not JSON */ }
            }
          }

          if (!decomp.tasks?.length) {
            ui.warn(`[${phase}] ${label}: no tasks in decomposition`);
            break;
          }
          // Extract story_id from task description (injected by Dashboard when creating decompose task)
          const storyIdMatch = (ctx.task.description || "").match(/story_id:([a-f0-9-]+)/);
          const storyId = storyIdMatch?.[1] || undefined;
          const sprintNum = ctx.config.sprintNumber;

          // Create child tasks via API
          let created = 0;
          const taskIds: string[] = [];
          for (const t of decomp.tasks) {
            try {
              const res = await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks`, {
                method: "POST",
                headers: { ...createAuthHeaders(ctx.config.apiKey), "Content-Type": "application/json" },
                body: JSON.stringify({
                  title: t.title,
                  description: t.steps?.join("; ") || "",
                  acceptance_criteria: t.acceptance_criteria || [],
                  files_hint: t.files_hint || [],
                  steps: t.steps || [],
                  priority: t.priority || "p2",
                  story_points: t.story_points || 3,
                  type: t.type || "feature",
                  owner: "builder",
                  sprint: -1, // backlog — user approves during planning
                  story_id: storyId || null,
                  category: "mutating",
                }),
              });
              const body = (await res.json()) as { id?: string };
              if (body.id) { taskIds.push(body.id); created++; }
            } catch (err) { ui.warn(`[${phase}] Failed to create task: ${t.title} — ${err}`); }
          }

          // Save plan summary to sprint_plans (if sprint available)
          if (sprintNum != null) {
            try {
              await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/sprints/${sprintNum}/plan`, {
                method: "POST",
                headers: { ...createAuthHeaders(ctx.config.apiKey), "Content-Type": "application/json" },
                body: JSON.stringify({
                  summary: decomp.summary || "Story decomposition",
                  tasks: decomp.tasks.map((t, i) => ({ id: taskIds[i]?.slice(0, 8) || `new-${i}`, title: t.title, reason: "" })),
                  total_sp: decomp.total_sp || decomp.tasks.reduce((s, t) => s + (t.story_points || 3), 0),
                }),
              });
            } catch { /* non-fatal */ }
          }

          // Update Story status to ready
          if (storyId) {
            try {
              await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/stories/${storyId}`, {
                method: "PATCH",
                headers: { ...createAuthHeaders(ctx.config.apiKey), "Content-Type": "application/json" },
                body: JSON.stringify({ status: "ready" }),
              });
            } catch { /* non-fatal */ }
          }

          ui.info(`[${phase}] ${label}: ${created}/${decomp.tasks.length} tasks created${storyId ? ` for story ${storyId.slice(0, 8)}` : ""}`);
          break;
        }
        case "spawn_reviewer": {
          if (ctx.jobQueue) {
            // Enqueue review job for serial processing
            const { createJobId } = await import("../services/job-queue.js");
            ctx.jobQueue.enqueue({
              id: createJobId(),
              type: "review",
              status: "pending",
              taskId: ctx.task.id,
              createdAt: new Date().toISOString(),
              diffRange: ctx.preMergeHash ? `${ctx.preMergeHash}..${ctx.mergeCommit || "HEAD"}` : undefined,
              retroJson: ctx.retroJson ? JSON.stringify(ctx.retroJson) : undefined,
              preMergeHash: ctx.preMergeHash,
              mergeCommit: ctx.mergeCommit,
              repoDir: ctx.config.workingDir,
            });
            ui.info(`[${phase}] ${label}: enqueued review job`);
          } else {
            // Fallback: fire-and-forget
            handleSpawnReviewer(action, ctx, phase, actions)
              .catch((err) => ui.warn(`[${phase}] spawn_reviewer error: ${err}`));
            ui.info(`[${phase}] ${label}: spawned async (slot already released)`);
          }
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
          await handleVerifyBuild(action, ctx, phase);
          break;
        }
        case "merge_pipeline": {
          await handleMergePipeline(action, ctx, phase);
          break;
        }
        case "rule_match": {
          await handleRuleMatch(action, ctx, phase);
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

