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

import { AgentRunner, type AgentRunnerOptions } from "./runner.js";
import {
  createApiClient,
  type Task,
  type SprintStartResult,
  type WorkspaceRepository,
} from "./api-client.js";
import { buildAgentPrompt, type RepoInfo } from "./prompt.js";
import { ChatPoller } from "./chat-poller.js";
import { MessagePoller } from "./message-poller.js";
import { WsChatServer } from "./ws-server.js";
import * as ui from "./ui.js";
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
  llmBaseUrl?: string;
  llmApiKey?: string;
  noDocker: boolean;
  wsPort: number;
}

function printUsage(): void {
  console.log(`
toban - AI Agent Runner CLI

Usage:
  toban start [options]

Options:
  --api-url <url>       Toban API base URL (or TOBAN_API_URL env)
  --api-key <key>       API key (or TOBAN_API_KEY env)
  --working-dir <dir>   Repository root (default: cwd)
  --agent-name <name>   Agent name for status reporting (default: hostname)
  --branch <branch>     Base branch (default: main)
  --model <model>       AI model for manager chat (default: claude-sonnet-4-20250514)
  --llm-base-url <url>  OpenAI-compatible API base URL (or LLM_BASE_URL env)
  --llm-api-key <key>   LLM provider API key (or LLM_API_KEY env)
  --no-docker           Disable Docker isolation (run agents directly on host)
  --ws-port <port>      WebSocket server port for direct chat (default: 4000, 0=auto)
  --help                Show this help

LLM Provider Examples:
  Anthropic: --llm-base-url https://api.anthropic.com/v1 --model claude-sonnet-4-20250514
  OpenAI:    --llm-base-url https://api.openai.com/v1 --model gpt-4o
  Gemini:    --llm-base-url https://generativelanguage.googleapis.com/v1beta/openai --model gemini-2.0-flash
  Local:     --llm-base-url http://localhost:11434/v1 --model llama3

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

  if (!apiUrl) {
    ui.error("--api-url or TOBAN_API_URL is required");
    process.exit(1);
  }
  if (!apiKey) {
    ui.error("--api-key or TOBAN_API_KEY is required");
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
    llmBaseUrl: getFlag("--llm-base-url") ?? process.env.LLM_BASE_URL,
    llmApiKey: getFlag("--llm-api-key") ?? process.env.LLM_API_KEY,
    noDocker: args.includes("--no-docker"),
    wsPort: parseInt(getFlag("--ws-port") ?? "4000", 10),
  };
}

// ---------------------------------------------------------------------------
// Workspace repo management
// ---------------------------------------------------------------------------

/**
 * Ensure a repository is cloned/updated for the given agent.
 * Returns the path to the repo working directory.
 *
 * Structure: .toban/<agent-name>/<repo-name>/
 */
function ensureAgentRepo(
  tobanHome: string,
  agentName: string,
  repo: WorkspaceRepository,
  gitToken?: string
): string {
  const agentDir = join(tobanHome, agentName);
  const repoDir = join(agentDir, repo.repo_name);

  mkdirSync(agentDir, { recursive: true });

  if (existsSync(join(repoDir, ".git"))) {
    // Existing repo: fetch + reset to main
    ui.info(`Updating ${repo.repo_name} for ${agentName}`);
    try {
      execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });
      execSync("git checkout main 2>/dev/null || git checkout master", {
        cwd: repoDir,
        stdio: "pipe",
        shell: "/bin/sh",
      });
      execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.warn(`git pull failed for ${repo.repo_name}: ${msg}`);
    }
  } else {
    // Clone the repo
    let cloneUrl = repo.repo_url || repo.repo_path;
    if (gitToken && cloneUrl.includes("github.com")) {
      // Use token-authenticated URL
      const repoPath = cloneUrl
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\.git$/, "");
      cloneUrl = `https://x-access-token:${gitToken}@github.com/${repoPath}.git`;
      ui.info(`Cloning ${repo.repo_name} (authenticated)`);
    } else if (!cloneUrl.startsWith("http") && !cloneUrl.startsWith("git@")) {
      // Assume GitHub org/repo format
      if (gitToken) {
        cloneUrl = `https://x-access-token:${gitToken}@github.com/${cloneUrl}.git`;
      } else {
        cloneUrl = `https://github.com/${cloneUrl}.git`;
      }
      ui.info(`Cloning ${repo.repo_name}`);
    } else {
      ui.info(`Cloning ${repo.repo_name}`);
    }

    execSync(`git clone "${cloneUrl}" "${repoDir}"`, { stdio: "pipe" });
  }

  return repoDir;
}

/**
 * Resolve the working directory for a task.
 * If the task has a target_repo, ensure that repo is cloned for the agent.
 * Otherwise, use the default working directory.
 */
function resolveTaskWorkingDir(
  task: Task,
  repos: WorkspaceRepository[],
  tobanHome: string,
  agentName: string,
  defaultWorkingDir: string,
  gitToken?: string
): string {
  if (!task.target_repo) return defaultWorkingDir;

  const repo = repos.find(
    (r) => r.repo_name === task.target_repo || r.id === task.target_repo
  );
  if (!repo) {
    ui.warn(`target_repo "${task.target_repo}" not found in workspace repositories, using default`);
    return defaultWorkingDir;
  }

  try {
    return ensureAgentRepo(tobanHome, agentName, repo, gitToken);
  } catch (err) {
    ui.error(`Failed to setup repo ${repo.repo_name}: ${err}`);
    return defaultWorkingDir;
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

async function runLoop(cliArgs: CliArgs, runner: AgentRunner): Promise<void> {
  const api = createApiClient(cliArgs.apiUrl, cliArgs.apiKey);

  ui.intro();

  const s = ui.createSpinner();

  s.start("Authenticating...");
  await api.updateAgent({
    name: cliArgs.agentName,
    status: "online",
    activity: "Starting up",
  });
  s.stop("Authenticated");

  let workingDir = cliArgs.workingDir;
  let workspaceSpec: string | undefined;
  let workspaceName: string | undefined;
  let playbookRules: string | undefined;

  s.start("Fetching workspace...");
  try {
    const ws = await api.fetchWorkspace();
    workspaceSpec = (ws as unknown as Record<string, unknown>).spec as string | undefined || undefined;
    workspaceName = ws.name || undefined;
    s.stop(workspaceName ? `Workspace: ${workspaceName}` : "Workspace loaded");

    // Fetch playbook rules (includes git strategy rules + security rules)
    try {
      playbookRules = await api.fetchPlaybookPrompt() || undefined;
    } catch (pbErr) {
      ui.warn(`Could not fetch playbook rules: ${pbErr}`);
    }

    if (!cliArgs.explicitWorkingDir) {
      if (ws.github_repo) {
        const tobanHome = join(homedir(), ".toban");
        const repoDir = join(tobanHome, ws.id);

        // Get GitHub token from API for authenticated git operations
        const gitCreds = await api.fetchGitToken();

        if (existsSync(join(repoDir, ".git"))) {
          s.start(`Pulling latest for ${ws.github_repo}...`);
          try {
            execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
            s.stop(`Repo updated: ${ws.github_repo}`);
          } catch (pullErr) {
            const pullMsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
            s.stop(`Repo: ${ws.github_repo} (pull failed, using existing)`);
            ui.warn(`git pull failed: ${pullMsg}`);
          }
        } else {
          s.start(`Cloning ${ws.github_repo}...`);
          mkdirSync(tobanHome, { recursive: true });

          // Build clone URL with token authentication
          let cloneUrl: string;
          if (gitCreds?.token) {
            const repoPath = ws.github_repo.replace(/^https?:\/\/github\.com\//, "");
            cloneUrl = `https://x-access-token:${gitCreds.token}@github.com/${repoPath}.git`;
          } else {
            const repoUrl = ws.github_repo.startsWith("https://")
              ? ws.github_repo
              : `https://github.com/${ws.github_repo}`;
            cloneUrl = `${repoUrl}.git`;
          }

          execSync(
            `git clone ${cloneUrl} "${repoDir}"`,
            { stdio: "pipe" }
          );
          s.stop(`Repo cloned: ${ws.github_repo}`);
        }

        workingDir = repoDir;
        ui.workspaceInfo(undefined, workingDir, true);
      } else {
        ui.workspaceInfo(undefined, workingDir);
      }
    } else {
      ui.workspaceInfo(undefined, workingDir);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    s.stop("Workspace fetch failed");
    ui.warn(`Using working dir: ${workingDir}`);

    // Notify user via chat if any git operation failed (clone, pull, auth)
    const isGitError =
      errMsg.includes("clone") ||
      errMsg.includes("pull") ||
      errMsg.includes("Repository not found") ||
      errMsg.includes("not found") ||
      errMsg.includes("authentication") ||
      errMsg.includes("fatal:") ||
      errMsg.includes("Could not resolve host");
    if (isGitError) {
      await api.sendMessage(
        "manager",
        "user",
        `Failed to set up repository. Please check access permissions and network.\n\nError: ${errMsg.slice(0, 200)}`
      );
    }
  }

  let sprintData: SprintStartResult | null = null;
  try {
    sprintData = await api.startSprint();
    ui.sprintInfo(sprintData.sprint.number, sprintData.agents.length, sprintData.tasks.length);
  } catch (err) {
    ui.warn(`Sprint API unavailable, falling back to task fetch`);
  }

  // Start the manager chat system
  let chatPoller: ChatPoller | null = null;
  chatPoller = new ChatPoller({
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    llmBaseUrl: cliArgs.llmBaseUrl,
    llmApiKey: cliArgs.llmApiKey,
    model: cliArgs.model,
  });
  chatPoller.start();
  activeChatPoller = chatPoller;

  // Start WebSocket server for direct chat
  let wsServer: WsChatServer | null = null;
  let actualWsPort: number | undefined;
  try {
    wsServer = new WsChatServer({
      port: cliArgs.wsPort,
      apiKey: cliArgs.apiKey,
      apiUrl: cliArgs.apiUrl,
      onMessage: (content) => chatPoller!.generateReplyForWs(content),
    });
    actualWsPort = await wsServer.start();
    await wsServer.registerPort();
    activeWsServer = wsServer;
  } catch (err) {
    ui.warn(`WebSocket server failed to start: ${err}`);
  }

  // Show connection info
  ui.connectionInfo({
    apiUrl: cliArgs.apiUrl,
    agent: cliArgs.agentName,
    branch: cliArgs.baseBranch,
    docker: !cliArgs.noDocker,
    wsPort: actualWsPort,
    llmProvider: cliArgs.llmBaseUrl || "Claude Code CLI",
  });

  let tasks: Task[];
  if (sprintData?.tasks && sprintData.tasks.length > 0) {
    tasks = sprintData.tasks;
  } else {
    try {
      tasks = await api.fetchTasks();
    } catch (err) {
      ui.error(`Failed to fetch tasks: ${err}`);
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
    ui.info("No tasks to work on");
    await api.updateAgent({
      name: cliArgs.agentName,
      status: "idle",
      activity: "No tasks available",
    });
    ui.outro("Idle — no tasks available");
    return;
  }

  // Fetch workspace repositories for per-task repo resolution
  let repos: WorkspaceRepository[] = [];
  try {
    repos = await api.fetchRepositories();
    if (repos.length > 0) {
      ui.info(`${repos.length} workspace repositor${repos.length === 1 ? "y" : "ies"} found`);
    }
  } catch (err) {
    ui.warn(`Could not fetch repositories: ${err}`);
  }

  // Get git token for repo cloning
  let gitToken: string | undefined;
  try {
    const creds = await api.fetchGitToken();
    if (creds?.token) gitToken = creds.token;
  } catch {
    // Non-fatal
  }

  const tobanHome = join(homedir(), ".toban");

  ui.tasksSummary(todoTasks.length);

  for (const task of todoTasks) {
    if (shuttingDown) {
      ui.warn("Shutting down, skipping remaining tasks");
      break;
    }

    ui.step(`Starting task: ${task.title}`);

    try {
      await api.updateTask(task.id, { status: "in_progress" });
    } catch (err) {
      ui.error(`Failed to update task ${task.id}: ${err}`);
      continue;
    }

    await api.updateAgent({
      name: cliArgs.agentName,
      status: "working",
      activity: `Task ${task.id}: ${task.title}`,
    });

    // Resolve the working directory for this task
    const taskWorkingDir = resolveTaskWorkingDir(
      task,
      repos,
      tobanHome,
      cliArgs.agentName,
      workingDir,
      gitToken
    );

    // Build repository info for prompt
    const repoInfoList: RepoInfo[] = repos
      .filter((r) => {
        const agents = r.access_agents ?? [];
        return agents.length === 0 || agents.includes(task.owner ?? cliArgs.agentName);
      })
      .map((r) => ({
        name: r.repo_name,
        path: join(tobanHome, cliArgs.agentName, r.repo_name),
        description: r.description,
      }));

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
      playbookRules,
      targetRepo: task.target_repo ?? undefined,
      repositories: repoInfoList.length > 0 ? repoInfoList : undefined,
    });

    try {
      // Fetch project secrets for the agent
      let secrets: Record<string, string> = {};
      try {
        secrets = await api.fetchMySecrets();
        if (Object.keys(secrets).length > 0) {
          const secretNames = Object.keys(secrets).join(", ");
          ui.info(`Injected ${Object.keys(secrets).length} secrets: ${secretNames}`);
        }
      } catch (err) {
        ui.warn(`Could not fetch secrets: ${err}`);
      }

      const agentConfig = {
        name: `${cliArgs.agentName}-${task.id.slice(0, 8)}`,
        type: "claude" as const,
        taskId: task.id,
        workingDir: taskWorkingDir,
        branch: cliArgs.baseBranch,
        apiKey: cliArgs.apiKey,
        apiUrl: cliArgs.apiUrl,
        prompt,
        parentAgent: cliArgs.agentName,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      };

      ui.agentSpawned({
        agentName: agentConfig.name,
        taskId: task.id,
        taskTitle: task.title,
        docker: !cliArgs.noDocker,
      });

      // Start message poller for this agent's channel
      const agentChannel = task.owner ?? cliArgs.agentName;
      const messagePoller = new MessagePoller({
        api,
        channel: agentChannel,
        workingDir: taskWorkingDir,
      });
      messagePoller.start();

      const runningAgent = await runner.spawn(agentConfig);

      await waitForAgent(runner, agentConfig.name);

      // Stop message poller after agent completes
      messagePoller.stop();

      const status = runner.status();
      const agentReport = status.find((s) => s.name === agentConfig.name);

      if (!agentReport) {
        if (runningAgent.status === "completed") {
          ui.taskResult(task.id, task.title, "completed");
          await api.updateTask(task.id, { status: "review" });
        } else if (runningAgent.status === "failed") {
          ui.taskResult(task.id, task.title, "failed", `exit code: ${runningAgent.exitCode}`);
          await api.updateTask(task.id, { status: "todo" });
          const stderrSnippet = runningAgent.stderr.slice(-3).join("\n");
          await api.sendMessage(
            "manager",
            "user",
            `⚠️ Task "${task.title}" failed (exit code: ${runningAgent.exitCode}).\n\n${stderrSnippet ? `Error: ${stderrSnippet.slice(0, 300)}` : "Check CLI logs for details."}`
          );
        } else {
          ui.taskResult(task.id, task.title, "completed", `status: ${runningAgent.status}`);
          await api.updateTask(task.id, { status: "review" });
        }
      }
    } catch (err) {
      ui.error(`Error spawning agent for task ${task.id}: ${err}`);
      await api.updateTask(task.id, { status: "todo" });
      const errMsg = err instanceof Error ? err.message : String(err);
      await api.sendMessage(
        "manager",
        "user",
        `⚠️ Failed to spawn agent for task "${task.title}".\n\nError: ${errMsg.slice(0, 300)}`
      );
    }
  }

  await api.updateAgent({
    name: cliArgs.agentName,
    status: "idle",
    activity: "All tasks completed",
  });
  ui.outro("All tasks processed — idle");
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
let activeWsServer: WsChatServer | null = null;

function setupShutdownHandlers(runner: AgentRunner): void {
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.warn("Shutting down...");

    if (activeWsServer) {
      activeWsServer.stop().catch(() => {});
    }

    if (activeChatPoller) {
      activeChatPoller.stop();
    }

    const agents = runner.status();
    for (const agent of agents) {
      ui.info(`Stopping agent: ${agent.name}`);
      runner.stop(agent.name);
    }

    setTimeout(() => {
      ui.shutdown();
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
  ui.error(`Unknown command: ${cliArgs.command}`);
  printUsage();
  process.exit(1);
}

const runner = new AgentRunner({
  useDocker: !cliArgs.noDocker,
  onStdout: (agentName, lines, stream) => {
    if (activeWsServer && activeWsServer.clientCount > 0) {
      activeWsServer.broadcastStdout(agentName, lines, stream);
    }
  },
});
setupShutdownHandlers(runner);

runLoop(cliArgs, runner).catch((err) => {
  ui.error(`Fatal error: ${err}`);
  process.exit(1);
});
