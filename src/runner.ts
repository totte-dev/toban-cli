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
import type { RetroCommentInput } from "./api-client.js";

export { detectTerminal, getTerminal } from "./terminal.js";
export type { TerminalInfo } from "./terminal.js";
export type { AgentConfig, AgentStatusReport, RunningAgent } from "./types.js";

interface ManagedAgent {
  agent: RunningAgent;
  process: ChildProcess;
}

export class AgentRunner {
  private agents = new Map<string, ManagedAgent>();

  /**
   * Spawn a new agent process.
   */
  async spawn(config: AgentConfig): Promise<RunningAgent> {
    if (this.agents.has(config.name)) {
      throw new Error(`Agent "${config.name}" is already running`);
    }

    const baseBranch = config.branch ?? "main";
    const branchName = buildBranchName(config.name, config.taskId);

    const worktreePath = createWorktree(config.workingDir, branchName, baseBranch);
    const { process: child, agent } = spawnAgent(config, worktreePath);

    const managed: ManagedAgent = { agent, process: child };
    this.agents.set(config.name, managed);

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

    if (managed.process.pid) {
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
