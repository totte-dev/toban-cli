#!/usr/bin/env node

/**
 * Toban Agent Runner CLI — entrypoint.
 *
 * Usage:
 *   toban start [options]
 *   toban sprint complete [--push]
 */

import { AgentRunner } from "./runner.js";
import type { AgentType } from "./types.js";
import { createApiClient, type Task } from "./api-client.js";
import { buildAgentPrompt } from "./prompt.js";
import { getEngine } from "./agent-engine.js";
import { matchTemplate, executeActions, type ActionContext } from "./agent-templates.js";
import { ChatPoller } from "./chat-poller.js";
import { MessagePoller } from "./message-poller.js";
import { WS_MSG } from "./ws-types.js";
import { resolveTaskWorkingDir } from "./git-ops.js";
import { logError, CLI_ERR } from "./error-logger.js";
import { ensureGitUser } from "./spawner.js";
import { setup, type CliArgs, type SetupResult } from "./setup.js";
import * as ui from "./ui.js";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
toban - AI Agent Runner CLI

Usage:
  toban start [options]
  toban sprint complete [--push]

Commands:
  start                 Start the agent runner loop
  sprint complete       Complete the current sprint and create a git tag

Options:
  --api-url <url>       Toban API base URL (or TOBAN_API_URL env)
  --api-key <key>       API key (or TOBAN_API_KEY env)
  --working-dir <dir>   Repository root (default: cwd)
  --agent-name <name>   Agent name for status reporting (default: hostname)
  --branch <branch>     Base branch (default: main)
  --model <model>       AI model for manager chat (default: claude-sonnet-4-20250514)
  --llm-base-url <url>  OpenAI-compatible API base URL (or LLM_BASE_URL env)
  --llm-api-key <key>   LLM provider API key (or LLM_API_KEY env)
  --engine <type>       Agent engine: claude (default: claude)
  --docker              Enable Docker isolation for agents (default: off)
  --ws-port <port>      WebSocket server port for direct chat (default: 4000, 0=auto)
  --push                Push the sprint tag to origin (sprint complete only)
  --debug               Enable verbose debug output (or DEBUG=1 env)
  --help                Show this help

If --llm-base-url is not set, uses Claude Code CLI (no API key needed).
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  function getFlag(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  const apiUrl = getFlag("--api-url") ?? process.env.TOBAN_API_URL;
  const apiKey = getFlag("--api-key") ?? process.env.TOBAN_API_KEY;

  if (!apiUrl) { ui.error("--api-url or TOBAN_API_URL is required"); process.exit(1); }
  if (!apiKey) { ui.error("--api-key or TOBAN_API_KEY is required"); process.exit(1); }

  const hostname = (() => { try { return execSync("hostname", { encoding: "utf-8" }).trim(); } catch { return "agent"; } })();
  const explicitWorkingDir = getFlag("--working-dir");

  return {
    command, apiUrl, apiKey,
    workingDir: explicitWorkingDir ?? process.cwd(),
    explicitWorkingDir: !!explicitWorkingDir,
    agentName: getFlag("--agent-name") ?? "manager",
    baseBranch: getFlag("--branch") ?? "main",
    model: getFlag("--model") ?? "claude-sonnet-4-20250514",
    llmBaseUrl: getFlag("--llm-base-url") ?? process.env.LLM_BASE_URL,
    llmApiKey: getFlag("--llm-api-key") ?? process.env.LLM_API_KEY,
    noDocker: !args.includes("--docker"),
    wsPort: parseInt(getFlag("--ws-port") ?? "4000", 10),
    debug: args.includes("--debug") || process.env.DEBUG === "1",
    engine: (getFlag("--engine") ?? "claude") as AgentType,
    autoTag: args.includes("--auto-tag"),
  };
}

// ---------------------------------------------------------------------------
// Main task execution loop
// ---------------------------------------------------------------------------

async function runLoop(cliArgs: CliArgs, runner: AgentRunner): Promise<void> {
  const ctx = await setup(cliArgs, runner);
  activeManager = ctx.mgr;
  activeWsServer = ctx.wsServer;

  const { api, wsServer, tobanHome, repos, gitToken, gitUserInfo, credentialHelperPath } = ctx;
  let { sprintData } = ctx;

  const POLL_INTERVAL_MS = 30_000;

  // Parallel agent slots
  const { SlotScheduler } = await import("./slot-scheduler.js");
  const { MergeLock } = await import("./merge-lock.js");
  const scheduler = new SlotScheduler([
    { role: "builder", maxConcurrency: 2 },
    { role: "cloud-engineer", maxConcurrency: 1 },
  ]);
  const mergeLock = new MergeLock();

  while (!shuttingDown) {
    try {
      sprintData = await api.fetchSprintData();
    } catch (err) {
      logError(CLI_ERR.API_REQUEST_FAILED, `Failed to refresh sprint: ${err}`, { phase: "poll" }, err);
      ui.warn(`Failed to refresh sprint: ${err}`);
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

    // Pick up in_progress tasks + auto-start todo tasks owned by agents
    const allTasks = sprintData.tasks as Task[];
    const agentRoles = ["builder", "cloud-engineer", "strategist", "marketer", "operator"];
    const todoForAgents = allTasks.filter((t) => t.status === "todo" && t.owner && agentRoles.includes(t.owner));

    // Auto-transition todo → in_progress for agent-owned tasks
    // SP >= 5 tasks are auto-split into subtasks first
    for (const t of todoForAgents) {
      const sp = (t as Record<string, unknown>).story_points as number | null;
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
      if (shuttingDown) { ui.warn("Shutting down, skipping remaining tasks"); break; }

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
      if (desc.length < 20 && !(task as Record<string, unknown>).type?.toString().match(/^(chore)$/)) {
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
      const taskType = (task as Record<string, unknown>).type as string | undefined;
      const agentTemplate = matchTemplate(taskType, agentName);
      const isReadOnly = agentTemplate.tools !== "all";
      ui.info(`[task] Template: "${agentTemplate.id}"${isReadOnly ? ` (read-only: ${(agentTemplate.tools as string[]).join(", ")})` : ""}`);

      const actionCtx: ActionContext = {
        api, task, agentName,
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

      const contextNotes = (task as Record<string, unknown>).context_notes as string | undefined;
      const fullDescription = [task.description, contextNotes].filter(Boolean).join("\n\n") || undefined;

      // Fetch past failures for prompt injection
      let pastFailures: Array<{ summary: string; failure_type: string; agent_name: string | null }> = [];
      try { pastFailures = await api.fetchRelevantFailures(); } catch { /* non-fatal */ }

      const prompt = buildAgentPrompt({
        role: agentName, projectName: ctx.workspaceName, projectSpec: ctx.workspaceSpec,
        taskId: task.id, taskTitle: task.title,
        taskDescription: fullDescription,
        taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
        taskType, apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
        language: ctx.language,
        playbookRules: (await ctx.api.fetchPlaybookPrompt(agentName)) || ctx.playbookRules,
        targetRepo: task.target_repo ?? undefined,
        apiDocs: apiDocs || undefined, engineHint: getEngine(cliArgs.engine).promptHint,
        pastFailures: pastFailures.length > 0 ? pastFailures : undefined,
      });

      try {
        let secrets: Record<string, string> = {};
        try {
          secrets = await api.fetchMySecrets();
          if (Object.keys(secrets).length > 0) ui.info(`Injected ${Object.keys(secrets).length} secrets`);
        } catch (err) { ui.warn(`Could not fetch secrets: ${err}`); }

        // Ensure git user is set before worktree creation
        if (ctx.gitUserInfo) ensureGitUser(taskWorkingDir, ctx.gitUserInfo.name, ctx.gitUserInfo.email);

        // Use parent agent name directly (no child IDs) — prevents DB/UI bloat
        const agentConfig = {
          name: agentName,
          type: cliArgs.engine, taskId: task.id, workingDir: taskWorkingDir,
          branch: cliArgs.baseBranch, apiKey: cliArgs.apiKey, apiUrl: cliArgs.apiUrl,
          prompt, parentAgent: cliArgs.agentName, sprintNumber: sprintData.sprint.number,
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
        for (const line of runningAgent.stdout) {
          const completionLine = line.startsWith("COMPLETION_JSON:") ? line : null;
          if (completionLine) {
            try {
              const json = JSON.parse(completionLine.slice("COMPLETION_JSON:".length));
              // Inject review_comment and commits into the update_task post_action params
              for (const action of agentTemplate.post_actions) {
                if (action.type === "update_task" && action.when === "success" && action.params?.status === "review") {
                  action.params = { ...action.params, review_comment: json.review_comment, commits: json.commits };
                  break;
                }
              }
              ui.info(`[completion] Parsed COMPLETION_JSON: ${json.review_comment?.slice(0, 80)}...`);
              // Broadcast review comment immediately for real-time dashboard update
              if (json.review_comment) {
                actionCtx.onReviewUpdate?.(task.id, "agent_submitted", json.review_comment);
              }
              break;
            } catch { /* skip */ }
          }
          // Also try stream-json events
          try {
            const event = JSON.parse(line);
            if (event.type === "result" && typeof event.result === "string") {
              const match = event.result.match(/COMPLETION_JSON:(\{[\s\S]*\})/);
              if (match) {
                const json = JSON.parse(match[1]);
                for (const action of agentTemplate.post_actions) {
                  if (action.type === "update_task" && action.when === "success" && action.params?.status === "review") {
                    action.params = { ...action.params, review_comment: json.review_comment, commits: json.commits };
                    break;
                  }
                }
                ui.info(`[completion] Parsed COMPLETION_JSON from stream: ${json.review_comment?.slice(0, 80)}...`);
                // Broadcast review comment immediately for real-time dashboard update
                if (json.review_comment) {
                  actionCtx.onReviewUpdate?.(task.id, "agent_submitted", json.review_comment);
                }
                break;
              }
            }
          } catch { /* not JSON */ }
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
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
      } catch (err) {
        logError(CLI_ERR.AGENT_SPAWN_FAILED, `Error spawning agent for task ${task.id}: ${err}`, { taskId: task.id, agentName }, err);
        ui.error(`Error spawning agent for task ${task.id}: ${err}`);
        // Use failure post_actions to reset task and notify user
        actionCtx.exitCode = 1;
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
      } finally {
        scheduler.releaseSlot(slotName);
      }
    }

    if (!shuttingDown) {
      await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "All tasks completed, waiting for new tasks" });
      ui.info(`Tasks done — polling again in ${POLL_INTERVAL_MS / 1000}s`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await api.updateAgent({ name: cliArgs.agentName, status: "idle", activity: "Shut down" });
  ui.outro("Shutting down — goodbye");
}

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
Type: ${(task as Record<string, unknown>).type || "feature"}

Output ONLY a JSON array, no markdown:
[{"title":"...","description":"specific files and acceptance criteria","owner":"builder","type":"feature","priority":"p2","story_points":2}]`;

  return new Promise((resolve) => {
    const child = spawn("claude", ["--print", "--model", "claude-haiku-4-5-20251001", "--max-turns", "1", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
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
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let activeChatPoller: ChatPoller | null = null;
let activeManager: ReturnType<typeof Object> | null = null;
let activeWsServer: { stop: () => Promise<void> } | null = null;

function setupShutdownHandlers(runner: AgentRunner): void {
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.warn("Shutting down...");
    activeWsServer?.stop().catch(() => {});
    activeChatPoller?.stop();
    if (activeManager && "stop" in activeManager) (activeManager as { stop: () => void }).stop();
    for (const agent of runner.status()) { ui.info(`Stopping agent: ${agent.name}`); runner.stop(agent.name); }
    setTimeout(() => { ui.shutdown(); process.exit(0); }, 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Sprint complete
// ---------------------------------------------------------------------------

async function handleSprintComplete(apiUrl: string, apiKey: string, push: boolean): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  ui.intro();
  const s = ui.createSpinner();

  s.start("Fetching current sprint...");
  const sprint = await api.fetchCurrentSprint();
  if (!sprint) { s.stop("No active sprint found"); ui.error("No active sprint."); process.exit(1); }
  s.stop(`Sprint #${sprint.number} (${sprint.status})`);

  if (sprint.status !== "completed") {
    s.start(`Completing sprint #${sprint.number}...`);
    try { await api.completeSprint(sprint.number); s.stop(`Sprint #${sprint.number} completed`); }
    catch (err) {
      s.stop("Failed");
      logError(CLI_ERR.ACTION_FAILED, `Sprint completion failed`, { sprintNumber: sprint.number }, err);
      ui.error(`Sprint completion failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else { ui.info(`Sprint #${sprint.number} already completed`); }

  const tagName = `sprint-${sprint.number}`;
  try {
    const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    if (existing) { ui.warn(`Tag ${tagName} already exists`); }
    else {
      execSync(`git tag "${tagName}"`, { stdio: "pipe" });
      const hash = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
      ui.step(`Tagged ${tagName} at ${hash}`);
    }
  } catch (err) { ui.warn(`Failed to create tag: ${err}`); }

  if (push) {
    try { execSync(`git push origin "${tagName}"`, { stdio: "inherit" }); ui.step(`Pushed ${tagName}`); }
    catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `Failed to push tag ${tagName}`, { tagName }, err);
      ui.error(`Failed to push tag: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  ui.outro(`Sprint #${sprint.number} complete`);
}

// ---------------------------------------------------------------------------
// Review command
// ---------------------------------------------------------------------------

async function handleReview(apiUrl: string, apiKey: string, taskId?: string, skills?: string[]): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const { spawn } = await import("node:child_process");
  const { execSync: revExec } = await import("node:child_process");

  ui.intro();
  const s = ui.createSpinner();

  // Get task to review
  let task: Task;
  if (taskId) {
    s.start(`Fetching task ${taskId}...`);
    const tasks = await api.fetchTasks();
    const found = tasks.find((t: Task) => t.id.startsWith(taskId));
    if (!found) { s.stop("Not found"); ui.error(`Task ${taskId} not found`); process.exit(1); }
    task = found;
  } else {
    s.start("Finding latest review task...");
    const tasks = await api.fetchTasks();
    const reviewTask = tasks.find((t: Task) => t.status === "review");
    if (!reviewTask) { s.stop("None"); ui.error("No tasks in review status"); process.exit(1); }
    task = reviewTask;
  }
  s.stop(`Reviewing: ${task.title}`);

  // Get diff
  const cwd = process.cwd();
  let diffRef = "HEAD~1..HEAD";
  try {
    const parents = revExec("git cat-file -p HEAD", { cwd, stdio: "pipe" }).toString();
    const parentCount = (parents.match(/^parent /gm) || []).length;
    if (parentCount === 0) diffRef = "--root HEAD";
  } catch { /* default */ }

  // Build reviewer prompt
  const { PROMPT_TEMPLATES } = await import("./prompts/templates.js");
  const { interpolate } = await import("./agent-templates.js");
  const taskType = (task as Record<string, unknown>).type as string || "implementation";
  const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

  let customRules = "";
  try { customRules = await api.fetchPlaybookPrompt("reviewer") || ""; } catch { /* non-fatal */ }

  // Inject skills knowledge
  const activeSkills = skills || (task as Record<string, unknown>).skills as string[] | null || [];
  if (activeSkills.length > 0) {
    const { getSkillKnowledge } = await import("./prompts/skills/index.js");
    customRules += "\n\n" + getSkillKnowledge(activeSkills);
    ui.info(`[review] Skills injected: ${activeSkills.join(", ")}`);
  }

  const reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
    projectName: cwd.split("/").pop() || "unknown",
    language: "English",
    taskTitle: task.title,
    taskType,
    taskDescription: task.description || "(no description)",
    taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
    customReviewRules: customRules ? `\n${customRules}` : "",
  });
  const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';

  const prompt = `${reviewSystem}\n\nRun: git diff ${diffRef}\nRun: npm test 2>&1 | tail -20\n\nThen output verdict.\n\n${outputFormat}`;

  s.start("Running Reviewer agent...");
  const result = await new Promise<string>((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn("claude", ["--print", "--model", "claude-sonnet-4-20250514", "--max-turns", "5", prompt], {
      env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
  s.stop("Review complete");

  // Parse and display
  const match = result.match(/COMPLETION_JSON:(\{[\s\S]*?\})\s*$/m);
  if (match) {
    try {
      const report = JSON.parse(match[1]);
      console.log("\n--- Review Report ---");
      console.log(`Verdict: ${report.verdict}`);
      console.log(`Requirement: ${report.requirement_match}`);
      console.log(`Quality: ${report.code_quality}`);
      console.log(`Tests: ${report.test_coverage}`);
      console.log(`Risks: ${report.risks}`);

      // Save to API
      try {
        await fetch(`${apiUrl}/api/v1/tasks/${task.id}/review-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(report),
        });
        console.log("\nReview saved to API.");
      } catch { /* non-fatal */ }
    } catch {
      console.log("\n--- Raw Review Output ---");
      console.log(result.slice(-1000));
    }
  } else {
    console.log("\n--- Raw Output (no structured review) ---");
    console.log(result.slice(-1000));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);

if (cliArgs.command === "review") {
  const rawArgs = process.argv.slice(2);
  const taskId = rawArgs[1] && !rawArgs[1].startsWith("--") ? rawArgs[1] : undefined;
  const skillIdx = rawArgs.indexOf("--skill");
  const skills = skillIdx !== -1 && rawArgs[skillIdx + 1] ? rawArgs[skillIdx + 1].split(",") : undefined;
  handleReview(cliArgs.apiUrl, cliArgs.apiKey, taskId, skills).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else if (cliArgs.command === "sprint") {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[1] === "complete") {
    handleSprintComplete(cliArgs.apiUrl, cliArgs.apiKey, rawArgs.includes("--push")).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
  } else { ui.error(`Unknown sprint subcommand: ${rawArgs[1]}`); printUsage(); process.exit(1); }
} else if (cliArgs.command === "start") {
  const runner = new AgentRunner({
    useDocker: !cliArgs.noDocker,
    onStdout: (agentName, lines, stream) => {
      if (activeWsServer && "broadcastStdout" in activeWsServer) (activeWsServer as any).broadcastStdout(agentName, lines, stream);
    },
    onActivity: (agentName, activity) => {
      if (activeWsServer && "broadcast" in activeWsServer) {
        (activeWsServer as any).broadcast({
          type: WS_MSG.AGENT_ACTIVITY, agent_name: agentName,
          content: activity.summary, kind: activity.kind, tool: activity.tool, timestamp: activity.timestamp,
        });
      }
    },
  });
  setupShutdownHandlers(runner);
  runLoop(cliArgs, runner).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else { ui.error(`Unknown command: ${cliArgs.command}`); printUsage(); process.exit(1); }
