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
import { handlePropose } from "./commands/propose.js";
import { handleReview } from "./commands/review.js";
import { handleSprintComplete } from "./commands/sprint-complete.js";
import { runLoop } from "./commands/run-loop.js";
import { createShutdownState, setupShutdownHandlers } from "./commands/shutdown.js";

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
  --model <model>       AI model for manager chat (default: claude-sonnet-4-6)
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
    model: getFlag("--model") ?? resolveModelForRole("manager"),
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
// Main
// ---------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);

if (cliArgs.command === "plan") {
  handleSprintPlan(cliArgs.apiUrl, cliArgs.apiKey).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else if (cliArgs.command === "propose") {
  handlePropose(cliArgs.apiUrl, cliArgs.apiKey).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else if (cliArgs.command === "review") {
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
  const shutdownState = createShutdownState();
  const runner = new AgentRunner({
    useDocker: !cliArgs.noDocker,
    onStdout: (agentName, lines, stream) => {
      if (shutdownState.activeWsServer && "broadcastStdout" in shutdownState.activeWsServer) (shutdownState.activeWsServer as any).broadcastStdout(agentName, lines, stream);
    },
    onActivity: (agentName, activity) => {
      if (shutdownState.activeWsServer && "broadcast" in shutdownState.activeWsServer) {
        (shutdownState.activeWsServer as any).broadcast({
          type: WS_MSG.AGENT_ACTIVITY, agent_name: agentName,
          content: activity.summary, kind: activity.kind, tool: activity.tool, timestamp: activity.timestamp,
        });
      }
    },
  });
  setupShutdownHandlers(runner, shutdownState);
  runLoop(cliArgs, runner, shutdownState).catch((err) => { ui.error(`Fatal: ${err}`); process.exit(1); });
} else { ui.error(`Unknown command: ${cliArgs.command}`); printUsage(); process.exit(1); }
