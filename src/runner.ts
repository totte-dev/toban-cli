import { execSync, type ChildProcess } from "node:child_process";
import type { AgentConfig, AgentStatusReport, RunningAgent } from "./types.js";
import {
  buildBranchName,
  createWorktree,
  removeWorktree,
  spawnAgent,
  spawnAgentInTerminal,
  tryMerge,
} from "./spawner.js";
import { getEngine, extractTextFromStreamJson } from "./agent-engine.js";
import {
  isDockerAvailable,
  isImageAvailable,
  buildImage,
  spawnAgentInDocker,
  stopDockerAgent,
} from "./docker.js";
import type { RetroCommentInput } from "./api-client.js";
import * as ui from "./ui.js";

export type { AgentConfig, AgentStatusReport, RunningAgent } from "./types.js";

interface ManagedAgent {
  agent: RunningAgent;
  process: ChildProcess;
  docker?: boolean;
}

/** Callback for agent stdout/stderr streaming */
export type StdoutCallback = (agentName: string, lines: string[], stream: "stdout" | "stderr") => void;

// Re-export AgentActivity from types for backward compat
export type { AgentActivity } from "./types.js";
import type { AgentActivity } from "./types.js";

/** Callback for structured agent activity events */
export type ActivityCallback = (agentName: string, activity: AgentActivity) => void;

export interface AgentRunnerOptions {
  /** Use Docker containers for agent isolation (default: auto-detect) */
  useDocker?: boolean;
  /** Path to Dockerfile directory for building the image */
  dockerfilePath?: string;
  /** Callback for streaming agent stdout/stderr to WebSocket clients */
  onStdout?: StdoutCallback;
  /** Callback for structured tool_use activity events */
  onActivity?: ActivityCallback;
}

export class AgentRunner {
  private agents = new Map<string, ManagedAgent>();
  private useDocker: boolean;
  private dockerfilePath?: string;
  private dockerChecked = false;
  private onStdout?: StdoutCallback;
  private onActivity?: ActivityCallback;

  constructor(options?: AgentRunnerOptions) {
    this.useDocker = options?.useDocker ?? true; // default: try Docker
    this.dockerfilePath = options?.dockerfilePath;
    this.onStdout = options?.onStdout;
    this.onActivity = options?.onActivity;
  }

  /**
   * Check Docker availability and prepare the image if needed.
   * Called once before the first Docker spawn.
   */
  private ensureDocker(): boolean {
    if (this.dockerChecked) return this.useDocker;
    this.dockerChecked = true;

    if (!this.useDocker) {
      ui.debug("docker", "Docker mode disabled (--no-docker)");
      return false;
    }

    if (!isDockerAvailable()) {
      ui.warn(
        "[docker] Docker not available. Running agents directly on host.\n" +
        "[docker]   Install Docker for filesystem isolation: https://docs.docker.com/get-docker/"
      );
      this.useDocker = false;
      return false;
    }

    if (!isImageAvailable()) {
      if (this.dockerfilePath) {
        try {
          buildImage(this.dockerfilePath);
        } catch (err) {
          ui.warn(`[docker] Failed to build image: ${err}`);
          ui.warn("[docker]   Falling back to direct execution");
          this.useDocker = false;
          return false;
        }
      } else {
        ui.warn(
          "[docker] toban/agent:latest image not found. Running agents directly on host.\n" +
          "[docker]   Build the image: docker build -t toban/agent:latest ."
        );
        this.useDocker = false;
        return false;
      }
    }

    ui.step("[docker] Using Docker container isolation for agents");
    return true;
  }

  /**
   * Spawn a new agent process.
   */
  async spawn(config: AgentConfig): Promise<RunningAgent> {
    if (this.agents.has(config.name)) {
      throw new Error(`Agent "${config.name}" is already running`);
    }

    const useDocker = this.ensureDocker();
    const baseBranch = config.branch ?? "main";
    const branchName = buildBranchName(config.name, config.taskId);

    // Docker mode: entrypoint creates worktree inside the container.
    // The bind mount is the original repo so git operations persist on host.
    // Non-Docker mode: create host-side worktree as before.
    const worktreePath = useDocker
      ? config.workingDir
      : createWorktree(config.workingDir, branchName, baseBranch);

    const { process: child, agent } = useDocker
      ? spawnAgentInDocker(config, worktreePath)
      : spawnAgent(config, worktreePath);

    const managed: ManagedAgent = { agent, process: child, docker: useDocker };
    this.agents.set(config.name, managed);

    // Stream stdout/stderr to WebSocket clients
    // Use engine provider for structured output parsing
    const engine = getEngine(config.type);
    ui.debug("runner", `Engine: ${engine.id}, structured: ${engine.supportsStructuredOutput}, hasParser: ${!!engine.parseOutputLine}, hasActivityCb: ${!!this.onActivity}`);
    if (this.onStdout || this.onActivity) {
      const stdoutCb = this.onStdout;
      const activityCb = this.onActivity;
      const agentName = config.name;
      let stdoutBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        if (engine.supportsStructuredOutput && engine.parseOutputLine && activityCb) {
          // Structured output: parse JSONL lines into activity events
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? ""; // keep incomplete last line

          for (const line of lines) {
            if (!line.trim()) continue;
            const activities = engine.parseOutputLine(line);
            for (const act of activities) {
              activityCb(agentName, act);
            }
          }
        } else {
          // Plain text output: forward as raw stdout
          const lines = data.toString().split("\n").filter(Boolean);
          if (lines.length > 0 && stdoutCb) stdoutCb(agentName, lines, "stdout");
        }
      });
      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        if (lines.length > 0 && stdoutCb) stdoutCb(agentName, lines, "stderr");
      });
    }

    if (useDocker) {
      ui.debug("docker", `Agent ${config.name} running in container`);
    }

    await this.reportStatus(config, "running");

    child.on("exit", async (code, signal) => {
      agent.status = code === 0 ? "completed" : "failed";
      agent.exitCode = code;
      agent.stoppedAt = new Date();

      // Merge, push, retro, and status updates are handled by template
      // post_actions in cli.ts — runner only tracks agent status.
      if (code !== 0) {
        const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
        await this.reportStatus(config, "failed", reason);
      }

      this.agents.delete(config.name);
    });

    child.on("error", async (err) => {
      agent.status = "failed";
      agent.stoppedAt = new Date();
      agent.stderr.push(err.message);
      await this.reportStatus(config, "failed", err.message);
      this.agents.delete(config.name);
    });

    return agent;
  }

  /**
   * Stop a running agent by name.
   */
  stop(agentName: string): boolean {
    const managed = this.agents.get(agentName);
    if (!managed) return false;

    managed.agent.status = "stopped";
    managed.agent.stoppedAt = new Date();

    if (managed.docker) {
      // Stop the Docker container
      stopDockerAgent(managed.agent.config.name, managed.agent.config.taskId);
    } else if (managed.process.pid) {
      try {
        // Try killing entire process group first
        process.kill(-managed.process.pid, "SIGTERM");
      } catch {
        // Group kill may fail (e.g. no process group); fall back to individual process
        managed.process.kill("SIGTERM");
      }
    } else {
      managed.process.kill("SIGTERM");
    }

    if (managed.docker) {
      // Docker mode: clean up the in-container worktree branch
      const dockerBranch = buildDockerBranchName(
        managed.agent.config.name,
        managed.agent.config.taskId
      );
      try {
        execSync(`git worktree prune`, { cwd: managed.agent.config.workingDir, stdio: "pipe" });
        execSync(`git branch -D "${dockerBranch}"`, { cwd: managed.agent.config.workingDir, stdio: "pipe" });
      } catch {
        // best effort cleanup
      }
    } else {
      try {
        removeWorktree(
          managed.agent.config.workingDir,
          managed.agent.worktreePath,
          managed.agent.branch
        );
      } catch {
        // best effort cleanup
      }
    }

    this.agents.delete(agentName);
    return true;
  }

  /**
   * Return status of all running/tracked agents.
   */
  status(): AgentStatusReport[] {
    const reports: AgentStatusReport[] = [];
    for (const [, managed] of this.agents) {
      const { agent } = managed;
      reports.push({
        name: agent.config.name,
        type: agent.config.type,
        taskId: agent.config.taskId,
        status: agent.status,
        branch: agent.branch,
        pid: agent.pid,
        startedAt: agent.startedAt.toISOString(),
        stoppedAt: agent.stoppedAt?.toISOString() ?? null,
        exitCode: agent.exitCode,
        lastStdout: agent.stdout.slice(-20),
        lastStderr: agent.stderr.slice(-20),
      });
    }
    return reports;
  }

  private extractRetroComment(
    agent: RunningAgent,
    config: AgentConfig
  ): RetroCommentInput | null {
    // Search all stdout lines — may be raw text or stream-json JSONL
    for (const line of agent.stdout) {
      // Direct match (non-stream-json or already extracted text)
      if (line.startsWith("RETRO_JSON:")) {
        try {
          const json = JSON.parse(line.slice("RETRO_JSON:".length));
          return {
            agent_name: config.name,
            went_well: json.went_well || undefined,
            to_improve: json.to_improve || undefined,
            suggested_tasks: json.suggested_tasks || undefined,
          };
        } catch {
          // skip
        }
      }

      // Stream-json: check inside result or assistant text blocks
      try {
        const event = JSON.parse(line);
        const text = extractTextFromStreamJson(event);
        if (text) {
          const retroMatch = text.match(/RETRO_JSON:(\{[\s\S]*\})/);
          if (retroMatch) {
            const json = JSON.parse(retroMatch[1]);
            return {
              agent_name: config.name,
              went_well: json.went_well || undefined,
              to_improve: json.to_improve || undefined,
              suggested_tasks: json.suggested_tasks || undefined,
            };
          }
        }
      } catch {
        // not JSON, skip
      }
    }
    return null;
  }

  private async submitRetro(
    config: AgentConfig,
    retro: RetroCommentInput
  ): Promise<void> {
    if (!config.sprintNumber) return;
    try {
      await fetch(`${config.apiUrl}/api/v1/sprints/${config.sprintNumber}/retro`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(retro),
      });
    } catch {
      // Non-fatal
    }
  }

  private async reportStatus(
    config: AgentConfig,
    status: string,
    activity?: string
  ): Promise<void> {
    ui.debug("api", `PUT /agents ${config.name} → ${status}${activity ? ` (${activity})` : ""}`);
    try {
      await fetch(`${config.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          name: config.name,
          status,
          activity: activity ?? `Task ${config.taskId}`,
        }),
      });
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Build the branch name used by the Docker entrypoint.
 * Must match the pattern in entrypoint.sh.
 */
function buildDockerBranchName(agentName: string, taskId: string): string {
  return `agent/${agentName}/${taskId}`;
}

/**
 * Merge an agent's worktree branch into the base branch and clean up.
 * Used after Docker container exits — the entrypoint created the branch
 * inside the container, but it persists on the host via bind mount.
 */
function mergeAgentBranch(
  repoDir: string,
  branchName: string,
  baseBranch: string
): boolean {
  try {
    // Check if branch has commits beyond base
    const diff = execSync(
      `git log "${baseBranch}".."${branchName}" --oneline`,
      { cwd: repoDir, stdio: "pipe" }
    ).toString().trim();

    if (!diff) {
      // No new commits — nothing to merge, just clean up
      cleanupDockerBranch(repoDir, branchName);
      return true;
    }

    // Squash merge into base branch
    execSync(`git checkout "${baseBranch}"`, { cwd: repoDir, stdio: "pipe" });
    execSync(`git merge --squash "${branchName}"`, { cwd: repoDir, stdio: "pipe" });
    execSync(
      `git commit -m "feat: agent work from ${branchName}"`,
      { cwd: repoDir, stdio: "pipe" }
    );

    cleanupDockerBranch(repoDir, branchName);
    return true;
  } catch {
    // Merge conflict or other issue — abort if needed
    try {
      execSync("git merge --abort", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // already clean
    }
    cleanupDockerBranch(repoDir, branchName);
    return false;
  }
}

// Stream-JSON parsing helpers moved to agent-engine.ts

/**
 * Clean up a Docker worktree branch and prune stale worktree references.
 */
function cleanupDockerBranch(repoDir: string, branchName: string): void {
  try {
    execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
  } catch {
    // best effort
  }
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: repoDir, stdio: "pipe" });
  } catch {
    // branch may not exist
  }
}
