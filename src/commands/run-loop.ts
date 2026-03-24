/**
 * Main task execution loop — polls for tasks and spawns agents.
 */

import type { AgentRunner } from "../agents/runner.js";
import { createAuthHeaders, type Task, type WorkspaceRepository, type ApiClient } from "../services/api-client.js";
import { buildAgentPrompt } from "../agents/prompt.js";
import { getEngine, resolveModelForRole } from "../agents/agent-engine.js";
import { matchTemplate, executeActions, type ActionContext } from "../agents/agent-templates.js";
import { WS_MSG } from "../channel/ws-types.js";
import { resolveTaskWorkingDir } from "../services/git-ops.js";
import { createTaskLogger } from "../services/task-logger.js";
import { logError, CLI_ERR } from "../services/error-logger.js";
import { ensureGitUser } from "../agents/spawner.js";
import { setup, type CliArgs } from "../setup.js";
import * as ui from "../ui.js";
import { fireRuleEvaluate } from "../services/rule-evaluate.js";
import { SprintController } from "./sprint-controller.js";
import { TaskScheduler } from "./task-scheduler.js";
import type { ShutdownState } from "./shutdown.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { extractCompletionJson } from "../utils/completion-parser.js";
import { buildGuardrailRules, checkDiffViolations, type GuardrailConfig } from "../utils/guardrail.js";
import { createEventEmitter, type EventEmitter } from "../utils/event-emitter.js";
import { TIMEOUTS, INTERVALS } from "../constants.js";
import { trackRetry } from "../utils/retry-tracker.js";
import { OpsRunner } from "../services/ops-runner.js";
import { extractJsonObject } from "../utils/extract-json.js";
import { syncRuleTelemetry } from "../utils/telemetry-sync.js";
import { loadPipelineState, clearPipelineState, savePipelineState } from "../utils/pipeline-state.js";
import { runHealthCheck } from "../utils/main-health-check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Interruptible sleep — resolves on timeout or when wake() is called */
function createInterruptibleSleep() {
  let wakeUp: (() => void) | null = null;
  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
        wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
      });
    },
    wake() { wakeUp?.(); },
  };
}

// ---------------------------------------------------------------------------
// Startup cleanup — ensure clean state before each Runner session
// ---------------------------------------------------------------------------

async function startupCleanup(
  tobanHome: string,
  repos: WorkspaceRepository[],
  api: ApiClient,
  sprintData: { sprint: { number: number }; tasks: Task[] } | null
): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { existsSync, rmSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");

  ui.info("[cleanup] Starting pre-run cleanup...");

  // 1. Kill orphaned builder processes from previous runs
  try {
    const pids = execSync("ps aux | grep 'claude.*dangerously' | grep -v grep | awk '{print $2}'", { stdio: "pipe" }).toString().trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try { process.kill(parseInt(pid, 10), "SIGTERM"); } catch { /* already dead */ }
      }
      ui.info(`[cleanup] Killed ${pids.split("\n").filter(Boolean).length} orphaned builder process(es)`);
    }
  } catch { /* no orphans */ }

  // 2. Clean worktrees + agent branches in all manager repos
  const managerBase = join(tobanHome, "manager");
  if (existsSync(managerBase)) {
    try {
      const orgs = execSync("ls", { cwd: managerBase, stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
      for (const org of orgs) {
        const orgDir = join(managerBase, org);
        const repoNames = execSync("ls", { cwd: orgDir, stdio: "pipe" }).toString().trim().split("\n").filter(Boolean);
        for (const repo of repoNames) {
          const repoDir = join(orgDir, repo);
          try {
            // Remove agent worktrees
            const worktrees = execSync("git worktree list", { cwd: repoDir, stdio: "pipe" }).toString();
            for (const line of worktrees.split("\n")) {
              if (line.includes("agent")) {
                const wtPath = line.split(/\s+/)[0];
                try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* */ }
              }
            }
            // Delete agent branches
            const branches = execSync("git branch", { cwd: repoDir, stdio: "pipe" }).toString();
            for (const line of branches.split("\n")) {
              const branch = line.trim().replace(/^\* /, "");
              if (branch.startsWith("agent/")) {
                try { execSync(`git branch -D "${branch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* */ }
              }
            }
          } catch { /* not a git repo */ }
        }
      }
      ui.info("[cleanup] Cleaned worktrees and agent branches");
    } catch { /* non-fatal */ }
  }

  // 3. Reset stale in_progress tasks to todo (from previous crashed runs)
  if (sprintData?.tasks) {
    const staleTasks = sprintData.tasks.filter((t) => t.status === "in_progress");
    for (const t of staleTasks) {
      try {
        await api.updateTask(t.id, { status: "todo" } as Partial<Task>);
        ui.info(`[cleanup] Reset stale task: ${t.title?.toString().slice(0, 40)}`);
      } catch { /* non-fatal */ }
    }
  }

  // 4. Clear token cache (force fresh credentials)
  try { unlinkSync(join(tobanHome, ".git-token-cache")); } catch { /* */ }

  // 5. Clear channel messages (start fresh)
  try { rmSync(join(tobanHome, "channel"), { recursive: true, force: true }); } catch { /* */ }

  ui.info("[cleanup] Pre-run cleanup complete");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runLoop(cliArgs: CliArgs, runner: AgentRunner, shutdownState: ShutdownState): Promise<void> {
  const ctx = await setup(cliArgs, runner);
  shutdownState.activeManager = ctx.mgr;
  shutdownState.activeWsServer = ctx.wsServer;

  const { api, wsServer, tobanHome, repos, gitToken, gitUserInfo, credentialHelperPath } = ctx;
  let { sprintData } = ctx;

  // --- Job Queue: unified processing for enrich/review jobs ---
  const { JobQueue } = await import("../services/job-queue.js");
  const jobQueue = new JobQueue();
  jobQueue.setHandler(async (job) => {
    if (job.type === "enrich") {
      await wsServer.handleEnrichTask(job.taskId);
    } else if (job.type === "review") {
      const { handleSpawnReviewer } = await import("../pipeline/spawn-reviewer.js");
      // Build minimal ActionContext for the reviewer
      const reviewJob = job as import("../types.js").ReviewJob;
      const reviewCtx = {
        api,
        task: sprintData.tasks.find((t) => t.id === job.taskId) || { id: job.taskId, title: "Review", status: "review" } as any,
        agentName: "reviewer",
        config: { apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey, workingDir: reviewJob.repoDir || ctx.workingDir, baseBranch: "main" },
        exitCode: 0,
        preMergeHash: reviewJob.preMergeHash,
        mergeCommit: reviewJob.mergeCommit,
        retroJson: reviewJob.retroJson ? JSON.parse(reviewJob.retroJson) : undefined,
      };
      await handleSpawnReviewer({ type: "spawn_reviewer", when: "success", label: "Review" }, reviewCtx as any, "post", []);
    }
  });
  jobQueue.setOnUpdate((jobs) => {
    const counts = jobQueue.getCounts();
    wsServer.broadcast({ type: WS_MSG.JOB_QUEUE_UPDATE, counts, jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, taskId: j.taskId })), timestamp: new Date().toISOString() });
  });
  wsServer.jobQueue = jobQueue;

  // --- Startup cleanup: ensure clean state before polling ---
  await startupCleanup(tobanHome, repos, api, sprintData);

  const POLL_INTERVAL_MS = INTERVALS.POLL;
  const pollSleep = createInterruptibleSleep();

  // Wake the poll loop immediately when dashboard sends task/sprint changes
  if (wsServer) {
    wsServer.onWake = () => pollSleep.wake();
  }

  // Parallel agent slots — start with defaults, then reconfigure from plan limits
  const { SlotScheduler } = await import("../services/slot-scheduler.js");
  const scheduler = new SlotScheduler([
    { role: "builder", maxConcurrency: 2 },
    { role: "cloud-engineer", maxConcurrency: 1 },
    { role: "strategist", maxConcurrency: 1 },
  ]);

  // Fetch plan limits and reconfigure scheduler
  let workspaceBuildCommand: string | null = null;
  let workspaceTestCommand: string | null = null;
  let guardrailConfig: GuardrailConfig | null = null;

  // Create event emitter for recording lifecycle events
  const sprintNum = sprintData?.sprint?.number as number | undefined;
  const eventEmitter: EventEmitter = createEventEmitter(api, sprintNum, undefined, { interval: 30_000, threshold: 10 });

  // Set currentSprint on WS server for envelope context
  if (wsServer && sprintNum != null) {
    wsServer.currentSprint = sprintNum;
  }

  let configuredBuilderConcurrency = 2; // default, updated from plan limits
  try {
    const limits = await api.fetchPlanLimits();
    configuredBuilderConcurrency = limits.max_builders;
    scheduler.reconfigure("builder", limits.max_builders);
    scheduler.reconfigure("cloud-engineer", limits.max_cloud_engineers);
    workspaceBuildCommand = limits.build_command;
    workspaceTestCommand = limits.test_command;
    // Configure stall timeout from workspace settings
    if (limits.stall_timeout_minutes) {
      runner.setStallTimeout(limits.stall_timeout_minutes * 60_000);
      ui.info(`[plan] Stall timeout: ${limits.stall_timeout_minutes}min`);
    }
    ui.info(`[plan] Builder concurrency: ${limits.max_builders}, Cloud-engineer: ${limits.max_cloud_engineers}`);
    if (workspaceBuildCommand || workspaceTestCommand) {
      ui.info(`[plan] Build: ${workspaceBuildCommand || "(auto)"}, Test: ${workspaceTestCommand || "(auto)"}`);
    }
    // Extract guardrail config
    // guardrail_config is returned by plan-limits but not in the typed PlanLimits interface
    const limitsRaw = limits as unknown as Record<string, unknown>;
    if (limitsRaw.guardrail_config && typeof limitsRaw.guardrail_config === "object") {
      guardrailConfig = limitsRaw.guardrail_config as GuardrailConfig;
    }
  } catch { /* non-fatal — use defaults */ }

  // --- Startup health check: verify main branch before dispatching tasks ---
  // Use typecheck instead of full build — faster, no cache issues, catches real errors
  const healthCheckBuildCmd = workspaceBuildCommand || "npm run typecheck --if-present";
  const healthCheckTestCmd = workspaceTestCommand || "npm test";
  // verify_build runs full tests on every merge, so periodic health-check is a safety net only
  const HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min (was 5 min)

  let mainHealthy = true;
  let lastHealthCheckTime = 0;

  // Only run health check when the working directory is a git-tracked repo
  const { existsSync: fsExistsSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const shouldHealthCheck = !!(ctx.workingDir && fsExistsSync(pathJoin(ctx.workingDir, ".git")));

  if (shouldHealthCheck) {
    ui.info("[health-check] Verifying main branch before dispatching tasks...");
    const result = runHealthCheck(ctx.workingDir, healthCheckBuildCmd, healthCheckTestCmd);
    lastHealthCheckTime = Date.now();
    if (!result.passed) {
      mainHealthy = false;
      const msg = `Main branch health check failed — task dispatch paused.\nCommand: ${result.failedCommand}\nError: ${(result.errorDetail ?? "").slice(0, 300)}`;
      ui.error(`[health-check] ${msg}`);
      await api.sendMessage("manager", "user", msg);
    } else {
      ui.info("[health-check] Main branch is healthy");
    }
  }

  // Start stall detection for agent processes
  runner.startStallDetection();

  // Peer awareness: track active agents' working files for conflict avoidance
  const { PeerTracker } = await import("../channel/peer-tracker.js");
  const peerTracker = new PeerTracker();
  peerTracker.onChannelMessage = (messages) => {
    if (wsServer) {
      wsServer.broadcast({
        type: WS_MSG.CHANNEL_MESSAGE,
        messages: messages.map((m) => ({
          from: m.from, task_title: m.task_title, text: m.content, ts: m.ts,
          type: m.type, topic: m.topic,
        })),
        timestamp: new Date().toISOString(),
      });
    }
  };
  peerTracker.start();


  // Sprint controller — handles phase transitions, auto-mode, timebox, channel actions
  const sprintController = new SprintController({
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    wsServer: wsServer,
    autoMode: {
      enabled: !!cliArgs.autoMode,
      maxSprints: cliArgs.maxSprints ?? 10,
      maxHours: cliArgs.maxHours ?? 8,
    },
    autoTag: cliArgs.autoTag,
  });

  // Task scheduler — filters, splits, orders, and manages concurrency safety
  const taskScheduler = new TaskScheduler({
    api,
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    agentName: cliArgs.agentName,
    scheduler,
    wsServer,
    configuredBuilderConcurrency,
    repos,
    tobanHome,
    mainGithubRepo: ctx.mainGithubRepo,
  });

  // Start ops task runner (background, parallel to main loop)
  const opsRunner = new OpsRunner({
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    pollIntervalMs: 60_000,
  });
  opsRunner.start();

  while (!shutdownState.shuttingDown) {
    try {
      sprintData = await api.fetchSprintData();
    } catch (err) {
      logError(CLI_ERR.API_REQUEST_FAILED, `Failed to refresh sprint: ${err}`, { phase: "poll" }, err);
      ui.warn(`Failed to refresh sprint: ${err} — retrying in ${POLL_INTERVAL_MS / 1000}s`);
      await pollSleep.sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Periodic health check: re-verify main branch every 5 minutes
    if (shouldHealthCheck && Date.now() - lastHealthCheckTime > HEALTH_CHECK_INTERVAL_MS) {
      lastHealthCheckTime = Date.now();
      const hcResult = runHealthCheck(ctx.workingDir, healthCheckBuildCmd, healthCheckTestCmd);
      if (!hcResult.passed && mainHealthy) {
        mainHealthy = false;
        const msg = `Main branch health check failed — task dispatch paused.\nCommand: ${hcResult.failedCommand}\nError: ${(hcResult.errorDetail ?? "").slice(0, 300)}`;
        ui.error(`[health-check] ${msg}`);
        await api.sendMessage("manager", "user", msg);
      } else if (hcResult.passed && !mainHealthy) {
        mainHealthy = true;
        ui.info("[health-check] Main branch recovered — resuming task dispatch");
        await api.sendMessage("manager", "user", "Main branch health check passed. Resuming task dispatch.");
      }
    }

    // Gate task dispatch when main branch is unhealthy
    if (!mainHealthy) {
      await pollSleep.sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Sprint controller: phase transitions, auto-mode, timebox, channel messages
    const sprint = sprintData.sprint as Record<string, unknown> | undefined;
    const tickResult = await sprintController.tick(sprint);
    if (tickResult.action === "stop") break;
    if (tickResult.action === "wait") {
      await pollSleep.sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Task scheduler: filter, split, dependency ordering, concurrency safety
    const allTasks = sprintData.tasks as Task[];
    const scheduleResult = await taskScheduler.getDispatchableTasks(allTasks, sprint?.status as string | undefined);
    if (scheduleResult.status === "idle") {
      await pollSleep.sleep(POLL_INTERVAL_MS * scheduleResult.waitMultiplier);
      continue;
    }
    const todoTasks = scheduleResult.tasks;

    ui.tasksSummary(todoTasks.length);

    for (const task of todoTasks) {
      if (shutdownState.shuttingDown) { ui.warn("Shutting down, skipping remaining tasks"); break; }

      // Skip if already assigned to a slot
      if (scheduler.isTaskAssigned(task.id)) continue;

      // Try to acquire a slot
      const role = task.owner ?? "builder";
      const slotName = scheduler.acquireSlot(role);
      if (!slotName) {
        ui.info(`[parallel] All ${role} slots busy, skipping ${task.id.slice(0, 8)}`);
        continue;
      }
      scheduler.assignTask(slotName, task.id);

      ui.step(`Starting task: ${task.title} [slot: ${slotName}]`);

      // Meta-tasks (decompose, research, etc.) skip detail/AC checks
      const META_TASK_TYPES = ["decompose", "research", "strategy", "docs"];
      const isMetaTask = META_TASK_TYPES.includes(task.type?.toString() ?? "");

      // Shared helper for parsing JSON arrays from DB columns
      const parseJsonArray = (v: unknown): string[] | undefined => {
        if (!v) return undefined;
        if (Array.isArray(v)) return v;
        if (typeof v === "string") { try { const arr = JSON.parse(v); return Array.isArray(arr) ? arr : undefined; } catch { return undefined; } }
        return undefined;
      };

      // Pre-check: reject tasks with no meaningful details (description, steps, or acceptance_criteria)
      const desc = task.description || "";
      if (!isMetaTask) {
        const hasSteps = task.steps && (Array.isArray(task.steps) ? task.steps.length > 0 : task.steps.length > 2);
        const hasCriteria = task.acceptance_criteria && (Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.length > 0 : task.acceptance_criteria.length > 2);
        const hasDetails = desc.length >= 20 || hasSteps || hasCriteria;
        if (!hasDetails && !task.type?.toString().match(/^(chore)$/)) {
          ui.warn(`[task] Skipping "${task.title}" — no meaningful details (description, steps, or acceptance_criteria). Add details to the task.`);
          try { await api.updateTask(task.id, { status: "blocked" } as unknown as Partial<Task>); } catch { /* non-fatal */ }
          scheduler.releaseSlot(slotName);
          continue;
        }

        // Warn if task lacks acceptance criteria
        const acFromDb = parseJsonArray((task as Record<string, unknown>).acceptance_criteria);
        const hasAC = acFromDb?.length
          || desc.includes("Acceptance Criteria") || desc.includes("acceptance criteria") || desc.includes("- [ ]");
        if (desc.length >= 20 && !hasAC) {
          ui.warn(`[task] "${task.title}" has no acceptance criteria — agent may produce unclear results`);
        }
      }

      const taskWorkingDir = resolveTaskWorkingDir(
        task, repos, tobanHome, cliArgs.agentName,
        ctx.workingDir, gitToken, gitUserInfo, credentialHelperPath,
        ctx.mainGithubRepo
      );

      // Use slot name as agent name to avoid collisions in parallel dispatch
      const agentName = slotName;
      const agentRole = task.owner ?? "builder";
      const agentInfo = sprintData.agents.find((a) => a.name === agentRole);
      const apiDocs = await api.fetchApiDocs(agentRole);
      const taskType = task.type as string | undefined;
      const taskLabels = parseTaskLabels(task);

      const agentTemplate = matchTemplate(taskType, agentRole);
      const isReadOnly = agentTemplate.tools !== "all";
      ui.info(`[task] Template: "${agentTemplate.id}"${isReadOnly ? ` (read-only: ${(agentTemplate.tools as string[]).join(", ")})` : ""}`);

      // Restore persisted conflict retry count from context_notes (survives CLI restart)
      const conflictRetryMatch = ((task.context_notes as string) || "").match(/\[conflict_retries:(\d+)\]/);
      if (conflictRetryMatch) {
        const persisted = parseInt(conflictRetryMatch[1], 10);
        for (let i = 0; i < persisted; i++) trackRetry(`conflict:${task.id}`, 2);
      }

      const taskLog = createTaskLogger(task.id);
      taskLog.event("pickup", { agent: agentName, template: agentTemplate.id, title: task.title, taskType, hasReviewComment: !!task.review_comment });

      const actionCtx: ActionContext = {
        api, task, agentName, template: agentTemplate, taskLog, jobQueue,
        config: { apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey, workingDir: taskWorkingDir, baseBranch: cliArgs.baseBranch, sprintNumber: sprintData.sprint.number, language: ctx.language, engine: cliArgs.engine, agentEngine: agentInfo?.engine, buildCommand: workspaceBuildCommand, testCommand: workspaceTestCommand, guardrailConfig, autoMode: cliArgs.autoMode },
        onDataUpdate: (entity, id, changes) => {
          ctx.wsServer?.broadcast({
            type: WS_MSG.DATA_UPDATE,
            entity,
            task_id: id,
            agent_name: entity === "agent" ? id : undefined,
            changes,
            timestamp: new Date().toISOString(),
          });
        },
        onReviewUpdate: (taskId, phase, reviewComment) => {
          ctx.wsServer?.broadcast({
            type: WS_MSG.REVIEW_UPDATE,
            task_id: taskId,
            agent_name: cliArgs.agentName,
            phase,
            review_comment: reviewComment,
            timestamp: new Date().toISOString(),
          });
        },
      };

      // Check if pipeline state exists — if so, skip builder and run pipeline only
      // Read-only templates (decompose, research) don't benefit from pipeline retry — always re-run agent
      // loadPipelineState/clearPipelineState imported at top level
      const existingPipelineState = agentTemplate.allow_no_commit_completion ? null : loadPipelineState(task.id);
      if (existingPipelineState?.agent_branch) {
        ui.info(`[task] Pipeline retry: skipping builder, using existing branch ${existingPipelineState.agent_branch}`);
        taskLog.event("pipeline_retry", { agent_branch: existingPipelineState.agent_branch });

        // Restore completion JSON — may contain nested COMPLETION_JSON:{...} text
        if (existingPipelineState.completion_json) {
          try {
            const outer = JSON.parse(existingPipelineState.completion_json);
            // Check if the parsed result contains COMPLETION_JSON text (from agent output wrapper)
            const outerStr = typeof outer === "string" ? outer : JSON.stringify(outer);
            const cjMatch = outerStr.match(/COMPLETION_JSON:\s*(\{[\s\S]*\})\s*$/);
            if (cjMatch) {
              try { actionCtx.completionJson = JSON.parse(cjMatch[1]); } catch { actionCtx.completionJson = outer; }
            } else {
              actionCtx.completionJson = outer;
            }
          } catch { /* ignore */ }
        }
        actionCtx.agentBranch = existingPipelineState.agent_branch;

        // Run post_actions (merge pipeline + reviewer) directly
        try {
          await executeActions(agentTemplate.pre_actions, actionCtx, "pre");
          await executeActions(agentTemplate.post_actions, actionCtx, "post");
          taskLog.event("pipeline_retry_done");
        } catch (err) {
          logError(CLI_ERR.ACTION_FAILED, `Pipeline retry failed: ${err}`, { taskId: task.id }, err);
          ui.error(`[task] Pipeline retry failed: ${err}`);
        }
        scheduler.releaseSlot(slotName);
        continue;
      }

      try { await executeActions(agentTemplate.pre_actions, actionCtx, "pre"); }
      catch (err) {
        logError(CLI_ERR.ACTION_FAILED, `Pre-actions failed: ${err}`, { taskId: task.id, phase: "pre" }, err);
        ui.error(`[task] Pre-actions failed: ${err}`);
        try { await api.updateTask(task.id, { status: "todo" } as Partial<Task>); } catch { /* non-fatal: reset task status */ }
        scheduler.releaseSlot(slotName);
        continue;
      }

      // Build description: if structured JSON, format it nicely; append context_notes
      const contextNotes = task.context_notes as string | undefined;
      const { getPromptDescription } = await import("../utils/task-description.js");
      const parsedDesc = getPromptDescription(task.description as string | undefined);
      let fullDescription = [parsedDesc, contextNotes].filter(Boolean).join("\n\n") || undefined;

      // Fetch Story info for decompose tasks
      let storyTitle: string | undefined;
      let storyDescription: string | undefined;
      let storyFeedback: string | undefined;
      const storyIdForFetch = taskType === "decompose"
        ? (task.description || "").match(/story_id:([a-f0-9-]+)/)?.[1]
        : undefined;
      if (storyIdForFetch) {
        try {
          const storyRes = await fetch(`${cliArgs.apiUrl}/api/v1/stories/${storyIdForFetch}`, {
            headers: { Authorization: `Bearer ${cliArgs.apiKey}` },
          });
          if (storyRes.ok) {
            const story = (await storyRes.json()) as { title: string; description: string; feedback?: string };
            storyTitle = story.title;
            storyDescription = story.description;
            storyFeedback = story.feedback || undefined;
          }
        } catch { /* use task title/description as fallback */ }
      }
      if (taskType === "decompose" && !storyTitle) {
        storyTitle = task.title;
        storyDescription = task.description || "";
      }

      // Fetch past failures for prompt injection
      let pastFailures: Array<{ summary: string; failure_type: string; agent_name: string | null }> = [];
      try { pastFailures = await api.fetchRelevantFailures(); } catch { /* non-fatal */ }

      // Extract previous review feedback for retry injection
      let previousReview: string | undefined;
      const taskReviewComment = task.review_comment as string | undefined;
      if (taskReviewComment) {
        try {
          const r = JSON.parse(taskReviewComment);
          if (r.verdict === "NEEDS_CHANGES") {
            const parts = [`Verdict: ${r.verdict}`];
            if (r.requirement_match) parts.push(`Requirements: ${r.requirement_match}`);
            if (r.code_quality) parts.push(`Code quality: ${r.code_quality}`);
            if (r.risks) parts.push(`Risks: ${r.risks}`);
            previousReview = parts.join("\n");
          }
        } catch {
          if (taskReviewComment.startsWith("Blocked:") || taskReviewComment.includes("NEEDS_CHANGES")) {
            previousReview = taskReviewComment;
          }
        }
      }

      if (previousReview) {
        ui.warn(`Injecting previous review feedback into agent prompt`);
        taskLog.event("previous_review_injected", { preview: previousReview.slice(0, 200) });
      }

      const prompt = buildAgentPrompt({
        role: agentRole, projectName: ctx.workspaceName, projectSpec: ctx.workspaceSpec,
        taskId: task.id, taskTitle: task.title,
        taskDescription: fullDescription,
        taskSteps: parseJsonArray((task as Record<string, unknown>).steps),
        taskAcceptanceCriteria: parseJsonArray((task as Record<string, unknown>).acceptance_criteria),
        taskFilesHint: parseJsonArray((task as Record<string, unknown>).files_hint),
        taskConstraints: parseJsonArray((task as Record<string, unknown>).constraints_list),
        taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
        taskType, apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
        language: ctx.language,
        playbookRules: (await ctx.api.fetchPlaybookPrompt(agentRole, taskLabels)) || ctx.playbookRules,
        targetRepo: task.target_repo ?? undefined,
        apiDocs: apiDocs || undefined, engineHint: getEngine(cliArgs.engine).promptHint,
        pastFailures: pastFailures.length > 0 ? pastFailures : undefined,
        previousReview,
        guardrailRules: buildGuardrailRules(guardrailConfig, cliArgs.autoMode),
        storyTitle, storyDescription, storyFeedback,
      });

      try {
        let secrets: Record<string, string> = {};
        try {
          secrets = await api.fetchMySecrets();
          if (Object.keys(secrets).length > 0) ui.info(`Injected ${Object.keys(secrets).length} secrets`);
        } catch (err) { ui.warn(`Could not fetch secrets: ${err}`); }

        // Ensure git user is set before worktree creation
        if (ctx.gitUserInfo) ensureGitUser(taskWorkingDir, ctx.gitUserInfo.name, ctx.gitUserInfo.email);

        // Resolve model from agent's DB engine setting or role default
        const agentModel = resolveModelForRole(agentRole, agentInfo?.engine);

        const agentConfig = {
          name: agentName,
          type: cliArgs.engine, taskId: task.id, taskTitle: task.title, workingDir: taskWorkingDir,
          branch: cliArgs.baseBranch, apiKey: cliArgs.apiKey, apiUrl: cliArgs.apiUrl,
          prompt, parentAgent: cliArgs.agentName, sprintNumber: sprintData.sprint.number,
          model: agentModel,
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
          ...(ctx.wsPort ? { managerPort: ctx.wsPort } : {}),
          ...(isReadOnly ? { readOnly: true } : {}),
        };

        // Block if same agent name is already running
        const running = runner.status().find((s) => s.name === agentConfig.name);
        if (running) {
          ui.warn(`[task] Agent "${agentConfig.name}" is already running — skipping task ${task.id.slice(0, 8)}`);
          scheduler.releaseSlot(slotName);
          continue;
        }

        ui.agentSpawned({ agentName: agentConfig.name, taskId: task.id, taskTitle: task.title, docker: !cliArgs.noDocker, model: agentModel });

        // Async dispatch: spawn agent and register completion handler.
        // The loop continues to the next task immediately instead of blocking.
        const capturedSlotName = slotName;
        const capturedSprintData = sprintData;

        // Record agent spawn event + capture start time for duration tracking
        const agentStartTime = Date.now();
        eventEmitter.agentSpawned(agentName, task.id, { role: agentRole, model: agentConfig.model });

        // Register with peer tracker so other agents can see our working files
        peerTracker.register(agentName, task.id, task.title, taskWorkingDir);

        await runner.spawn(agentConfig, (runningAgent) => {
          // --- Completion handler: runs when agent process exits ---
          peerTracker.unregister(agentName);

          const exitCode = runningAgent.exitCode;
          const succeeded = runningAgent.status === "completed";
          const wasStalled = runningAgent.status === "failed" && runningAgent.stderr.some((l) => l.includes("stall detected"));
          try { ui.taskResult(task.id, task.title, succeeded ? "completed" : "failed", succeeded ? undefined : `exit code: ${exitCode}`); } catch { /* non-fatal */ }

          // Record agent completion/failure event with duration and tool stats
          const durationSeconds = Math.round((Date.now() - agentStartTime) / 1000);
          const toolStats = runner.consumeToolStats(agentName);
          if (succeeded) {
            eventEmitter.agentCompleted(agentName, task.id, { role: agentRole, exit_code: exitCode, duration_seconds: durationSeconds, tool_stats: toolStats });
          } else {
            eventEmitter.agentFailed(agentName, task.id, { role: agentRole, exit_code: exitCode, stalled: wasStalled, duration_seconds: durationSeconds, tool_stats: toolStats });
            // Mark task with ERROR verdict so it won't be re-picked automatically
            const errorDetail = JSON.stringify({ verdict: "ERROR", reason: wasStalled ? "Agent stalled" : `exit code ${exitCode}`, exit_code: exitCode, agent: agentName, timestamp: new Date().toISOString() });
            api.updateTask(task.id, { status: "todo", review_verdict: "ERROR", review_comment: errorDetail } as Partial<Task>).catch(() => { /* best-effort */ });
          }

          // Record stall kills to Failure DB for visibility
          if (wasStalled) {
            api.recordFailure({
              task_id: task.id,
              failure_type: "stall",
              summary: `Agent stalled: no output for ${TIMEOUTS.AGENT_STALL_KILL / 1000}s — killed`,
              agent_name: agentName,
              sprint: typeof task.sprint === "number" ? task.sprint : undefined,
            }).catch(() => { /* best-effort */ });
          }

          // All post-completion logic (merge, push, retro, notify, status) is in template
          actionCtx.exitCode = exitCode;
          actionCtx.agentBranch = runningAgent.branch;
          actionCtx.eventEmitter = eventEmitter;
          actionCtx.agentStderr = runningAgent.stderr;
          actionCtx.onDataUpdate = (entity, id, changes) => {
            ctx.wsServer?.broadcast({
              type: WS_MSG.DATA_UPDATE,
              entity,
              task_id: id,
              agent_name: entity === "agent" ? id : undefined,
              changes,
              timestamp: new Date().toISOString(),
            });
          };
          actionCtx.onReviewUpdate = (taskId, phase, reviewComment) => {
            ctx.wsServer?.broadcast({
              type: WS_MSG.REVIEW_UPDATE,
              task_id: taskId,
              agent_name: cliArgs.agentName,
              phase,
              review_comment: reviewComment,
              timestamp: new Date().toISOString(),
            });
          };
          // Extract COMPLETION_JSON from agent stdout
          if (!actionCtx.completionJson) {
            let rawCompletionJson: Record<string, unknown> | null = null;
            const parsed = extractCompletionJson(runningAgent.stdout, agentTemplate.post_actions, {
              onReviewUpdate: (tid, phase, comment) => actionCtx.onReviewUpdate?.(tid, phase, comment),
              taskId: task.id,
              taskLog,
              onBuilderRecord: (record) => {
                actionCtx.builderRecord = record;
                actionCtx.reviewRecord = { ...actionCtx.reviewRecord, builder: record };
              },
              onRawJson: (raw) => { rawCompletionJson = raw; },
            });
            if (parsed) {
              // Use raw JSON for templates that need full data (e.g. decompose with tasks array)
              actionCtx.completionJson = rawCompletionJson ?? parsed;
            }
          }

          // Extract RETRO_JSON for Builder intent injection into Reviewer prompt
          for (const line of runningAgent.stdout) {
            let raw: string | null = null;
            if (line.startsWith("RETRO_JSON:")) {
              raw = extractJsonObject(line.slice("RETRO_JSON:".length));
            } else {
              try {
                const event = JSON.parse(line);
                const text = typeof event === "object" && event?.type === "assistant" ? (event.message?.content?.[0]?.text ?? "") : "";
                const retroIdx = text.indexOf?.("RETRO_JSON:");
                if (retroIdx !== undefined && retroIdx !== -1) {
                  raw = extractJsonObject(text.slice(retroIdx + "RETRO_JSON:".length));
                }
              } catch { /* not JSON */ }
            }
            if (raw) {
              try {
                actionCtx.retroJson = JSON.parse(raw);
              } catch { /* parse error */ }
              break;
            }
          }

          actionCtx.onRetro = async () => {
            // Extract RETRO_JSON from agent stdout, validate, and submit
            for (const line of runningAgent.stdout) {
              let raw: string | null = null;
              if (line.startsWith("RETRO_JSON:")) {
                raw = extractJsonObject(line.slice("RETRO_JSON:".length));
              } else {
                try {
                  const event = JSON.parse(line);
                  if (event.type === "result" && typeof event.result === "string") {
                    const retroIdx = event.result.indexOf("RETRO_JSON:");
                    if (retroIdx !== -1) {
                      raw = extractJsonObject(event.result.slice(retroIdx + "RETRO_JSON:".length));
                    }
                  }
                } catch { /* not JSON */ }
              }
              if (!raw) continue;

              try {
                const json = JSON.parse(raw);

                // Validate: at least one meaningful field required
                const wentWell = typeof json.went_well === "string" ? json.went_well.trim() : "";
                const toImprove = typeof json.to_improve === "string" ? json.to_improve.trim() : "";
                const suggestedTasks = Array.isArray(json.suggested_tasks) ? json.suggested_tasks : [];

                if (!wentWell && !toImprove && suggestedTasks.length === 0) {
                  ui.warn("[retro] RETRO_JSON has no meaningful content — skipped");
                  return;
                }

                // Reject generic/template responses
                const genericPatterns = [/^completed?\s*successfully/i, /^nothing/i, /^no\s*issue/i, /^n\/a$/i, /^none$/i];
                if (wentWell && genericPatterns.some((p) => p.test(wentWell))) {
                  ui.warn(`[retro] went_well is too generic: "${wentWell}" — skipped`);
                  return;
                }

                // Validate suggested_tasks structure
                const validTasks = suggestedTasks.filter((t: unknown) =>
                  typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).title === "string"
                );

                // Length checks (match API schema)
                const safeWentWell = wentWell.slice(0, 2000) || undefined;
                const safeToImprove = toImprove.slice(0, 2000) || undefined;

                await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${capturedSprintData.sprint.number}/retro`, {
                  method: "POST",
                  headers: createAuthHeaders(cliArgs.apiKey),
                  body: JSON.stringify({
                    agent_name: agentConfig.name,
                    went_well: safeWentWell,
                    to_improve: safeToImprove,
                    suggested_tasks: validTasks.length > 0 ? validTasks : undefined,
                  }),
                });
                ui.info(`[retro] Submitted: went_well=${!!safeWentWell}, to_improve=${!!safeToImprove}, tasks=${validTasks.length}`);
                // Fire-and-forget: evaluate retro against playbook rules
                fireRuleEvaluate({
                  apiUrl: cliArgs.apiUrl,
                  apiKey: cliArgs.apiKey,
                  recordId: task.id,
                  recordType: "retro",
                  text: [safeWentWell || "", safeToImprove || ""].join(" "),
                  improvementNotes: safeToImprove,
                });
                return;
              } catch (err) {
                ui.warn(`[retro] Failed to parse RETRO_JSON: ${err}. Raw (first 200 chars): ${raw?.slice(0, 200)}`);
              }
            }
          };
          taskLog.stdout(runningAgent.stdout);
          actionCtx.agentStdout = runningAgent.stdout;

          // Save pipeline state with agent branch — enables pipeline-only retry without re-running builder
          if (actionCtx.completionJson && actionCtx.agentBranch) {
            savePipelineState(task.id, {
              merge_done: false,
              verify_done: false,
              push_done: false,
              updated_at: "",
              agent_branch: actionCtx.agentBranch,
              completion_json: JSON.stringify(actionCtx.completionJson),
            });
          }

          taskLog.event("post_actions_start", { exitCode, mergeSkipped: actionCtx.mergeSkipped, hasCompletion: !!actionCtx.completionJson, reviewVerdict: actionCtx.reviewVerdict });

          // Run post_actions asynchronously, then release the slot
          // Note: spawn_reviewer runs fire-and-forget within post_actions,
          // so slot is released before review completes. Retry and auto-transition
          // are handled inside spawn-reviewer.ts.
          executeActions(agentTemplate.post_actions, actionCtx, "post")
            .then(() => {
              taskLog.event("post_actions_done");
            })
            .catch((postErr) => {
              logError(CLI_ERR.ACTION_FAILED, `Post-actions failed: ${postErr}`, { taskId: task.id }, postErr);
              ui.error(`[task] Post-actions error for ${task.id.slice(0, 8)}: ${postErr}`);
            })
            .finally(() => {
              taskLog.close();
              scheduler.releaseSlot(capturedSlotName);
            });
        });

        // Agent spawned — loop continues to next task (no await waitForAgent)

      } catch (err) {
        logError(CLI_ERR.AGENT_SPAWN_FAILED, `Error spawning agent for task ${task.id}: ${err}`, { taskId: task.id, agentName }, err);
        ui.error(`Error spawning agent for task ${task.id}: ${err}`);
        taskLog.event("error", { message: err instanceof Error ? err.message : String(err) });
        actionCtx.exitCode = 1;
        // Run post_actions for error case, then release slot
        executeActions(agentTemplate.post_actions, actionCtx, "post")
          .catch(() => { /* non-fatal */ })
          .finally(() => {
            taskLog.close();
            scheduler.releaseSlot(slotName);
          });
      }
    }

    if (!shutdownState.shuttingDown) {
      await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "All tasks completed, waiting for new tasks" });
      ui.info(`Tasks done — polling again in ${POLL_INTERVAL_MS / 1000}s`);
      await pollSleep.sleep(POLL_INTERVAL_MS);
    }
  }

  opsRunner.stop();
  peerTracker.stop();
  eventEmitter.destroy(); // Stop periodic flush timer
  await eventEmitter.flush(); // Ensure all buffered events are sent before exit
  await syncRuleTelemetry(cliArgs.apiUrl, cliArgs.apiKey, ctx.workingDir, sprintData?.sprint?.number);
  await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "Shut down" });
  ui.outro("Shutting down — goodbye");
}
