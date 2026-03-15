import { execSync, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, RunningAgent } from "./types.js";
import { buildBranchName } from "./spawner.js";

/** Docker image name for the agent container */
const AGENT_IMAGE = "toban/agent:latest";

/** Max lines to keep in stdout/stderr buffers */
const LOG_BUFFER_SIZE = 200;

/**
 * Check if Docker is available and running.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the toban/agent image exists locally.
 */
export function isImageAvailable(): boolean {
  try {
    const result = execSync(`docker image inspect ${AGENT_IMAGE}`, {
      stdio: "pipe",
      timeout: 5000,
    });
    return result.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the toban/agent Docker image from the Dockerfile.
 * @param dockerfilePath Path to the directory containing the Dockerfile
 */
export function buildImage(dockerfilePath: string): void {
  console.log(`[docker] Building ${AGENT_IMAGE} image...`);
  execSync(`docker build -t ${AGENT_IMAGE} "${dockerfilePath}"`, {
    stdio: "inherit",
    timeout: 300000, // 5 min
  });
  console.log(`[docker] Image ${AGENT_IMAGE} built successfully`);
}

/**
 * Build docker run arguments for an agent container.
 */
function buildDockerArgs(
  config: AgentConfig,
  worktreePath: string,
  agentCmd: string,
  agentArgs: string[]
): string[] {
  const home = homedir();
  const containerName = `toban-agent-${config.name}-${config.taskId.slice(0, 8)}`;

  const args: string[] = [
    "run",
    "--rm",
    "--name", containerName,
    // Mount the worktree as /workspace
    "-v", `${worktreePath}:/workspace`,
    // Mount CLI auth directories as read-only
    ...(existsSync(join(home, ".claude"))
      ? ["-v", `${join(home, ".claude")}:/home/agent/.claude:ro`]
      : []),
    ...(existsSync(join(home, ".config", "claude"))
      ? ["-v", `${join(home, ".config", "claude")}:/home/agent/.config/claude:ro`]
      : []),
    // Gemini CLI auth
    ...(existsSync(join(home, ".config", "gemini"))
      ? ["-v", `${join(home, ".config", "gemini")}:/home/agent/.config/gemini:ro`]
      : []),
    // Codex CLI auth
    ...(existsSync(join(home, ".codex"))
      ? ["-v", `${join(home, ".codex")}:/home/agent/.codex:ro`]
      : []),
    // OpenAI config (used by Codex)
    ...(existsSync(join(home, ".config", "openai"))
      ? ["-v", `${join(home, ".config", "openai")}:/home/agent/.config/openai:ro`]
      : []),
    // Environment variables
    "-e", `TOBAN_API_KEY=${config.apiKey}`,
    "-e", `TOBAN_API_URL=${config.apiUrl}`,
    "-e", `TOBAN_AGENT_NAME=${config.name}`,
    "-e", `TOBAN_TASK_ID=${config.taskId}`,
    // Working directory
    "-w", "/workspace",
    // Pass GITHUB_TOKEN for git push and gh pr create
    ...(process.env.GITHUB_TOKEN
      ? ["-e", `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`]
      : []),
    // Inject project secrets with TOBAN_SECRET_ prefix
    ...(config.secrets
      ? Object.entries(config.secrets).flatMap(([key, value]) => [
          "-e", `TOBAN_SECRET_${key}=${value}`,
        ])
      : []),
    // Mount tmpfs for .env.local if secrets exist
    ...(config.secrets && Object.keys(config.secrets).length > 0
      ? ["--tmpfs", "/workspace/.env.local:rw,noexec,nosuid,size=64k"]
      : []),
    // Image
    AGENT_IMAGE,
    // Override CMD with the full command (e.g., "claude --dangerously-skip-permissions ...")
    agentCmd,
    ...agentArgs,
  ];

  return args;
}

/**
 * Build the agent command and args (same logic as spawner.ts buildCommand).
 */
function buildAgentCommand(config: AgentConfig): { cmd: string; args: string[] } {
  if (config.commandTemplate) {
    const parts = config.commandTemplate.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const templateArgs = parts.slice(1);
    const cmdBase = cmd.split("/").pop() ?? cmd;

    if (cmdBase === "claude") {
      return {
        cmd,
        args: [
          ...templateArgs,
          "--dangerously-skip-permissions",
          "--print",
          ...(config.prompt ? [config.prompt] : []),
        ],
      };
    } else if (cmdBase === "codex") {
      return {
        cmd,
        args: [
          ...templateArgs,
          "--quiet",
          ...(config.prompt ? ["--prompt", config.prompt] : []),
        ],
      };
    } else if (cmdBase === "gemini") {
      return {
        cmd,
        args: [
          ...templateArgs,
          ...(config.prompt ? [config.prompt] : []),
        ],
      };
    }
    return { cmd, args: [...templateArgs, ...(config.prompt ? [config.prompt] : [])] };
  }

  // Fallback: use config.type
  switch (config.type) {
    case "codex":
      return {
        cmd: "codex",
        args: [
          "--quiet",
          ...(config.prompt ? ["--prompt", config.prompt] : []),
        ],
      };
    case "gemini":
      return {
        cmd: "gemini",
        args: [
          ...(config.prompt ? [config.prompt] : []),
        ],
      };
    default:
      // Default: claude
      return {
        cmd: "claude",
        args: [
          "--dangerously-skip-permissions",
          "--print",
          ...(config.prompt ? [config.prompt] : []),
        ],
      };
  }
}

/**
 * Spawn an agent process inside a Docker container.
 */
export function spawnAgentInDocker(
  config: AgentConfig,
  worktreePath: string
): { process: ChildProcess; agent: RunningAgent } {
  const branchName = buildBranchName(config.name, config.taskId);
  const { cmd, args: agentArgs } = buildAgentCommand(config);

  const dockerArgs = buildDockerArgs(config, worktreePath, cmd, agentArgs);

  const child = spawn("docker", dockerArgs, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
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
 * Stop a Docker container by agent name and task ID.
 */
export function stopDockerAgent(agentName: string, taskId: string): void {
  const containerName = `toban-agent-${agentName}-${taskId.slice(0, 8)}`;
  try {
    execSync(`docker stop "${containerName}"`, { stdio: "pipe", timeout: 10000 });
  } catch {
    // Container may already be stopped
  }
}
