/**
 * Main task execution loop — polls for tasks and spawns agents.
 */

import type { AgentRunner } from "../runner.js";
import type { Task } from "../api-client.js";
import { buildAgentPrompt } from "../prompt.js";
import { getEngine, resolveModel, resolveModelForRole } from "../agent-engine.js";
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
import { handlePropose } from "./propose.js";
import type { ShutdownState } from "./shutdown.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { extractCompletionJson } from "../utils/completion-parser.js";
import { TIMEOUTS, INTERVALS } from "../constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function waitForAgent(runner: AgentRunner, agentName: string): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (!runner.status().find((s) => s.name === agentName)) { clearInterval(interval); resolve(); }
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// Auto-split large tasks
// ---------------------------------------------------------------------------

interface SubtaskDef {
  title: string;
  description: string;
  owner: string;
  type: string;
  priority: string;
  story_points: number;
}

async function splitTaskWithLLM(task: Task, cliArgs: { apiUrl: string; apiKey: string }): Promise<SubtaskDef[]> {
  const { spawn } = await import("node:child_process");
  const prompt = `Split this task into 2-4 smaller subtasks (each 1-3 story points, 1-2 files max).

Task: ${task.title}
Description: ${task.description || "(none)"}
Owner: ${task.owner || "builder"}
Type: ${task.type || "feature"}

Output ONLY a JSON array, no markdown:
[{"title":"...","description":"specific files and acceptance criteria","owner":"builder","type":"feature","priority":"p2","story_points":2}]`;

  return new Promise((resolve) => {
    const child = spawn("claude", ["--print", "--model", resolveModel("claude-haiku"), "--max-turns", "1", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUTS.SPLIT_TASK,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => {
      try {
        // Extract JSON array from output
        const match = out.match(/\[[\s\S]*\]/);
        if (match) {
          const subtasks = JSON.parse(match[0]) as SubtaskDef[];
          if (Array.isArray(subtasks) && subtasks.length >= 2) {
            resolve(subtasks);
            return;
          }
        }
      } catch { /* parse failed */ }
      resolve([]);
    });
    child.on("error", () => resolve([]));
  });
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

  const POLL_INTERVAL_MS = INTERVALS.POLL;

  // Parallel agent slots
  const { SlotScheduler } = await import("../slot-scheduler.js");
  const scheduler = new SlotScheduler([
    { role: "builder", maxConcurrency: 2 },
    { role: "cloud-engineer", maxConcurrency: 1 },
  ]);

  while (!shutdownState.shuttingDown) {
    try {
      sprintData = await api.fetchSprintData();
    } catch (err) {
      logError(CLI_ERR.API_REQUEST_FAILED, `Failed to refresh sprint: ${err}`, { phase: "poll" }, err);
      ui.warn(`Failed to refresh sprint: ${err}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
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
        const headers = { Authorization: `Bearer ${cliArgs.apiKey}`, "Content-Type": "application/json" };
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
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cliArgs.apiKey}` },
            body: JSON.stringify({ status: "review" }),
          });
          wsServer?.broadcast({ type: "data_update" as const, entity: "sprint", task_id: String(sprint.number), changes: { status: "review" }, timestamp: new Date().toISOString() });
        } catch { /* non-fatal */ }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
    }

    // Only pick up tasks during active phase — don't start work during review/retro
    if (sprint?.status !== "active") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Pick up in_progress tasks + auto-start todo tasks owned by agents
    const allTasks = sprintData.tasks as Task[];
    const agentRoles = ["builder", "cloud-engineer", "strategist", "marketer", "operator"];
    const todoForAgents = allTasks.filter((t) => t.status === "todo" && t.owner && agentRoles.includes(t.owner));

    // Auto-transition todo → in_progress for agent-owned tasks
    // SP >= 5 tasks are auto-split into subtasks first
    for (const t of todoForAgents) {
      const sp = t.story_points as number | null;
      if (sp && sp >= 5) {
        ui.info(`[auto-split] ${t.id.slice(0, 8)}: SP=${sp} — splitting into subtasks`);
        try {
          const subtasks = await splitTaskWithLLM(t, cliArgs);
          if (subtasks.length > 0) {
            const sprintNum = (sprintData.sprint as Record<string, unknown>).number as number;
            for (const sub of subtasks) {
              await fetch(`${cliArgs.apiUrl}/api/v1/tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${cliArgs.apiKey}` },
                body: JSON.stringify({ ...sub, sprint: sprintNum, parent_task: t.id, status: "todo" }),
              });
            }
            await api.updateTask(t.id, { status: "blocked" } as Partial<Task>);
            ui.info(`[auto-split] Created ${subtasks.length} subtasks, parent blocked`);
            wsServer?.broadcast({ type: WS_MSG.DATA_UPDATE, entity: "task", task_id: t.id, changes: { status: "blocked" }, timestamp: new Date().toISOString() });
            continue;
          }
        } catch (err) {
          ui.warn(`[auto-split] Failed: ${err}`);
        }
      }

      try {
        await api.updateTask(t.id, { status: "in_progress" } as Partial<Task>);
        t.status = "in_progress" as Task["status"];
        ui.info(`[auto] ${t.owner}/${t.id.slice(0, 8)}: todo → in_progress`);
        wsServer?.broadcast({ type: WS_MSG.DATA_UPDATE, entity: "task", task_id: t.id, changes: { status: "in_progress" }, timestamp: new Date().toISOString() });
      } catch { /* non-fatal */ }
    }

    const todoTasks = allTasks
      .filter((t) => t.status === "in_progress" && t.owner !== "user")
      .sort((a, b) => {
        const pa = typeof a.priority === "string" ? parseInt(a.priority.replace("p", ""), 10) : (a.priority ?? 99);
        const pb = typeof b.priority === "string" ? parseInt(b.priority.replace("p", ""), 10) : (b.priority ?? 99);
        return (pa as number) - (pb as number);
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
      // Note: currently still sequential per slot. Full async dispatch in Phase 2.

      // Pre-check: reject tasks with no meaningful description
      const desc = task.description || "";
      if (desc.length < 20 && !task.type?.toString().match(/^(chore)$/)) {
        ui.warn(`[task] Skipping "${task.title}" — description too short (${desc.length} chars). Add details to the task.`);
        try { await api.updateTask(task.id, { status: "blocked" } as Partial<Task>); } catch { /* non-fatal */ }
        continue;
      }

      const taskWorkingDir = resolveTaskWorkingDir(
        task, repos, tobanHome, cliArgs.agentName,
        ctx.workingDir, gitToken, gitUserInfo, credentialHelperPath,
        ctx.mainGithubRepo
      );

      const agentName = task.owner ?? "builder";
      const apiDocs = await api.fetchApiDocs(agentName);
      const taskType = task.type as string | undefined;
      const taskLabels = parseTaskLabels(task);
      const agentTemplate = matchTemplate(taskType, agentName);
      const isReadOnly = agentTemplate.tools !== "all";
      ui.info(`[task] Template: "${agentTemplate.id}"${isReadOnly ? ` (read-only: ${(agentTemplate.tools as string[]).join(", ")})` : ""}`);

      const taskLog = createTaskLogger(task.id);
      taskLog.event("pickup", { agent: agentName, template: agentTemplate.id, title: task.title, taskType, hasReviewComment: !!task.review_comment });

      const actionCtx: ActionContext = {
        api, task, agentName, template: agentTemplate, taskLog,
        config: { apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey, workingDir: taskWorkingDir, baseBranch: cliArgs.baseBranch, sprintNumber: sprintData.sprint.number, language: ctx.language, engine: cliArgs.engine },
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
        role: agentName, projectName: ctx.workspaceName, projectSpec: ctx.workspaceSpec,
        taskId: task.id, taskTitle: task.title,
        taskDescription: fullDescription,
        taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
        taskType, apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
        language: ctx.language,
        playbookRules: (await ctx.api.fetchPlaybookPrompt(agentName, taskLabels)) || ctx.playbookRules,
        targetRepo: task.target_repo ?? undefined,
        apiDocs: apiDocs || undefined, engineHint: getEngine(cliArgs.engine).promptHint,
        pastFailures: pastFailures.length > 0 ? pastFailures : undefined,
        previousReview,
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
        const agentInfo = sprintData.agents.find((a) => a.name === agentName);
        const agentModel = resolveModelForRole(agentName, agentInfo?.engine);

        const agentConfig = {
          name: agentName,
          type: cliArgs.engine, taskId: task.id, workingDir: taskWorkingDir,
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
          continue;
        }

        ui.agentSpawned({ agentName: agentConfig.name, taskId: task.id, taskTitle: task.title, docker: !cliArgs.noDocker });

        const messagePoller = new MessagePoller({ api, channel: task.owner ?? cliArgs.agentName, workingDir: taskWorkingDir });
        messagePoller.start();

        const runningAgent = await runner.spawn(agentConfig);
        await waitForAgent(runner, agentConfig.name);
        messagePoller.stop();

        const exitCode = runningAgent.exitCode;
        const succeeded = runningAgent.status === "completed";
        ui.taskResult(task.id, task.title, succeeded ? "completed" : "failed", succeeded ? undefined : `exit code: ${exitCode}`);

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
        // Extract COMPLETION_JSON from agent stdout → enrich post_action update_task
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

        actionCtx.onRetro = async () => {
          // Extract RETRO_JSON from agent stdout, validate, and submit
          for (const line of runningAgent.stdout) {
            let raw: string | null = null;
            if (line.startsWith("RETRO_JSON:")) {
              raw = line.slice("RETRO_JSON:".length);
            } else {
              try {
                const event = JSON.parse(line);
                if (event.type === "result" && typeof event.result === "string") {
                  const match = event.result.match(/RETRO_JSON:(\{[\s\S]*\})/);
                  if (match) raw = match[1];
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

              await fetch(`${cliArgs.apiUrl}/api/v1/sprints/${sprintData.sprint.number}/retro`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${cliArgs.apiKey}` },
                body: JSON.stringify({
                  agent_name: agentConfig.name,
                  went_well: safeWentWell,
                  to_improve: safeToImprove,
                  suggested_tasks: validTasks.length > 0 ? validTasks : undefined,
                }),
              });
              ui.info(`[retro] Submitted: went_well=${!!safeWentWell}, to_improve=${!!safeToImprove}, tasks=${validTasks.length}`);
              return;
            } catch (err) {
              ui.warn(`[retro] Failed to parse RETRO_JSON: ${err}`);
            }
          }
        };
        taskLog.stdout(runningAgent.stdout);
        taskLog.event("post_actions_start", { exitCode, mergeSkipped: actionCtx.mergeSkipped, hasCompletion: !!actionCtx.completionJson, reviewVerdict: actionCtx.reviewVerdict });
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
        taskLog.event("post_actions_done", { reviewVerdict: actionCtx.reviewVerdict });
        taskLog.close();
      } catch (err) {
        logError(CLI_ERR.AGENT_SPAWN_FAILED, `Error spawning agent for task ${task.id}: ${err}`, { taskId: task.id, agentName }, err);
        ui.error(`Error spawning agent for task ${task.id}: ${err}`);
        taskLog.event("error", { message: err instanceof Error ? err.message : String(err) });
        actionCtx.exitCode = 1;
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
        taskLog.close();
      } finally {
        scheduler.releaseSlot(slotName);
      }
    }

    if (!shutdownState.shuttingDown) {
      await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "All tasks completed, waiting for new tasks" });
      ui.info(`Tasks done — polling again in ${POLL_INTERVAL_MS / 1000}s`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "Shut down" });
  ui.outro("Shutting down — goodbye");
}
