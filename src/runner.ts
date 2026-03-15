import type { ChildProcess } from "node:child_process";
import type { AgentConfig, AgentStatusReport, RunningAgent } from "./types.js";
import {
  buildBranchName,
  createWorktree,
  removeWorktree,
  spawnAgent,
  spawnAgentInTerminal,
  tryMerge,
} from "./spawner.js";
import {
  isDockerAvailable,
  isImageAvailable,
  buildImage,
  spawnAgentInDocker,
  stopDockerAgent,
} from "./docker.js";
import type { RetroCommentInput } from "./api-client.js";
import * as ui from "./ui.js";

export { detectTerminal, getTerminal } from "./terminal.js";
export type { TerminalInfo } from "./terminal.js";
export type { AgentConfig, AgentStatusReport, RunningAgent } from "./types.js";

interface ManagedAgent {
  agent: RunningAgent;
  process: ChildProcess;
  docker?: boolean;
}

/** Callback for agent stdout/stderr streaming */
export type StdoutCallback = (agentName: string, lines: string[], stream: "stdout" | "stderr") => void;

export interface AgentRunnerOptions {
  /** Use Docker containers for agent isolation (default: auto-detect) */
  useDocker?: boolean;
  /** Path to Dockerfile directory for building the image */
  dockerfilePath?: string;
  /** Callback for streaming agent stdout/stderr to WebSocket clients */
  onStdout?: StdoutCallback;
}

export class AgentRunner {
  private agents = new Map<string, ManagedAgent>();
  private useDocker: boolean;
  private dockerfilePath?: string;
  private dockerChecked = false;
  private onStdout?: StdoutCallback;

  constructor(options?: AgentRunnerOptions) {
    this.useDocker = options?.useDocker ?? true; // default: try Docker
    this.dockerfilePath = options?.dockerfilePath;
    this.onStdout = options?.onStdout;
  }

  /**
   * Check Docker availability and prepare the image if needed.
   * Called once before the first Docker spawn.
   */
  private ensureDocker(): boolean {
    if (this.dockerChecked) return this.useDocker;
    this.dockerChecked = true;

    if (!this.useDocker) {
      ui.info("[docker] Docker mode disabled (--no-docker)");
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

    const worktreePath = createWorktree(config.workingDir, branchName, baseBranch);

    const { process: child, agent } = useDocker
      ? spawnAgentInDocker(config, worktreePath)
      : spawnAgent(config, worktreePath);

    const managed: ManagedAgent = { agent, process: child, docker: useDocker };
    this.agents.set(config.name, managed);

    // Stream stdout/stderr to WebSocket clients
    if (this.onStdout) {
      const cb = this.onStdout;
      const agentName = config.name;
      child.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        if (lines.length > 0) cb(agentName, lines, "stdout");
      });
      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        if (lines.length > 0) cb(agentName, lines, "stderr");
      });
    }

    if (useDocker) {
      ui.info(`[docker] Agent ${config.name} running in container`);
    }

    await this.reportStatus(config, "running");

    child.on("exit", async (code, signal) => {
      agent.status = code === 0 ? "completed" : "failed";
      agent.exitCode = code;
      agent.stoppedAt = new Date();

      if (code === 0) {
        const merged = tryMerge(config.workingDir, branchName, baseBranch);
        if (merged) {
          removeWorktree(config.workingDir, worktreePath, branchName);
          await this.reportStatus(config, "completed", "Branch merged successfully");
        } else {
          await this.reportStatus(
            config,
            "completed",
            `Merge conflict on branch ${branchName} - manual resolution needed`
          );
        }

        if (config.sprintNumber) {
          const retro = this.extractRetroComment(agent, config);
          if (retro) {
            await this.submitRetro(config, retro);
          }
        }
      } else {
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
        process.kill(-managed.process.pid, "SIGTERM");
      } catch {
        managed.process.kill("SIGTERM");
      }
    } else {
      managed.process.kill("SIGTERM");
    }

    try {
      removeWorktree(
        managed.agent.config.workingDir,
        managed.agent.worktreePath,
        managed.agent.branch
      );
    } catch {
      // best effort cleanup
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
    for (const line of agent.stdout) {
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
          parent_agent: config.parentAgent ?? null,
        }),
      });
    } catch {
      // Non-fatal
    }
  }
}
