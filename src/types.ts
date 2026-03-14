export type AgentType = "claude" | "cursor" | "codex" | "custom";

export interface AgentConfig {
  /** Agent display name */
  name: string;
  /** Type of agent to spawn */
  type: AgentType;
  /** Task ID this agent is working on */
  taskId: string;
  /** Absolute path to the repository root */
  workingDir: string;
  /** Base branch to create worktree from (defaults to "main") */
  branch?: string;
  /** API key for reporting status back to toban-api */
  apiKey: string;
  /** Base URL of the toban-api instance */
  apiUrl: string;
  /** Prompt / instructions to send to the agent */
  prompt?: string;
  /** Custom command to run (required for type "custom") */
  command?: string;
  /** Custom args for the command */
  args?: string[];
  /** Parent agent name (for child process tracking) */
  parentAgent?: string;
  /** Sprint number for retro comments */
  sprintNumber?: number;
}

export type AgentStatus = "spawning" | "running" | "completed" | "failed" | "stopped";

export interface RunningAgent {
  config: AgentConfig;
  status: AgentStatus;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
  exitCode: number | null;
  stdout: string[];
  stderr: string[];
}

export interface AgentStatusReport {
  name: string;
  type: AgentType;
  taskId: string;
  status: AgentStatus;
  branch: string;
  pid: number | null;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  lastStdout: string[];
  lastStderr: string[];
}
