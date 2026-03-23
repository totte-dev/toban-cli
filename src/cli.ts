#!/usr/bin/env node

/**
 * Toban Agent Runner CLI — entrypoint.
 *
 * Usage:
 *   toban start [options]
 *   toban sprint complete [--push]
 */

import type { AgentType } from "./types.js";
import { resolveModelForRole } from "./agent-engine.js";
import { WS_MSG } from "./ws-types.js";
import type { CliArgs } from "./setup.js";
import * as ui from "./ui.js";
import { execSync } from "node:child_process";

import { AgentRunner } from "./runner.js";
import { handleSprintPlan } from "./commands/plan.js";
import { handleReview } from "./commands/review.js";
import { handleSprintComplete } from "./commands/sprint-complete.js";
import { handleInit, loadConfig } from "./commands/init.js";
import { runLoop } from "./commands/run-loop.js";
import { createShutdownState, setupShutdownHandlers } from "./commands/shutdown.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
toban - AI Agent Runner CLI

Usage:
  toban init
  toban start [options]
  toban sprint complete [--push]

Commands:
  init                  Initialize a new project (interactive setup)
  start                 Start the agent runner (background daemon)
  start --foreground    Start in foreground (blocks terminal)
  stop                  Stop the background runner
  logs                  Show runner log output
  status                Show current sprint state + progress
  backlog               List backlog tasks by priority
  sprint create         Create a new sprint (--goal "...")
  sprint add <id>       Add a task to the current sprint
  sprint remove <id>    Remove a task from the sprint (back to backlog)
  sprint retro "msg"    Submit a retro comment for the current sprint
  sprint summary        Show previous sprint results + learnings
  sprint complete       Complete the current sprint and create a git tag
  task create "title"   Create a task (--desc, --priority, --type, --sprint, --sp)
  task done <id>        Mark a task as done
  peers                 Show active peer agents and their working files
  peers files           Show file-centric conflict view
  chat                  Read recent agent channel messages
  chat "message"        Post a message to the agent channel
  task info             Get current task details
  task list             List all sprint tasks
  task complete "msg"   Report task completion
  task blocker "reason" Report blocker
  context               Get project spec, rules, past failures
  memory search "q"     Search shared knowledge
  memory set key "val"  Save a memory (shared with team)
  memory list           List your memories

Options:
  --api-url <url>       Toban API base URL (or TOBAN_API_URL env)
  --api-key <key>       API key (or TOBAN_API_KEY env)
  --working-dir <dir>   Repository root (default: cwd)
  --agent-name <name>   Agent name for status reporting (default: hostname)
  --branch <branch>     Base branch (default: main)
  --model <model>       AI model for manager chat (default: claude-sonnet-4-6)
  --llm-base-url <url>  OpenAI-compatible API base URL (or LLM_BASE_URL env)
  --llm-api-key <key>   LLM provider API key (or LLM_API_KEY env)
  --engine <type>       Agent engine: claude (default: claude)
  --docker              Enable Docker isolation for agents (default: off)
  --ws-port <port>      WebSocket server port for direct chat (default: 4000, 0=auto)
  --push                Push the sprint tag to origin (sprint complete only)
  --auto-mode           Run in full auto mode (no human intervention)
  --max-sprints <n>     Max sprints in auto mode (default: 10)
  --max-hours <n>       Max hours in auto mode (default: 8)
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

  // Load .toban/config.json as fallback for api-url/api-key
  const config = loadConfig(process.cwd());

  const apiUrl = getFlag("--api-url") ?? process.env.TOBAN_API_URL ?? config?.api_url;
  const apiKey = getFlag("--api-key") ?? process.env.TOBAN_API_KEY ?? config?.api_key;

  if (!apiUrl) { ui.error("--api-url or TOBAN_API_URL is required (or run `toban init`)"); process.exit(1); }
  if (!apiKey) { ui.error("--api-key or TOBAN_API_KEY is required (or run `toban init`)"); process.exit(1); }

  const hostname = (() => { try { return execSync("hostname", { encoding: "utf-8" }).trim(); } catch { return "agent"; } })();
  const explicitWorkingDir = getFlag("--working-dir");

  return {
    command, apiUrl, apiKey,
    workingDir: explicitWorkingDir ?? process.cwd(),
    explicitWorkingDir: !!explicitWorkingDir,
    agentName: getFlag("--agent-name") ?? "manager",
    baseBranch: getFlag("--branch") ?? "main",
    model: getFlag("--model") ?? resolveModelForRole("manager"),
    llmBaseUrl: getFlag("--llm-base-url") ?? process.env.LLM_BASE_URL,
    llmApiKey: getFlag("--llm-api-key") ?? process.env.LLM_API_KEY,
    noDocker: !args.includes("--docker"),
    wsPort: parseInt(getFlag("--ws-port") ?? "4000", 10),
    debug: args.includes("--debug") || process.env.DEBUG === "1",
    engine: (getFlag("--engine") ?? "claude") as AgentType,
    autoTag: args.includes("--auto-tag"),
    autoMode: args.includes("--auto-mode"),
    maxSprints: getFlag("--max-sprints") ? parseInt(getFlag("--max-sprints")!, 10) : undefined,
    maxHours: getFlag("--max-hours") ? parseInt(getFlag("--max-hours")!, 10) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Handle `init` early — it does not require --api-url/--api-key
{
  const firstArg = process.argv[2];
  if (firstArg === "init") {
    handleInit().catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
  }
}

// Lightweight commands: use env vars for auth (TOBAN_API_KEY, TOBAN_API_URL)
// These are designed to be called by agents via Bash tool
if (process.argv[2] === "peers") {
  const { handlePeers } = await import("./commands/peers.js");
  handlePeers(process.argv[3]).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else if (process.argv[2] === "task") {
  const { handleTaskCmd } = await import("./commands/task-cmd.js");
  handleTaskCmd(process.argv.slice(3)).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else if (process.argv[2] === "context") {
  const { handleContext } = await import("./commands/context-cmd.js");
  handleContext(process.argv.slice(3)).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else if (process.argv[2] === "memory") {
  const { handleMemory } = await import("./commands/memory-cmd.js");
  handleMemory(process.argv.slice(3)).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else if (process.argv[2] === "logs") {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const logFile = join(homedir(), ".toban", "logs", "runner.log");
  if (!existsSync(logFile)) { console.log("No runner log found."); process.exit(0); }
  const lines = readFileSync(logFile, "utf-8").split("\n");
  const tail = parseInt(process.argv[3] || "50", 10);
  console.log(lines.slice(-tail).join("\n"));
} else if (process.argv[2] === "status") {
  const { handleStatus } = await import("./commands/status-cmd.js");
  const config = loadConfig(process.cwd());
  const apiUrl = process.env.TOBAN_API_URL ?? config?.api_url;
  const apiKey = process.env.TOBAN_API_KEY ?? config?.api_key;
  if (!apiUrl || !apiKey) { console.error("API credentials required. Run `toban init` or set TOBAN_API_URL/TOBAN_API_KEY."); process.exit(1); }
  handleStatus(apiUrl, apiKey).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else if (process.argv[2] === "backlog") {
  const { handleBacklog } = await import("./commands/backlog-cmd.js");
  const config = loadConfig(process.cwd());
  const apiUrl = process.env.TOBAN_API_URL ?? config?.api_url;
  const apiKey = process.env.TOBAN_API_KEY ?? config?.api_key;
  if (!apiUrl || !apiKey) { console.error("API credentials required. Run `toban init` or set TOBAN_API_URL/TOBAN_API_KEY."); process.exit(1); }
  handleBacklog(apiUrl, apiKey).catch((err) => { console.error(`Error: ${err}`); process.exit(1); });
} else

// All other commands go through parseArgs (which requires api-url/api-key)
if (process.argv[2] !== "init") {

const cliArgs = parseArgs(process.argv);

if (cliArgs.command === "plan") {
  const rawPlanArgs = process.argv.slice(process.argv.indexOf("plan") + 1);
  const goalParts: string[] = [];
  for (let i = 0; i < rawPlanArgs.length; i++) {
    if (rawPlanArgs[i].startsWith("--")) { i++; continue; } // skip --flag and its value
    goalParts.push(rawPlanArgs[i]);
  }
  const goal = goalParts.join(" ").trim() || undefined;
  handleSprintPlan(cliArgs.apiUrl, cliArgs.apiKey, goal).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else if (cliArgs.command === "review") {
  const rawArgs = process.argv.slice(2);
  const taskIdx = rawArgs.indexOf("--task");
  const taskId = taskIdx !== -1 && rawArgs[taskIdx + 1] ? rawArgs[taskIdx + 1] : (rawArgs[1] && !rawArgs[1].startsWith("--") ? rawArgs[1] : undefined);
  const skillIdx = rawArgs.indexOf("--skill");
  const skills = skillIdx !== -1 && rawArgs[skillIdx + 1] ? rawArgs[skillIdx + 1].split(",") : undefined;
  const diffIdx = rawArgs.indexOf("--diff");
  const diffRange = diffIdx !== -1 && rawArgs[diffIdx + 1] ? rawArgs[diffIdx + 1] : undefined;
  const usePr = rawArgs.includes("--pr");
  handleReview(cliArgs.apiUrl, cliArgs.apiKey, taskId, skills, diffRange, cliArgs.engine, usePr).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else if (cliArgs.command === "sprint") {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[1] === "complete") {
    handleSprintComplete(cliArgs.apiUrl, cliArgs.apiKey, rawArgs.includes("--push")).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
  } else if (rawArgs[1] === "create" || rawArgs[1] === "add" || rawArgs[1] === "remove" || rawArgs[1] === "retro" || rawArgs[1] === "summary") {
    const { handleSprintCmd } = await import("./commands/sprint-cmd.js");
    handleSprintCmd(cliArgs.apiUrl, cliArgs.apiKey, rawArgs.slice(1)).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
  } else { ui.error(`Unknown sprint subcommand: ${rawArgs[1]}`); printUsage(); process.exit(1); }
} else if (cliArgs.command === "stop") {
  const { stopRunner } = await import("./commands/daemon.js");
  stopRunner();
} else if (cliArgs.command === "start") {
  const foreground = process.argv.includes("--foreground") || process.env.TOBAN_FOREGROUND === "1";

  if (foreground) {
    // Foreground mode: run directly (used by daemon subprocess)
    const shutdownState = createShutdownState();
    const runner = new AgentRunner({
      useDocker: !cliArgs.noDocker,
      onStdout: (agentName, lines, stream) => {
        shutdownState.activeWsServer?.broadcastStdout(agentName, lines, stream);
      },
      onActivity: (agentName, activity) => {
        if (activity.kind === "tool" && activity.tool) {
          runner.recordTool(agentName, activity.tool);
        }
        if (shutdownState.activeWsServer) {
          shutdownState.activeWsServer.broadcast({
            type: WS_MSG.AGENT_ACTIVITY, agent_name: agentName,
            content: activity.summary, kind: activity.kind, tool: activity.tool, timestamp: activity.timestamp,
          });
        }
      },
    });
    setupShutdownHandlers(runner, shutdownState);
    runLoop(cliArgs, runner, shutdownState).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
  } else {
    // Daemon mode: spawn background process
    const { startDaemon } = await import("./commands/daemon.js");
    startDaemon(process.argv);
  }
} else { ui.error(`Unknown command: ${cliArgs.command}`); printUsage(); process.exit(1); }

} // end: non-init commands
