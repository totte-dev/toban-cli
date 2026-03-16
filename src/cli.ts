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
import type { AgentType } from "./types.js";
import {
  createApiClient,
  type Task,
  type SprintStartResult,
  type WorkspaceRepository,
} from "./api-client.js";
import { buildAgentPrompt, type RepoInfo } from "./prompt.js";
import { ChatPoller } from "./chat-poller.js";
import { Manager } from "./manager.js";
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
  debug: boolean;
  engine: AgentType;
}

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
  --engine <type>       Agent engine: claude, codex, gemini, mock, custom (default: claude)
  --no-docker           Disable Docker isolation (run agents directly on host)
  --ws-port <port>      WebSocket server port for direct chat (default: 4000, 0=auto)
  --push                Push the sprint tag to origin (sprint complete only)
  --debug               Enable verbose debug output (or DEBUG=1 env)
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
    debug: args.includes("--debug") || process.env.DEBUG === "1",
    engine: (getFlag("--engine") ?? "claude") as AgentType,
  };
}

// ---------------------------------------------------------------------------
// Git revert execution
// ---------------------------------------------------------------------------

/**
 * Execute git revert for given commits in the appropriate repo directory.
 * Reverts are done on the main branch (trunk-based).
 */
async function executeRevert(
  repoName: string,
  commits: string[],
  repos: WorkspaceRepository[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const repo = repos.find((r) => r.repo_name === repoName);
    const repoPath = repo?.repo_path;
    if (!repoPath || !existsSync(repoPath)) {
      return { ok: false, error: `Repository path not found for "${repoName}"` };
    }

    // Revert commits in reverse order (newest first)
    const reversed = [...commits].reverse();
    for (const hash of reversed) {
      ui.info(`[revert] Reverting ${hash.slice(0, 7)} in ${repoName}`);
      execSync(`git revert --no-edit ${hash}`, { cwd: repoPath, stdio: "pipe" });
    }

    // Push the reverts
    ui.info(`[revert] Pushing reverts for ${repoName}`);
    execSync("git push origin HEAD", { cwd: repoPath, stdio: "pipe" });

    ui.step(`[revert] Successfully reverted ${commits.length} commit(s) in ${repoName}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.warn(`[revert] Failed: ${msg}`);
    return { ok: false, error: msg };
  }
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

  ui.setDebug(cliArgs.debug);
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

  let sprintData: SprintStartResult;
  try {
    sprintData = await api.startSprint();
    ui.sprintInfo(sprintData.sprint.number, sprintData.agents.length, sprintData.tasks.length);
  } catch (err) {
    ui.error(`Failed to start sprint: ${err}`);
    await api.updateAgent({
      name: cliArgs.agentName,
      status: "error",
      activity: `No active sprint: ${err}`,
    });
    process.exit(1);
  }

  // Start the Manager (replaces ChatPoller with action-capable LLM manager)
  const mgr = new Manager({
    apiUrl: cliArgs.apiUrl,
    apiKey: cliArgs.apiKey,
    llmBaseUrl: cliArgs.llmBaseUrl,
    llmApiKey: cliArgs.llmApiKey,
    model: cliArgs.model,
    runner,
    api,
  });
  activeManager = mgr;

  // Keep ChatPoller as fallback (for backward compat, will be removed)
  activeChatPoller = null;

  // Start WebSocket server for direct chat
  let wsServer: WsChatServer | null = null;
  let actualWsPort: number | undefined;
  try {
    wsServer = new WsChatServer({
      port: cliArgs.wsPort,
      apiKey: cliArgs.apiKey,
      apiUrl: cliArgs.apiUrl,
      onMessage: async (content) => mgr.handleWsMessage(content),
      onClientConnected: () => mgr.pausePolling(),
      onAllClientsDisconnected: () => mgr.resumePolling(),
      onRevert: async (taskId, repoName, commits) => {
        return executeRevert(repoName, commits, repos);
      },
    });
    actualWsPort = await wsServer.start();
    await wsServer.registerPort();
    activeWsServer = wsServer;

    // Wire Manager poll-path replies to WS broadcast
    mgr.onReply = (reply) => {
      wsServer?.broadcast({
        type: "chat",
        from: "manager",
        to: "user",
        content: reply,
        timestamp: new Date().toISOString(),
      });
    };
    mgr.onProposals = (proposals) => {
      wsServer?.broadcast({
        type: "proposals",
        tasks: proposals,
        timestamp: new Date().toISOString(),
      });
    };
  } catch (err) {
    ui.warn(`WebSocket server failed to start: ${err}`);
  }

  mgr.start();

  // Show connection info
  ui.connectionInfo({
    apiUrl: cliArgs.apiUrl,
    agent: cliArgs.agentName,
    branch: cliArgs.baseBranch,
    docker: !cliArgs.noDocker,
    wsPort: actualWsPort,
    llmProvider: cliArgs.llmBaseUrl || "Claude Code CLI",
  });

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

  const POLL_INTERVAL_MS = 30_000; // 30 seconds

  // ---------------------------------------------------------------------------
  // Main polling loop — stays resident, re-checks for new tasks periodically
  // ---------------------------------------------------------------------------
  while (!shuttingDown) {
    // Re-fetch sprint data to pick up newly added tasks (GET, no side effects)
    try {
      sprintData = await api.fetchSprintData();
    } catch (err) {
      ui.warn(`Failed to refresh sprint: ${err}`);
      ui.info(`Waiting ${POLL_INTERVAL_MS / 1000}s before retry...`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const tasks: Task[] = sprintData.tasks;

    const todoTasks = tasks
      .filter((t) => t.status === "in_progress" && t.owner !== "user")
      .sort((a, b) => {
        const pa = typeof a.priority === "string" ? parseInt(a.priority.replace("p", ""), 10) : (a.priority ?? 99);
        const pb = typeof b.priority === "string" ? parseInt(b.priority.replace("p", ""), 10) : (b.priority ?? 99);
        return (pa as number) - (pb as number);
      });

    if (todoTasks.length === 0) {
      const phase = sprintData.sprint?.status ?? "unknown";
      const isIdle = phase === "review" || phase === "retrospective" || phase === "completed";
      const waitMs = isIdle ? POLL_INTERVAL_MS * 4 : POLL_INTERVAL_MS; // 2min in review, 30s in active
      await api.updateAgent({
        name: cliArgs.agentName,
        status: "idle",
        activity: isIdle ? `Sprint ${phase}, waiting` : "Waiting for tasks",
      });
      if (!isIdle) ui.info(`No tasks — polling again in ${waitMs / 1000}s`);
      await sleep(waitMs);
      continue;
    }

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

      const agentName = task.owner ?? "builder";
      const apiDocs = await api.fetchApiDocs(agentName);

      const prompt = buildAgentPrompt({
        role: agentName,
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
        apiDocs: apiDocs || undefined,
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
          type: cliArgs.engine,
          taskId: task.id,
          workingDir: taskWorkingDir,
          branch: cliArgs.baseBranch,
          apiKey: cliArgs.apiKey,
          apiUrl: cliArgs.apiUrl,
          prompt,
          parentAgent: cliArgs.agentName,
          sprintNumber: sprintData.sprint.number,
          ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
          ...(actualWsPort ? { managerPort: actualWsPort } : {}),
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

    // After processing all tasks in this cycle, loop back to poll for more
    if (!shuttingDown) {
      await api.updateAgent({
        name: cliArgs.agentName,
        status: "idle",
        activity: "All tasks completed, waiting for new tasks",
      });
      ui.info(`Tasks done — polling again in ${POLL_INTERVAL_MS / 1000}s`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  await api.updateAgent({
    name: cliArgs.agentName,
    status: "idle",
    activity: "Shut down",
  });
  ui.outro("Shutting down — goodbye");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
let activeManager: Manager | null = null;
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

    if (activeManager) {
      activeManager.stop();
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
// Sprint complete
// ---------------------------------------------------------------------------

async function handleSprintComplete(apiUrl: string, apiKey: string, push: boolean): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);

  ui.intro();

  const s = ui.createSpinner();

  // 1. Fetch current sprint
  s.start("Fetching current sprint...");
  const sprint = await api.fetchCurrentSprint();
  if (!sprint) {
    s.stop("No active sprint found");
    ui.error("No active sprint found. Nothing to complete.");
    process.exit(1);
  }
  s.stop(`Sprint #${sprint.number} (${sprint.status})`);

  // 2. Complete the sprint if not already completed
  if (sprint.status !== "completed") {
    s.start(`Completing sprint #${sprint.number}...`);
    try {
      await api.completeSprint(sprint.number);
      s.stop(`Sprint #${sprint.number} completed`);
    } catch (err) {
      s.stop("Failed to complete sprint");
      ui.error(`${err}`);
      process.exit(1);
    }
  } else {
    ui.info(`Sprint #${sprint.number} already completed`);
  }

  // 3. Create git tag
  const tagName = `sprint-${sprint.number}`;
  try {
    const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    if (existing) {
      ui.warn(`Tag ${tagName} already exists, skipping`);
    } else {
      execSync(`git tag "${tagName}"`, { stdio: "pipe" });
      const shortHash = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
      ui.step(`Tagged ${tagName} at ${shortHash}`);
    }
  } catch (err) {
    ui.warn(`Failed to create tag: ${err}`);
  }

  // 4. Push tag if --push flag
  if (push) {
    try {
      execSync(`git push origin "${tagName}"`, { stdio: "inherit" });
      ui.step(`Pushed ${tagName} to origin`);
    } catch (err) {
      ui.error(`Failed to push tag: ${err}`);
      process.exit(1);
    }
  }

  ui.outro(`Sprint #${sprint.number} complete`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);

// Handle "sprint complete" subcommand
if (cliArgs.command === "sprint") {
  const rawArgs = process.argv.slice(2);
  const subCommand = rawArgs[1];
  if (subCommand === "complete") {
    const push = rawArgs.includes("--push");
    handleSprintComplete(cliArgs.apiUrl, cliArgs.apiKey, push).catch((err) => {
      ui.error(`Fatal error: ${err}`);
      process.exit(1);
    });
  } else {
    ui.error(`Unknown sprint subcommand: ${subCommand}`);
    printUsage();
    process.exit(1);
  }
} else if (cliArgs.command === "start") {
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
} else {
  ui.error(`Unknown command: ${cliArgs.command}`);
  printUsage();
  process.exit(1);
}
