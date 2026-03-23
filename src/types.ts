export type AgentType = "claude" | "cursor" | "codex" | "gemini" | "mock" | "custom";

export interface AgentConfig {
  /** Agent display name */
  name: string;
  /** Type of agent to spawn */
  type: AgentType;
  /** Task ID this agent is working on */
  taskId: string;
  /** Task title (for channel metadata) */
  taskTitle?: string;
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
  /** Full command template from provider config (e.g. "claude --model claude-sonnet-4-20250514") */
  commandTemplate?: string;
  /** Project secrets to inject into the agent environment */
  secrets?: Record<string, string>;
  /** Manager WS server port (for agent HTTP messaging) */
  managerPort?: number;
  /** Read-only mode: restrict to read tools only (for research/investigation tasks) */
  readOnly?: boolean;
  /** Model ID override (e.g. "claude-opus-4-6", "claude-sonnet-4-6") */
  model?: string;
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

/** Structured activity event from agent */
export interface AgentActivity {
  /** Event kind: tool_use, text (agent reasoning), result (final output) */
  kind: "tool" | "text" | "result";
  tool?: string;
  /** Brief summary of what's happening */
  summary: string;
  timestamp: string;
}

// --- Unified Job Queue ---

export type JobType = "enrich" | "review";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobBase {
  id: string;
  type: JobType;
  status: JobStatus;
  taskId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface EnrichJob extends JobBase {
  type: "enrich";
}

export interface ReviewJob extends JobBase {
  type: "review";
  /** Diff range for the review */
  diffRange?: string;
  /** Builder's self-assessment (RETRO_JSON) */
  retroJson?: string;
  /** Pre-merge commit hash */
  preMergeHash?: string;
}
