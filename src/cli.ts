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

  while (!shuttingDown) {
    try {
      sprintData = await api.fetchSprintData();
    } catch (err) {
      ui.warn(`Failed to refresh sprint: ${err}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const todoTasks = (sprintData.tasks as Task[])
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

      ui.step(`Starting task: ${task.title}`);

      const taskWorkingDir = resolveTaskWorkingDir(
        task, repos, tobanHome, cliArgs.agentName,
        ctx.workingDir, gitToken, gitUserInfo, credentialHelperPath
      );

      const agentName = task.owner ?? "builder";
      const apiDocs = await api.fetchApiDocs(agentName);
      const taskType = (task as Record<string, unknown>).type as string | undefined;
      const agentTemplate = matchTemplate(taskType, agentName);
      const isReadOnly = agentTemplate.tools !== "all";
      ui.info(`[task] Template: "${agentTemplate.id}"${isReadOnly ? ` (read-only: ${(agentTemplate.tools as string[]).join(", ")})` : ""}`);

      const actionCtx: ActionContext = {
        api, task, agentName: cliArgs.agentName,
        config: { apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey, workingDir: taskWorkingDir, baseBranch: cliArgs.baseBranch, sprintNumber: sprintData.sprint.number },
      };

      try { await executeActions(agentTemplate.pre_actions, actionCtx, "pre"); }
      catch (err) { ui.error(`[task] Pre-actions failed: ${err}`); continue; }

      const contextNotes = (task as Record<string, unknown>).context_notes as string | undefined;
      const fullDescription = [task.description, contextNotes].filter(Boolean).join("\n\n") || undefined;

      const prompt = buildAgentPrompt({
        role: agentName, projectName: ctx.workspaceName, projectSpec: ctx.workspaceSpec,
        taskId: task.id, taskTitle: task.title,
        taskDescription: fullDescription,
        taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
        taskType, apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
        language: ctx.language, playbookRules: ctx.playbookRules, targetRepo: task.target_repo ?? undefined,
        apiDocs: apiDocs || undefined, engineHint: getEngine(cliArgs.engine).promptHint,
      });

      try {
        let secrets: Record<string, string> = {};
        try {
          secrets = await api.fetchMySecrets();
          if (Object.keys(secrets).length > 0) ui.info(`Injected ${Object.keys(secrets).length} secrets`);
        } catch (err) { ui.warn(`Could not fetch secrets: ${err}`); }

        // Ensure git user is set before worktree creation
        if (ctx.gitUserInfo) ensureGitUser(taskWorkingDir, ctx.gitUserInfo.name, ctx.gitUserInfo.email);

        const agentConfig = {
          name: `${agentName}-${task.id.slice(0, 8)}`,
          type: cliArgs.engine, taskId: task.id, workingDir: taskWorkingDir,
          branch: cliArgs.baseBranch, apiKey: cliArgs.apiKey, apiUrl: cliArgs.apiUrl,
          prompt, parentAgent: cliArgs.agentName, sprintNumber: sprintData.sprint.number,
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
          ...(ctx.wsPort ? { managerPort: ctx.wsPort } : {}),
          ...(isReadOnly ? { readOnly: true } : {}),
        };

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
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
      } catch (err) {
        ui.error(`Error spawning agent for task ${task.id}: ${err}`);
        // Use failure post_actions to reset task and notify user
        actionCtx.exitCode = 1;
        await executeActions(agentTemplate.post_actions, actionCtx, "post");
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
    catch (err) { s.stop("Failed"); ui.error(`${err}`); process.exit(1); }
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
    catch (err) { ui.error(`Failed to push tag: ${err}`); process.exit(1); }
  }
  ui.outro(`Sprint #${sprint.number} complete`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);

if (cliArgs.command === "sprint") {
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
