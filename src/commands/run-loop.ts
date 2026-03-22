/**
 * Main task execution loop — polls for tasks and spawns agents.
 */

import type { AgentRunner } from "../runner.js";
import { createAuthHeaders, type Task } from "../api-client.js";
import { buildAgentPrompt } from "../prompt.js";
import { getEngine, resolveModelForRole } from "../agent-engine.js";
import { matchTemplate, executeActions, type ActionContext } from "../agent-templates.js";
import { MessagePoller } from "../message-poller.js";
import { WS_MSG } from "../ws-types.js";
import { resolveTaskWorkingDir } from "../git-ops.js";
import { createTaskLogger } from "../task-logger.js";
import { logError, CLI_ERR } from "../error-logger.js";
import { ensureGitUser } from "../spawner.js";
import { setup, type CliArgs } from "../setup.js";
import * as ui from "../ui.js";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { handlePropose } from "./propose.js";
import { fireRuleEvaluate } from "../rule-evaluate.js";
import type { ShutdownState } from "./shutdown.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { extractCompletionJson } from "../utils/completion-parser.js";
import { buildGuardrailRules, checkDiffViolations, type GuardrailConfig } from "../utils/guardrail.js";
import { createEventEmitter, type EventEmitter } from "../utils/event-emitter.js";
import { TIMEOUTS, INTERVALS } from "../constants.js";
import { shouldSplit, autoSplitTasks } from "../task-splitter.js";
import { detectDependencies, sortByDependency } from "../task-dependency.js";
import { trackRetry } from "../utils/retry-tracker.js";
import { OpsRunner } from "../ops-runner.js";
import { extractJsonObject } from "../utils/extract-json.js";
import { ChannelMonitor } from "../channel-monitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runLoop(cliArgs: CliArgs, runner: AgentRunner, shutdownState: ShutdownState): Promise<void> {
  const ctx = await setup(cliArgs, runner);
  shutdownState.activeManager = ctx.mgr;
  shutdownState.activeWsServer = ctx.wsServer;

  const { api, wsServer, tobanHome, repos, gitToken, gitUserInfo, credentialHelperPath } = ctx;
  let { sprintData } = ctx;

  const POLL_INTERVAL_MS = INTERVALS.POLL;

  // Parallel agent slots — start with defaults, then reconfigure from plan limits
  const { SlotScheduler } = await import("../slot-scheduler.js");
  const scheduler = new SlotScheduler([
    { role: "builder", maxConcurrency: 2 },
    { role: "cloud-engineer", maxConcurrency: 1 },
  ]);

  // Fetch plan limits and reconfigure scheduler
  let workspaceBuildCommand: string | null = null;
  let workspaceTestCommand: string | null = null;
  let guardrailConfig: GuardrailConfig | null = null;

  // Create event emitter for recording lifecycle events
  const sprintNum = sprintData?.sprint?.number as number | undefined;
  const eventEmitter: EventEmitter = createEventEmitter(api, sprintNum);

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

  // Start stall detection for agent processes
  runner.startStallDetection();

  // Peer awareness: track active agents' working files for conflict avoidance
  const { PeerTracker } = await import("../peer-tracker.js");
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

  // Channel monitor: watches for actionable messages (blockers, requests, reviews)
  const channelMonitor = new ChannelMonitor();

  // Auto mode state
  let autoModeStartedAt: number | null = null;
  let autoModeSprintCount = 0;
  const autoModeMaxSprints = cliArgs.maxSprints ?? 10;
  const autoModeMaxHours = cliArgs.maxHours ?? 8;

  if (cliArgs.autoMode) {
    autoModeStartedAt = Date.now();
    ui.info(`[auto-mode] Enabled. Max sprints: ${autoModeMaxSprints}, Max hours: ${autoModeMaxHours}`);
    // Create checkpoint tag
    try {
      const tagName = `auto-start-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
      execSync(`git tag "${tagName}"`, { stdio: "pipe" });
      ui.info(`[auto-mode] Checkpoint tag: ${tagName}`);
    } catch { /* non-fatal */ }
  }

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
      ui.warn(`Failed to refresh sprint: ${err}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Auto-mode: check stop conditions
    if (cliArgs.autoMode && autoModeStartedAt) {
      const hoursElapsed = (Date.now() - autoModeStartedAt) / (1000 * 60 * 60);
      if (hoursElapsed >= autoModeMaxHours) {
        ui.info(`[auto-mode] Time limit reached (${autoModeMaxHours}h). Stopping.`);
        break;
      }
      if (autoModeSprintCount >= autoModeMaxSprints) {
        ui.info(`[auto-mode] Sprint limit reached (${autoModeMaxSprints}). Stopping.`);
        break;
      }
    }

    // Wait for sprint to be created (Setup not completed yet)
    if (!sprintData.sprint) {
      ui.info("No active sprint — waiting for project setup to complete...");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Auto-tag on sprint completion (opt-in via workspace setting or CLI flag)
    const sprint = sprintData.sprint as Record<string, unknown> | undefined;
    if (sprint?.status === "completed" && cliArgs.autoTag) {
      const tagName = `sprint-${sprint.number}`;
      try {
        const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
        if (!existing) {
          execSync(`git tag "${tagName}"`, { stdio: "pipe" });
          try { execSync(`git push origin "${tagName}"`, { stdio: "pipe" }); } catch { /* push may fail */ }
          ui.step(`[sprint] Tagged ${tagName}`);
        }
      } catch { /* non-fatal */ }
    }

    // Auto-run Strategist proposals when sprint enters retrospective (once only)
    if (sprint?.status === "retrospective") {
      try {
        const headers = createAuthHeaders(cliArgs.apiKey);
        const plansRes = await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${sprint.number}/plan`, { headers });
        if (plansRes.ok) {
          const plan = (await plansRes.json()) as { status: string; id: string };
          if (plan.status === "generating") {
            ui.info("[strategist] Sprint entered retrospective — generating improvement proposals...");
            // Mark as in-progress immediately to prevent re-trigger on next poll
            try {
              await api.updateAgent({ name: "strategist", status: "working", activity: "Generating proposals..." });
            } catch { /* non-fatal */ }

            let success = false;
            try {
              await handlePropose(cliArgs.apiUrl, cliArgs.apiKey);
              success = true;
            } catch (err) {
              ui.warn(`[strategist] Proposal generation failed: ${err}`);
            }

            // Always overwrite generating plan to prevent infinite loop
            const planSummary = success
              ? "Proposals generated — review in Backlog > Proposals"
              : "Proposal generation failed";
            try {
              await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${sprint.number}/plan`, {
                method: "POST", headers,
                body: JSON.stringify({ summary: planSummary, tasks: [{ id: "done", title: planSummary, reason: "" }], total_sp: 0 }),
              });
            } catch {
              // If API is unreachable, update DB directly won't work — log and move on
              ui.warn("[strategist] Could not update plan status — will retry next poll");
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    // Timebox: auto-transition to review if deadline has passed
    if (sprint?.status === "active" && sprint?.deadline) {
      const deadline = new Date(sprint.deadline as string).getTime();
      if (Date.now() > deadline) {
        ui.warn(`[timebox] Sprint deadline passed — transitioning to review`);
        try {
          await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${sprint.number}`, {
            method: "PATCH",
            headers: createAuthHeaders(cliArgs.apiKey),
            body: JSON.stringify({ status: "review" }),
          });
          wsServer?.broadcast({ type: "data_update" as const, entity: "sprint", task_id: String(sprint.number), changes: { status: "review" }, timestamp: new Date().toISOString() });
        } catch { /* non-fatal */ }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
    }

    // Auto-mode: handle phase transitions automatically
    if (cliArgs.autoMode && sprint) {
      const headers = createAuthHeaders(cliArgs.apiKey);

      // Review → auto-accept → Retro
      if (sprint.status === "review") {
        ui.info("[auto-mode] Review phase — auto-accepting Sprint");
        try {
          await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${sprint.number}`, {
            method: "PATCH", headers,
            body: JSON.stringify({ status: "retrospective" }),
          });
        } catch { /* non-fatal */ }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Completed → create next sprint and continue
      if (sprint.status === "completed") {
        autoModeSprintCount++;
        const nextNumber = (sprint.number as number) + 1;

        // Check backlog for remaining tasks
        try {
          const backlogRes = await fetch(`${cliArgs.apiUrl}/api/v1/tasks?sprint=-1&limit=1`, { headers });
          if (backlogRes.ok) {
            const backlog = (await backlogRes.json()) as unknown[];
            if (Array.isArray(backlog) && backlog.length === 0) {
              ui.info("[auto-mode] Backlog empty. Stopping.");
              break;
            }
          }
        } catch { /* non-fatal */ }

        ui.info(`[auto-mode] Starting Sprint #${nextNumber} (auto ${autoModeSprintCount}/${autoModeMaxSprints})`);
        try {
          await fetch(`${cliArgs.apiUrl}/api/v1/sprints`, {
            method: "POST", headers,
            body: JSON.stringify({ number: nextNumber, status: "active", goal: `Auto Sprint #${nextNumber}` }),
          });
          // Tag for rollback
          try {
            execSync(`git tag "sprint-${nextNumber}-auto"`, { stdio: "pipe" });
          } catch { /* tag may already exist */ }
        } catch (err) {
          ui.warn(`[auto-mode] Failed to create Sprint #${nextNumber}: ${err}`);
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
    }

    // Process channel messages — detect blockers, requests, review feedback
    const channelActions = channelMonitor.processNewMessages();
    for (const ca of channelActions) {
      if (ca.action === "notify") {
        // Broadcast blocker to dashboard
        wsServer?.broadcast({
          type: WS_MSG.CHANNEL_MESSAGE,
          messages: [{ from: ca.message.from, type: ca.message.type, topic: ca.message.topic, text: ca.message.content, ts: ca.message.ts }],
          timestamp: new Date().toISOString(),
        });
      }
      // Future: handle create_task, update_task actions
    }

    // Only pick up tasks during active phase — don't start work during review/retro
    if (sprint?.status !== "active") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Pick up in_progress tasks + auto-start todo tasks owned by agents
    const allTasks = sprintData.tasks as Task[];
    const agentRoles = ["builder", "cloud-engineer", "strategist", "marketer", "operator", "qa"];
    const todoForAgents = allTasks.filter((t) => t.status === "todo" && t.owner && agentRoles.includes(t.owner));

    // Auto-split large tasks before transitioning to in_progress
    const tasksToSplit = todoForAgents.filter((t) => shouldSplit(t, 8));
    if (tasksToSplit.length > 0) {
      const sprintNum = (sprintData.sprint as Record<string, unknown>).number as number;
      const splitResults = await autoSplitTasks(tasksToSplit, sprintNum, {
        minSp: 8,
        apiUrl: cliArgs.apiUrl,
        apiKey: cliArgs.apiKey,
      });
      const splitIds = new Set(splitResults.filter((r) => !r.skipped).map((r) => r.taskId));
      for (const id of splitIds) {
        wsServer?.broadcast({ type: WS_MSG.DATA_UPDATE, entity: "task", task_id: id, changes: { status: "blocked" }, timestamp: new Date().toISOString() });
      }
    }

    // Auto-transition todo → in_progress for agent-owned tasks (skip split parents)
    for (const t of todoForAgents) {
      if ((t.status as string) === "blocked") continue; // already split
      try {
        await api.updateTask(t.id, { status: "in_progress" } as Partial<Task>);
        t.status = "in_progress" as Task["status"];
        ui.info(`[auto] ${t.owner}/${t.id.slice(0, 8)}: todo → in_progress`);
        wsServer?.broadcast({ type: WS_MSG.DATA_UPDATE, entity: "task", task_id: t.id, changes: { status: "in_progress" }, timestamp: new Date().toISOString() });
      } catch { /* non-fatal */ }
    }

    // Empty-repo safety: limit builders to 1 when repo is completely empty (0-1 commits)
    // For repos with any meaningful content, task dependency detection handles ordering.
    // Check the shared repo (where merges actually land) for accurate commit count.
    if (repos.length > 0) {
      const mainRepo = ctx.mainGithubRepo
        ? repos.find((r) => r.repo_name === ctx.mainGithubRepo || r.repo_path.includes(ctx.mainGithubRepo!))
        : null;
      const targetRepo = mainRepo || repos[0];
      // Check shared repo first (where merges land), fallback to manager's copy
      const sharedRepoDir = join(tobanHome, "manager-repos", "shared", targetRepo.repo_name);
      const managerRepoDir = join(tobanHome, cliArgs.agentName, targetRepo.repo_name);
      const repoDir = existsSync(sharedRepoDir) ? sharedRepoDir : managerRepoDir;
      try {
        const commitCount = parseInt(
          execSync("git rev-list --count HEAD", { cwd: repoDir, stdio: "pipe" }).toString().trim(),
          10
        );
        if (commitCount <= 1 && scheduler.getMaxConcurrency("builder") > 1) {
          scheduler.reconfigure("builder", 1);
          ui.info(`[safety] Repo has ${commitCount} commit(s) — limiting builders to 1 until first task completes`);
        } else if (commitCount > 1 && scheduler.getMaxConcurrency("builder") < configuredBuilderConcurrency) {
          scheduler.reconfigure("builder", configuredBuilderConcurrency);
          ui.info(`[safety] Repo now has ${commitCount} commits — restoring builder concurrency to ${configuredBuilderConcurrency}`);
        }
      } catch { /* repo not cloned yet or no HEAD — skip check */ }
    }

    // Dependency-aware task ordering
    const inProgressTasks = allTasks
      .filter((t) => t.status === "in_progress" && t.owner !== "user");
    const completedTaskIds = new Set(
      allTasks.filter((t) => t.status === "done" || t.status === "review").map((t) => t.id)
    );
    const deps = detectDependencies(inProgressTasks);
    const orderedTasks = sortByDependency(inProgressTasks, deps, completedTaskIds);

    // Skip tasks whose dependencies are not yet complete
    const todoTasks = orderedTasks.filter((t) => {
      if (!t.parallelReady) {
        ui.info(`[deps] ${t.id.slice(0, 8)}: waiting for ${t.dependsOn.map((d) => d.slice(0, 8)).join(", ")}`);
        return false;
      }
      return true;
    });

    if (todoTasks.length === 0) {
      const phase = sprintData.sprint?.status ?? "unknown";
      const isIdle = phase === "review" || phase === "retrospective" || phase === "completed";
      const waitMs = isIdle ? POLL_INTERVAL_MS * 4 : POLL_INTERVAL_MS;
      await api.updateAgent({
        name: cliArgs.agentName, status: "idle",
        activity: isIdle ? `Sprint ${phase}, waiting` : "Waiting for tasks",
      });
      if (!isIdle && !wsServer?.hasClients) ui.info(`No tasks — polling again in ${waitMs / 1000}s`);
      await sleep(waitMs);
      continue;
    }

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

      // Pre-check: reject tasks with no meaningful description
      const desc = task.description || "";
      if (desc.length < 20 && !task.type?.toString().match(/^(chore)$/)) {
        ui.warn(`[task] Skipping "${task.title}" — description too short (${desc.length} chars). Add details to the task.`);
        try { await api.updateTask(task.id, { status: "blocked" } as unknown as Partial<Task>); } catch { /* non-fatal */ }
        scheduler.releaseSlot(slotName);
        continue;
      }

      // Warn if description lacks structured format (acceptance criteria)
      if (desc.length >= 20 && !desc.includes("Acceptance Criteria") && !desc.includes("acceptance criteria") && !desc.includes("- [ ]")) {
        ui.warn(`[task] "${task.title}" has no acceptance criteria — agent may produce unclear results`);
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
        api, task, agentName, template: agentTemplate, taskLog,
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

      try { await executeActions(agentTemplate.pre_actions, actionCtx, "pre"); }
      catch (err) {
        logError(CLI_ERR.ACTION_FAILED, `Pre-actions failed: ${err}`, { taskId: task.id, phase: "pre" }, err);
        ui.error(`[task] Pre-actions failed: ${err}`);
        try { await api.updateTask(task.id, { status: "todo" } as Partial<Task>); } catch { /* non-fatal: reset task status */ }
        scheduler.releaseSlot(slotName);
        continue;
      }

      const contextNotes = task.context_notes as string | undefined;
      const fullDescription = [task.description, contextNotes].filter(Boolean).join("\n\n") || undefined;

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
        taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
        taskType, apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
        language: ctx.language,
        playbookRules: (await ctx.api.fetchPlaybookPrompt(agentRole, taskLabels)) || ctx.playbookRules,
        targetRepo: task.target_repo ?? undefined,
        apiDocs: apiDocs || undefined, engineHint: getEngine(cliArgs.engine).promptHint,
        pastFailures: pastFailures.length > 0 ? pastFailures : undefined,
        previousReview,
        guardrailRules: buildGuardrailRules(guardrailConfig, cliArgs.autoMode),
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

        const messagePoller = new MessagePoller({ api, channel: agentRole, workingDir: taskWorkingDir });
        messagePoller.start();

        // Async dispatch: spawn agent and register completion handler.
        // The loop continues to the next task immediately instead of blocking.
        const capturedSlotName = slotName;
        const capturedSprintData = sprintData;

        // Record agent spawn event
        eventEmitter.agentSpawned(agentName, task.id, { role: agentRole, model: agentConfig.model });

        // Register with peer tracker so other agents can see our working files
        peerTracker.register(agentName, task.id, task.title, taskWorkingDir);

        await runner.spawn(agentConfig, (runningAgent) => {
          // --- Completion handler: runs when agent process exits ---
          try { messagePoller.stop(); } catch { /* non-fatal */ }
          peerTracker.unregister(agentName);

          const exitCode = runningAgent.exitCode;
          const succeeded = runningAgent.status === "completed";
          const wasStalled = runningAgent.status === "failed" && runningAgent.stderr.some((l) => l.includes("stall detected"));
          try { ui.taskResult(task.id, task.title, succeeded ? "completed" : "failed", succeeded ? undefined : `exit code: ${exitCode}`); } catch { /* non-fatal */ }

          // Record agent completion/failure event
          if (succeeded) {
            eventEmitter.agentCompleted(agentName, task.id, { role: agentRole, exit_code: exitCode });
          } else {
            eventEmitter.agentFailed(agentName, task.id, { role: agentRole, exit_code: exitCode, stalled: wasStalled });
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
            const parsed = extractCompletionJson(runningAgent.stdout, agentTemplate.post_actions, {
              onReviewUpdate: (tid, phase, comment) => actionCtx.onReviewUpdate?.(tid, phase, comment),
              taskId: task.id,
              taskLog,
            });
            if (parsed) {
              actionCtx.completionJson = parsed;
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
          taskLog.event("post_actions_start", { exitCode, mergeSkipped: actionCtx.mergeSkipped, hasCompletion: !!actionCtx.completionJson, reviewVerdict: actionCtx.reviewVerdict });

          // Run post_actions asynchronously, then release the slot
          executeActions(agentTemplate.post_actions, actionCtx, "post")
            .then(async () => {
              taskLog.event("post_actions_done", { reviewVerdict: actionCtx.reviewVerdict });
              // Check auto-transition: if all tasks done, move sprint to review phase
              if (actionCtx.reviewVerdict === "APPROVE" && capturedSprintData?.sprint?.number != null) {
                const result = await api.checkAutoTransition(capturedSprintData.sprint.number);
                if (result.transitioned) {
                  ui.info(`[sprint] Auto-transition: ${result.from} → ${result.to}`);
                  actionCtx.onDataUpdate?.("sprint", String(capturedSprintData.sprint.number), { status: result.to });
                }
              }
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
      await sleep(POLL_INTERVAL_MS);
    }
  }

  opsRunner.stop();
  peerTracker.stop();
  await eventEmitter.flush(); // Ensure all buffered events are sent before exit
  await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "Shut down" });
  ui.outro("Shutting down — goodbye");
}
