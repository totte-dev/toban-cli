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

/** Structured activity event from agent */
export interface AgentActivity {
  /** Event kind: tool_use, text (agent reasoning), result (final output) */
  kind: "tool" | "text" | "result";
  tool?: string;
  /** Brief summary of what's happening */
  summary: string;
  timestamp: string;
}

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
    // For Claude agents with stream-json output, parse structured events
    const isClaude = config.type === "claude";
    if (this.onStdout || this.onActivity) {
      const stdoutCb = this.onStdout;
      const activityCb = this.onActivity;
      const agentName = config.name;
      let stdoutBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        if (isClaude && activityCb) {
          // Parse stream-json JSONL: each line is a JSON object
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? ""; // keep incomplete last line

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              const activities = parseStreamJsonEvents(event);
              for (const act of activities) {
                activityCb(agentName, act);
              }
            } catch {
              // Not JSON — forward as raw text activity
              activityCb(agentName, { kind: "text", summary: line, timestamp: new Date().toISOString() });
            }
          }
        } else {
          // Non-Claude agents: forward raw stdout
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

      if (code === 0) {
        if (useDocker) {
          // Docker mode: the entrypoint created a worktree branch inside the container.
          // The branch persists on the host via the bind mount.
          const dockerBranch = buildDockerBranchName(config.name, config.taskId);
          ui.debug("git", `Merging branch ${dockerBranch} → ${baseBranch}`);
          const merged = mergeAgentBranch(config.workingDir, dockerBranch, baseBranch);
          if (merged) {
            ui.debug("git", `Branch ${dockerBranch} merged successfully`);
            await this.reportStatus(config, "completed", "Branch merged successfully");
          } else {
            ui.debug("git", `Merge conflict on branch ${dockerBranch}`);
            await this.reportStatus(
              config,
              "completed",
              `Merge conflict on branch ${dockerBranch} - manual resolution needed`
            );
          }
        } else {
          ui.debug("git", `Merging branch ${branchName} → ${baseBranch}`);
          const merged = tryMerge(config.workingDir, branchName, baseBranch);
          if (merged) {
            ui.debug("git", `Branch ${branchName} merged successfully`);
            removeWorktree(config.workingDir, worktreePath, branchName);
            await this.reportStatus(config, "completed", "Branch merged successfully");
          } else {
            ui.debug("git", `Merge conflict on branch ${branchName}`);
            await this.reportStatus(
              config,
              "completed",
              `Merge conflict on branch ${branchName} - manual resolution needed`
            );
          }
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
          parent_agent: config.parentAgent ?? null,
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
export function mergeAgentBranch(
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

// ---------------------------------------------------------------------------
// Stream-JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a stream-json event and extract all meaningful activities.
 * Claude CLI stream-json emits JSONL with events like:
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
 *   {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read",...}}
 *   {"type":"result","subtype":"success","result":"...","cost_usd":0.05}
 */
function parseStreamJsonEvents(event: Record<string, unknown>): AgentActivity[] {
  const now = new Date().toISOString();
  const activities: AgentActivity[] = [];

  // content_block_start with tool_use
  if (event.type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use" && typeof block.name === "string") {
      activities.push({
        kind: "tool",
        tool: block.name,
        summary: summarizeToolInput(block.name, block.input as Record<string, unknown> | undefined),
        timestamp: now,
      });
    }
  }

  // assistant message — text blocks + tool_use blocks
  if (event.type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          activities.push({ kind: "text", summary: block.text.trim(), timestamp: now });
        }
        if (block?.type === "tool_use" && typeof block.name === "string") {
          activities.push({
            kind: "tool",
            tool: block.name,
            summary: summarizeToolInput(block.name, block.input as Record<string, unknown> | undefined),
            timestamp: now,
          });
        }
      }
    }
  }

  // result event — final output
  if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
    activities.push({ kind: "result", summary: event.result.trim(), timestamp: now });
  }

  return activities;
}

/**
 * Extract displayable text content from a stream-json event.
 * Used by extractRetroComment for backward compat.
 */
function extractTextFromStreamJson(event: Record<string, unknown>): string | null {
  if (event.type === "result" && typeof event.result === "string") {
    return event.result;
  }
  if (event.type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((b: Record<string, unknown>) => b.type === "text" && typeof b.text === "string")
        .map((b: Record<string, unknown>) => b.text as string);
      if (texts.length > 0) return texts.join("");
    }
  }
  return null;
}

/**
 * Create a brief human-readable summary of a tool invocation.
 */
function summarizeToolInput(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName;

  switch (toolName) {
    case "Read":
      return input.file_path ? `Read ${shortenPath(input.file_path as string)}` : "Read";
    case "Write":
      return input.file_path ? `Write ${shortenPath(input.file_path as string)}` : "Write";
    case "Edit":
      return input.file_path ? `Edit ${shortenPath(input.file_path as string)}` : "Edit";
    case "Glob":
      return input.pattern ? `Glob ${input.pattern}` : "Glob";
    case "Grep":
      return input.pattern ? `Grep "${input.pattern}"` : "Grep";
    case "Bash": {
      const cmd = input.command as string | undefined;
      return cmd ? `Bash: ${cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd}` : "Bash";
    }
    case "Agent":
      return input.description ? `Agent: ${input.description}` : "Agent";
    default:
      return toolName;
  }
}

/** Shorten a file path to the last 2 segments */
function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

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
