#!/usr/bin/env node

/**
 * Toban Agent Runner CLI
 *
 * Fetches tasks from the Toban API, spawns Claude Code agents in git worktrees,
 * and reports status back.
 *
 * Usage:
 *   toban start --api-url <url> --api-key <key>
 *
 * Environment variables:
 *   TOBAN_API_URL  - Base URL of the Toban API
 *   TOBAN_API_KEY  - API key for authentication
 */

import { AgentRunner } from "./runner.js";
import {
  createApiClient,
  type Task,
  type SprintStartResult,
} from "./api-client.js";
import { buildAgentPrompt } from "./prompt.js";
import { ChatPoller } from "./chat-poller.js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  apiUrl: string;
  apiKey: string;
  workingDir: string;
  explicitWorkingDir: boolean;
  agentName: string;
  baseBranch: string;
  model: string;
}

function printUsage(): void {
  console.log(`
toban - AI Agent Runner CLI

Usage:
  toban start [options]

Options:
  --api-url <url>     Toban API base URL (or TOBAN_API_URL env)
  --api-key <key>     API key (or TOBAN_API_KEY env)
  --working-dir <dir> Repository root (default: cwd)
  --agent-name <name> Agent name for status reporting (default: hostname)
  --branch <branch>   Base branch (default: main)
  --model <model>     AI model for manager chat (default: claude-sonnet-4-20250514)
  --help              Show this help
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

  if (!apiUrl) {
    console.error("Error: --api-url or TOBAN_API_URL is required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: --api-key or TOBAN_API_KEY is required");
    process.exit(1);
  }

  const hostname = (() => {
    try {
      return execSync("hostname", { encoding: "utf-8" }).trim();
    } catch {
      return "agent";
    }
  })();

  const explicitWorkingDir = getFlag("--working-dir");

  return {
    command,
    apiUrl,
    apiKey,
    workingDir: explicitWorkingDir ?? process.cwd(),
    explicitWorkingDir: !!explicitWorkingDir,
    agentName: getFlag("--agent-name") ?? "manager",
    baseBranch: getFlag("--branch") ?? "main",
    model: getFlag("--model") ?? "claude-sonnet-4-20250514",
  };
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

async function runLoop(cliArgs: CliArgs): Promise<void> {
  const api = createApiClient(cliArgs.apiUrl, cliArgs.apiKey);
  const runner = new AgentRunner();

  console.log(`[toban] Starting agent runner`);
  console.log(`[toban]   API:     ${cliArgs.apiUrl}`);
  console.log(`[toban]   Agent:   ${cliArgs.agentName}`);
  console.log(`[toban]   Branch:  ${cliArgs.baseBranch}`);

  await api.updateAgent({
    name: cliArgs.agentName,
    status: "online",
    activity: "Starting up",
  });

  let workingDir = cliArgs.workingDir;
  let workspaceSpec: string | undefined;
  let workspaceName: string | undefined;

  try {
    const ws = await api.fetchWorkspace();
    workspaceSpec = (ws as Record<string, unknown>).spec as string | undefined || undefined;
    workspaceName = ws.name || undefined;

    if (!cliArgs.explicitWorkingDir) {
      if (ws.github_repo) {
        const tobanHome = join(homedir(), ".toban");
        const repoDir = join(tobanHome, ws.id);

        // Get GitHub token from API for authenticated git operations
        const gitCreds = await api.fetchGitToken();

        if (existsSync(join(repoDir, ".git"))) {
          console.log(`[toban] Pulling latest for ${ws.github_repo} in ${repoDir}`);
          execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
        } else {
          console.log(`[toban] Cloning ${ws.github_repo} to ${repoDir}`);
          mkdirSync(tobanHome, { recursive: true });

          // Build clone URL with token authentication
          let cloneUrl: string;
          if (gitCreds?.token) {
            // Use token-authenticated URL: https://x-access-token:<token>@github.com/org/repo.git
            const repoPath = ws.github_repo.replace(/^https?:\/\/github\.com\//, "");
            cloneUrl = `https://x-access-token:${gitCreds.token}@github.com/${repoPath}.git`;
            console.log(`[toban] Using API-provided GitHub token for clone`);
          } else {
            // Fallback to unauthenticated (relies on local git credentials)
            const repoUrl = ws.github_repo.startsWith("https://")
              ? ws.github_repo
              : `https://github.com/${ws.github_repo}`;
            cloneUrl = `${repoUrl}.git`;
            console.log(`[toban] No GitHub token available, using local git credentials`);
          }

          execSync(
            `git clone ${cloneUrl} "${repoDir}"`,
            { stdio: "pipe" }
          );
        }

        workingDir = repoDir;
        console.log(`[toban]   Repo:    ${workingDir} (auto-cloned)`);
      } else {
        console.log(`[toban]   Repo:    ${workingDir} (no GitHub repo configured)`);
      }
    } else {
      console.log(`[toban]   Repo:    ${workingDir}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[toban] Workspace fetch/auto-clone failed, using working dir: ${workingDir}`, err);

    // Notify user via chat if repo clone failed
    if (errMsg.includes("clone") || errMsg.includes("Repository not found") || errMsg.includes("not found")) {
      await api.sendMessage(
        "manager",
        "user",
        `⚠️ Failed to clone repository. Please check access permissions.\n\nError: ${errMsg.slice(0, 200)}`
      );
    }
  }

  let sprintData: SprintStartResult | null = null;
  try {
    sprintData = await api.startSprint();
    console.log(
      `[toban] Sprint ${sprintData.sprint.number} started with ${sprintData.agents.length} agent(s) and ${sprintData.tasks.length} task(s)`
    );
  } catch (err) {
    console.log(`[toban] Sprint start API unavailable, falling back to task fetch: ${err}`);
  }

  // Start the manager chat poller
  // Uses Claude Code CLI by default (no API key needed).
  // Falls back to Anthropic API if ANTHROPIC_API_KEY is set.
  let chatPoller: ChatPoller | null = null;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  chatPoller = new ChatPoller({
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    anthropicApiKey: anthropicApiKey || undefined,
    model: cliArgs.model,
  });
  chatPoller.start();
  activeChatPoller = chatPoller;
  if (!anthropicApiKey) {
    console.log("[chat] Using Claude Code CLI for chat (no ANTHROPIC_API_KEY set)");
  }

  let tasks: Task[];
  if (sprintData?.tasks && sprintData.tasks.length > 0) {
    tasks = sprintData.tasks;
  } else {
    try {
      tasks = await api.fetchTasks();
    } catch (err) {
      console.error(`[toban] Failed to fetch tasks:`, err);
      await api.updateAgent({
        name: cliArgs.agentName,
        status: "error",
        activity: `Failed to fetch tasks: ${err}`,
      });
      process.exit(1);
    }
  }

  const todoTasks = tasks
    .filter((t) => t.status === "todo" || t.status === "in_progress")
    .sort((a, b) => {
      const pa = typeof a.priority === "string" ? parseInt(a.priority.replace("p", ""), 10) : (a.priority ?? 99);
      const pb = typeof b.priority === "string" ? parseInt(b.priority.replace("p", ""), 10) : (b.priority ?? 99);
      return (pa as number) - (pb as number);
    });

  if (todoTasks.length === 0) {
    console.log(`[toban] No tasks to work on. Reporting idle and exiting.`);
    await api.updateAgent({
      name: cliArgs.agentName,
      status: "idle",
      activity: "No tasks available",
    });
    return;
  }

  console.log(`[toban] Found ${todoTasks.length} task(s) to process`);

  for (const task of todoTasks) {
    if (shuttingDown) {
      console.log(`[toban] Shutting down, skipping remaining tasks.`);
      break;
    }

    console.log(`[toban] Processing task: ${task.id} - ${task.title}`);

    try {
      await api.updateTask(task.id, { status: "in_progress" });
    } catch (err) {
      console.error(`[toban] Failed to update task ${task.id}:`, err);
      continue;
    }

    await api.updateAgent({
      name: cliArgs.agentName,
      status: "working",
      activity: `Task ${task.id}: ${task.title}`,
    });

    const prompt = buildAgentPrompt({
      role: task.owner ?? "builder",
      projectName: workspaceName,
      projectSpec: workspaceSpec,
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description || undefined,
      taskPriority: typeof task.priority === "string" ? task.priority : `p${task.priority}`,
      apiUrl: cliArgs.apiUrl,
      apiKey: cliArgs.apiKey,
    });

    try {
      const agentConfig = {
        name: `${cliArgs.agentName}-${task.id.slice(0, 8)}`,
        type: "claude" as const,
        taskId: task.id,
        workingDir,
        branch: cliArgs.baseBranch,
        apiKey: cliArgs.apiKey,
        apiUrl: cliArgs.apiUrl,
        prompt,
        parentAgent: cliArgs.agentName,
      };

      console.log(`[toban] Spawning Claude Code agent for task ${task.id}`);
      const runningAgent = await runner.spawn(agentConfig);

      await waitForAgent(runner, agentConfig.name);

      const status = runner.status();
      const agentReport = status.find((s) => s.name === agentConfig.name);

      if (!agentReport) {
        if (runningAgent.status === "completed") {
          console.log(`[toban] Task ${task.id} completed successfully`);
          await api.updateTask(task.id, { status: "review" });
        } else if (runningAgent.status === "failed") {
          console.log(
            `[toban] Task ${task.id} failed (exit code: ${runningAgent.exitCode})`
          );
          await api.updateTask(task.id, { status: "todo" });
          const stderrSnippet = runningAgent.stderr.slice(-3).join("\n");
          await api.sendMessage(
            "manager",
            "user",
            `⚠️ Task "${task.title}" failed (exit code: ${runningAgent.exitCode}).\n\n${stderrSnippet ? `Error: ${stderrSnippet.slice(0, 300)}` : "Check CLI logs for details."}`
          );
        } else {
          console.log(`[toban] Task ${task.id} finished (status: ${runningAgent.status})`);
          await api.updateTask(task.id, { status: "review" });
        }
      }
    } catch (err) {
      console.error(`[toban] Error spawning agent for task ${task.id}:`, err);
      await api.updateTask(task.id, { status: "todo" });
      const errMsg = err instanceof Error ? err.message : String(err);
      await api.sendMessage(
        "manager",
        "user",
        `⚠️ Failed to spawn agent for task "${task.title}".\n\nError: ${errMsg.slice(0, 300)}`
      );
    }
  }

  console.log(`[toban] All tasks processed. Reporting idle.`);
  await api.updateAgent({
    name: cliArgs.agentName,
    status: "idle",
    activity: "All tasks completed",
  });
}

function waitForAgent(runner: AgentRunner, agentName: string): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const status = runner.status();
      const agent = status.find((s) => s.name === agentName);
      if (!agent) {
        clearInterval(interval);
        resolve();
      }
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

let activeChatPoller: ChatPoller | null = null;

function setupShutdownHandlers(runner: AgentRunner): void {
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[toban] Shutting down...`);

    if (activeChatPoller) {
      activeChatPoller.stop();
    }

    const agents = runner.status();
    for (const agent of agents) {
      console.log(`[toban] Stopping agent: ${agent.name}`);
      runner.stop(agent.name);
    }

    setTimeout(() => {
      console.log(`[toban] Goodbye.`);
      process.exit(0);
    }, 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);

if (cliArgs.command !== "start") {
  console.error(`Unknown command: ${cliArgs.command}`);
  printUsage();
  process.exit(1);
}

const runner = new AgentRunner();
setupShutdownHandlers(runner);

runLoop(cliArgs).catch((err) => {
  console.error(`[toban] Fatal error:`, err);
  process.exit(1);
});
