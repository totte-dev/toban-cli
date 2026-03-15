import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentConfig, RunningAgent } from "./types.js";
import { getTerminal, buildShellCommand, type TerminalInfo } from "./terminal.js";
import { buildCommand } from "./command-builder.js";

/** Max lines to keep in stdout/stderr buffers */
const LOG_BUFFER_SIZE = 200;

/**
 * Ensure ~/.claude.json exists so Claude CLI doesn't fail on startup.
 */
function ensureClaudeConfig(): void {
  const configPath = path.join(os.homedir(), ".claude.json");
  if (fs.existsSync(configPath)) return;

  // Check for backup
  const backupDir = path.join(os.homedir(), ".claude", "backups");
  if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith(".claude.json.backup."));
    if (backups.length > 0) {
      const latest = backups.sort().pop()!;
      fs.copyFileSync(path.join(backupDir, latest), configPath);
      return;
    }
  }

  // Create minimal config
  fs.writeFileSync(configPath, JSON.stringify({
    numStartups: 1,
    autoUpdates: false,
    hasCompletedOnboarding: true,
  }, null, 2));
}

/**
 * Build the branch name for an agent task.
 */
export function buildBranchName(agentName: string, taskId: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const shortId = taskId.slice(0, 8);
  return `agent/${safe}-${shortId}`;
}

/**
 * Create a git worktree for the agent to work in.
 */
export function createWorktree(
  repoDir: string,
  branchName: string,
  baseBranch: string
): string {
  const worktreeDir = path.join(repoDir, ".worktrees", branchName.replace(/\//g, "-"));

  execSync(
    `git worktree add -b "${branchName}" "${worktreeDir}" "${baseBranch}"`,
    { cwd: repoDir, stdio: "pipe" }
  );

  return worktreeDir;
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(repoDir: string, worktreePath: string, branchName: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch {
    // worktree may already be removed
  }
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoDir, stdio: "pipe" });
  } catch {
    // branch may already be deleted
  }
}

/**
 * Spawn an agent process in the given worktree directory.
 */
export function spawnAgent(
  config: AgentConfig,
  worktreePath: string
): { process: ChildProcess; agent: RunningAgent } {
  const branchName = buildBranchName(config.name, config.taskId);
  const { cmd, args } = buildCommand(config);

  // Ensure Claude CLI config exists before spawning
  if (config.type === "claude") {
    ensureClaudeConfig();
  }

  // Remove CLAUDECODE to avoid nested session detection when spawning claude
  const agentEnv = { ...process.env };
  delete agentEnv.CLAUDECODE;

  const child = spawn(cmd, args, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...agentEnv,
      TOBAN_API_KEY: config.apiKey,
      TOBAN_API_URL: config.apiUrl,
      TOBAN_AGENT_NAME: config.name,
      TOBAN_TASK_ID: config.taskId,
      // Inject project secrets directly as env vars (no prefix in non-Docker mode)
      ...(config.secrets ?? {}),
    },
    detached: true,
  });

  const agent: RunningAgent = {
    config,
    status: "spawning",
    branch: branchName,
    worktreePath,
    pid: child.pid ?? null,
    startedAt: new Date(),
    stoppedAt: null,
    exitCode: null,
    stdout: [],
    stderr: [],
  };

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    agent.stdout.push(...lines);
    if (agent.stdout.length > LOG_BUFFER_SIZE) {
      agent.stdout = agent.stdout.slice(-LOG_BUFFER_SIZE);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    agent.stderr.push(...lines);
    if (agent.stderr.length > LOG_BUFFER_SIZE) {
      agent.stderr = agent.stderr.slice(-LOG_BUFFER_SIZE);
    }
  });

  agent.status = "running";

  return { process: child, agent };
}

/**
 * Spawn an agent process inside a native terminal window.
 */
export function spawnAgentInTerminal(
  config: AgentConfig,
  worktreePath: string,
  terminalPreference?: string
): { process: ChildProcess; agent: RunningAgent; terminal: TerminalInfo } {
  const branchName = buildBranchName(config.name, config.taskId);
  const { cmd, args } = buildCommand(config);

  if (config.type === "claude") {
    ensureClaudeConfig();
  }

  const terminal = getTerminal(terminalPreference);

  const agentEnv: Record<string, string> = {
    TOBAN_API_KEY: config.apiKey,
    TOBAN_API_URL: config.apiUrl,
    TOBAN_AGENT_NAME: config.name,
    TOBAN_TASK_ID: config.taskId,
  };

  const shellCommand = buildShellCommand(cmd, args, agentEnv);
  const termArgs = terminal.args(shellCommand, worktreePath);

  const child = spawn(terminal.command, termArgs, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...agentEnv },
    detached: terminal.name !== "direct",
  });

  const agent: RunningAgent = {
    config,
    status: "spawning",
    branch: branchName,
    worktreePath,
    pid: child.pid ?? null,
    startedAt: new Date(),
    stoppedAt: null,
    exitCode: null,
    stdout: [],
    stderr: [],
  };

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    agent.stdout.push(...lines);
    if (agent.stdout.length > LOG_BUFFER_SIZE) {
      agent.stdout = agent.stdout.slice(-LOG_BUFFER_SIZE);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    agent.stderr.push(...lines);
    if (agent.stderr.length > LOG_BUFFER_SIZE) {
      agent.stderr = agent.stderr.slice(-LOG_BUFFER_SIZE);
    }
  });

  agent.status = "running";

  return { process: child, agent, terminal };
}

/**
 * Attempt to merge the agent's branch into the base branch.
 */
export function tryMerge(repoDir: string, branchName: string, baseBranch: string): boolean {
  try {
    execSync(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
    execSync(`git merge --no-ff "${branchName}" -m "merge: ${branchName}"`, {
      cwd: repoDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    try {
      execSync("git merge --abort", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // already clean
    }
    return false;
  }
}
