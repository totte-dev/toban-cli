import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, RunningAgent } from "../types.js";
import { getTerminal, buildShellCommand, type TerminalInfo } from "./terminal.js";
import { buildCommand, getEngine } from "./agent-engine.js";

/** Max lines to keep in stdout/stderr buffers */
const LOG_BUFFER_SIZE = 200;

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

  // Clean up stale worktree/branch from previous runs
  if (existsSync(worktreeDir)) {
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
  try { execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
  // Ensure we're on the base branch before deleting agent branch (can't delete checked-out branch)
  try { execSync(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* non-fatal */ }
  try { execSync(`git branch -D "${branchName}"`, { cwd: repoDir, stdio: "pipe" }); } catch { /* may not exist */ }

  // Check if base branch exists (empty repos may not have any branches)
  let hasBaseBranch = false;
  try {
    execSync(`git rev-parse --verify "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
    hasBaseBranch = true;
  } catch { /* branch doesn't exist */ }

  if (hasBaseBranch) {
    execSync(
      `git worktree add -b "${branchName}" "${worktreeDir}" "${baseBranch}"`,
      { cwd: repoDir, stdio: "pipe" }
    );
  } else {
    // Empty repo (no commits, no HEAD) — work directly in the repo dir
    // Worktrees require at least one commit, so skip worktree creation
    try {
      execSync(`git checkout -b "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
    } catch { /* branch may already exist */ }
    return repoDir;
  }

  // Symlink node_modules from main repo so tests and builds work in worktree
  try {
    const mainNodeModules = path.join(repoDir, "node_modules");
    const wtNodeModules = path.join(worktreeDir, "node_modules");
    if (existsSync(mainNodeModules) && !existsSync(wtNodeModules)) {
      symlinkSync(mainNodeModules, wtNodeModules, "dir");
    }
    // Also symlink api/node_modules if it exists (monorepo)
    const apiMainNm = path.join(repoDir, "api", "node_modules");
    const apiWtDir = path.join(worktreeDir, "api");
    const apiWtNm = path.join(apiWtDir, "node_modules");
    if (existsSync(apiMainNm) && existsSync(apiWtDir) && !existsSync(apiWtNm)) {
      symlinkSync(apiMainNm, apiWtNm, "dir");
    }
  } catch { /* non-fatal — tests may fail but agent can still work */ }

  return worktreeDir;
}

/**
 * Ensure git user config is set on a repo (for correct commit author).
 * Call on the main repo — worktrees inherit the config automatically.
 */
export function ensureGitUser(repoDir: string, name: string, email: string): void {
  try {
    const current = execSync("git config user.name", { cwd: repoDir, stdio: "pipe" }).toString().trim();
    if (current === name) return; // Already set correctly
  } catch { /* not set */ }
  try {
    execSync(`git config user.name "${name}"`, { cwd: repoDir, stdio: "pipe" });
    execSync(`git config user.email "${email}"`, { cwd: repoDir, stdio: "pipe" });
  } catch { /* non-fatal */ }
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
  const engine = getEngine(config.type);
  const { cmd, args, stdin: stdinData } = buildCommand(config);

  // Run engine-specific pre-spawn setup
  engine.ensureConfig?.();

  // Prepare environment (engine-specific overrides)
  const agentEnv: Record<string, string | undefined> = { ...process.env };
  engine.prepareEnv?.(agentEnv);

  const child = spawn(cmd, args, {
    cwd: worktreePath,
    stdio: [stdinData ? "pipe" : "ignore", "pipe", "pipe"],
    env: {
      ...agentEnv,
      TOBAN_API_KEY: config.apiKey,
      TOBAN_API_URL: config.apiUrl,
      TOBAN_AGENT_NAME: config.name,
      TOBAN_TASK_ID: config.taskId,
      ...(config.taskTitle ? { TOBAN_TASK_TITLE: config.taskTitle } : {}),
      ...(config.sprintNumber != null ? { TOBAN_SPRINT: String(config.sprintNumber) } : {}),
      ...(config.managerPort ? { TOBAN_MANAGER_PORT: String(config.managerPort) } : {}),
      // Inject project secrets directly as env vars (no prefix in non-Docker mode)
      ...(config.secrets ?? {}),
    },
    detached: true,
  });

  // Write prompt to stdin if needed (for --allowedTools + -p - pattern)
  if (stdinData && child.stdin) {
    child.stdin.write(stdinData);
    child.stdin.end();
  }

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
  const engine = getEngine(config.type);
  const { cmd, args } = buildCommand(config);

  engine.ensureConfig?.();

  const terminal = getTerminal(terminalPreference);

  const agentEnv: Record<string, string> = {
    TOBAN_API_KEY: config.apiKey,
    TOBAN_API_URL: config.apiUrl,
    TOBAN_AGENT_NAME: config.name,
    TOBAN_TASK_ID: config.taskId,
    ...(config.taskTitle ? { TOBAN_TASK_TITLE: config.taskTitle } : {}),
    ...(config.sprintNumber != null ? { TOBAN_SPRINT: String(config.sprintNumber) } : {}),
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
