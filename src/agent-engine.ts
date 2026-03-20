/**
 * Agent Engine Provider — abstracts engine-specific behavior for worker agents.
 *
 * Each engine (Claude, Codex, Gemini, etc.) has different:
 * - CLI commands and flags
 * - Output formats (stream-json vs plain text)
 * - Config file requirements
 * - Environment variable needs
 * - Docker auth mount paths
 *
 * Providers are registered in a registry and looked up by engine type.
 * New engines can be added by implementing AgentEngineProvider and registering.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentConfig, AgentType } from "./types.js";
import type { AgentActivity } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandSpec {
  cmd: string;
  args: string[];
}

export interface AgentEngineProvider {
  /** Engine identifier */
  readonly id: AgentType;

  /** Build the CLI command and args for spawning */
  buildCommand(config: AgentConfig): CommandSpec;

  /** Build command from a user-provided template string */
  buildFromTemplate?(templateArgs: string[], config: AgentConfig): CommandSpec;

  /** Whether this engine emits structured output (e.g. stream-json) */
  readonly supportsStructuredOutput: boolean;

  /** Parse a single stdout line into structured activity events (if supported) */
  parseOutputLine?(line: string): AgentActivity[];

  /** Extra prompt instructions specific to this engine (e.g. "read CLAUDE.md") */
  readonly promptHint?: string;

  /** Run any pre-spawn setup (e.g. ensure config files exist) */
  ensureConfig?(): void;

  /** Environment variable overrides for the agent process */
  prepareEnv?(env: Record<string, string | undefined>): void;

  /** Docker volume mounts for auth (returns ["-v", "src:dest"] pairs) */
  getDockerAuthMounts?(): string[];
}

// ---------------------------------------------------------------------------
// Engine → Model mapping
// ---------------------------------------------------------------------------

/** Map DB engine short names to Claude model IDs */
/** Map engine short names to Claude model IDs */
const ENGINE_MODEL_MAP: Record<string, string> = {
  "claude-opus": "claude-opus-4-6",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-haiku": "claude-haiku-4-5-20251001",
  // Legacy model names
  "claude-opus-4-20250514": "claude-opus-4-6",
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250514": "claude-sonnet-4-6",
};

/** Engine values that are provider types, not model selections — use role default */
const PROVIDER_ENGINE_IDS = new Set(["claude-code", "claude-api", "claude", "codex", "gemini", "cursor", "custom"]);

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Default model per agent role (can be overridden by DB engine setting) */
const ROLE_DEFAULT_MODEL: Record<string, string> = {
  builder: "claude-opus-4-6",
  reviewer: "claude-sonnet-4-6",
  strategist: "claude-sonnet-4-6",
  manager: "claude-sonnet-4-6",
  "cloud-engineer": "claude-opus-4-6",
};

/**
 * Resolve engine short name to full model ID.
 * Returns the model ID that can be passed to `claude --model`.
 */
export function resolveModel(engine?: string | null): string {
  if (!engine) return DEFAULT_MODEL;
  return ENGINE_MODEL_MAP[engine] ?? engine;
}

/**
 * Resolve model for a specific agent role.
 * Priority: DB engine setting (if it's a model name) > role default > global default.
 * Provider IDs (claude-code, claude-api, etc.) are ignored — use role default.
 */
export function resolveModelForRole(role: string, engine?: string | null): string {
  if (engine && !PROVIDER_ENGINE_IDS.has(engine)) {
    return resolveModel(engine);
  }
  return ROLE_DEFAULT_MODEL[role] ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Claude Engine
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = "Read,Grep,Glob,Bash,Agent";

const claudeEngine: AgentEngineProvider = {
  id: "claude",
  supportsStructuredOutput: true,
  promptHint: "CLAUDE.md is auto-loaded by the CLI. Focus on task-relevant files only.",

  buildCommand(config) {
    const model = config.model ? resolveModel(config.model) : DEFAULT_MODEL;
    return {
      cmd: "claude",
      args: [
        "--dangerously-skip-permissions",
        "--print",
        "--verbose",
        "--model", model,
        "--output-format", "stream-json",
        ...(config.readOnly ? ["--allowedTools", READ_ONLY_TOOLS] : []),
        ...(config.prompt ? [config.prompt] : []),
      ],
    };
  },

  buildFromTemplate(templateArgs, config) {
    const model = config.model ? resolveModel(config.model) : DEFAULT_MODEL;
    return {
      cmd: templateArgs[0] ?? "claude",
      args: [
        ...templateArgs.slice(1),
        "--dangerously-skip-permissions",
        "--print",
        "--verbose",
        "--model", model,
        "--output-format", "stream-json",
        ...(config.readOnly ? ["--allowedTools", READ_ONLY_TOOLS] : []),
        ...(config.prompt ? [config.prompt] : []),
      ],
    };
  },

  parseOutputLine(line: string): AgentActivity[] {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return parseStreamJsonEvents(event);
    } catch {
      return [{ kind: "text", summary: line, timestamp: new Date().toISOString() }];
    }
  },

  ensureConfig() {
    const configPath = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(configPath)) return;

    const backupDir = path.join(os.homedir(), ".claude", "backups");
    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir).filter(f => f.startsWith(".claude.json.backup."));
      if (backups.length > 0) {
        const latest = backups.sort().pop()!;
        fs.copyFileSync(path.join(backupDir, latest), configPath);
        return;
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({
      numStartups: 1,
      autoUpdates: false,
      hasCompletedOnboarding: true,
    }, null, 2));
  },

  prepareEnv(env) {
    delete env.CLAUDECODE;
  },

  getDockerAuthMounts() {
    const home = os.homedir();
    const mounts: string[] = [];
    const dirs = [
      [path.join(home, ".claude"), "/home/agent/.claude"],
      [path.join(home, ".claude.json"), "/home/agent/.claude.json"],
      [path.join(home, ".config", "claude"), "/home/agent/.config/claude"],
    ];
    for (const [src, dest] of dirs) {
      if (fs.existsSync(src)) {
        mounts.push("-v", `${src}:${dest}`);
      }
    }
    return mounts;
  },
};

// ---------------------------------------------------------------------------
// Codex Engine
// ---------------------------------------------------------------------------

const codexEngine: AgentEngineProvider = {
  id: "codex",
  supportsStructuredOutput: false,

  buildCommand(config) {
    return {
      cmd: "codex",
      args: [
        "--quiet",
        ...(config.prompt ? ["--prompt", config.prompt] : []),
        ...(config.args ?? []),
      ],
    };
  },

  buildFromTemplate(templateArgs, config) {
    return {
      cmd: templateArgs[0] ?? "codex",
      args: [
        ...templateArgs.slice(1),
        "--quiet",
        ...(config.prompt ? ["--prompt", config.prompt] : []),
      ],
    };
  },

  getDockerAuthMounts() {
    const home = os.homedir();
    const mounts: string[] = [];
    const codexDir = path.join(home, ".codex");
    if (fs.existsSync(codexDir)) mounts.push("-v", `${codexDir}:/home/agent/.codex:ro`);
    const openaiDir = path.join(home, ".config", "openai");
    if (fs.existsSync(openaiDir)) mounts.push("-v", `${openaiDir}:/home/agent/.config/openai:ro`);
    return mounts;
  },
};

// ---------------------------------------------------------------------------
// Gemini Engine
// ---------------------------------------------------------------------------

const geminiEngine: AgentEngineProvider = {
  id: "gemini",
  supportsStructuredOutput: false,

  buildCommand(config) {
    return {
      cmd: "gemini",
      args: [
        "-y",
        ...(config.prompt ? ["-p", config.prompt] : []),
        ...(config.args ?? []),
      ],
    };
  },

  buildFromTemplate(templateArgs, config) {
    return {
      cmd: templateArgs[0] ?? "gemini",
      args: [
        ...templateArgs.slice(1),
        "-y",
        ...(config.prompt ? ["-p", config.prompt] : []),
      ],
    };
  },

  getDockerAuthMounts() {
    const home = os.homedir();
    const mounts: string[] = [];
    const geminiDir = path.join(home, ".config", "gemini");
    if (fs.existsSync(geminiDir)) mounts.push("-v", `${geminiDir}:/home/agent/.config/gemini:ro`);
    return mounts;
  },
};

// ---------------------------------------------------------------------------
// Cursor Engine
// ---------------------------------------------------------------------------

const cursorEngine: AgentEngineProvider = {
  id: "cursor",
  supportsStructuredOutput: false,

  buildCommand(config) {
    return {
      cmd: "cursor",
      args: ["--wait", ...(config.args ?? [])],
    };
  },
};

// ---------------------------------------------------------------------------
// Mock Engine
// ---------------------------------------------------------------------------

const mockEngine: AgentEngineProvider = {
  id: "mock",
  supportsStructuredOutput: false,

  buildCommand(config) {
    const taskId = config.taskId.slice(0, 8);
    const name = config.name;
    const script = `
echo "[mock] Agent ${name} starting task ${taskId}..."
sleep 2
echo "[mock] Analyzing task requirements..."
sleep 1
echo "[mock] Implementing changes..."
mkdir -p .mock-output
echo "Mock output for task ${taskId} by ${name} at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > .mock-output/${taskId}.txt
git add .mock-output/${taskId}.txt 2>/dev/null
git commit -m "mock: simulated work for task ${taskId}" --allow-empty 2>/dev/null || true
echo "[mock] Changes committed."
sleep 1
echo "[mock] Task complete."
echo 'RETRO_JSON:{"went_well":"Mock agent completed successfully","to_improve":"This was a simulated run","suggested_tasks":[]}'
`.trim();

    return { cmd: "bash", args: ["-c", script] };
  },
};

// ---------------------------------------------------------------------------
// Custom Engine
// ---------------------------------------------------------------------------

const customEngine: AgentEngineProvider = {
  id: "custom",
  supportsStructuredOutput: false,

  buildCommand(config) {
    if (!config.command) throw new Error("Custom agent type requires a command");
    return { cmd: config.command, args: config.args ?? [] };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const engines = new Map<AgentType, AgentEngineProvider>([
  ["claude", claudeEngine],
  ["codex", codexEngine],
  ["gemini", geminiEngine],
  ["cursor", cursorEngine],
  ["mock", mockEngine],
  ["custom", customEngine],
]);

/**
 * Get the engine provider for a given agent type.
 */
export function getEngine(type: AgentType): AgentEngineProvider {
  const engine = engines.get(type);
  if (!engine) throw new Error(`Unknown agent engine: ${type}`);
  return engine;
}

/**
 * Build command for an agent, handling both template and type-based resolution.
 */
export function buildCommand(config: AgentConfig): CommandSpec {
  if (config.commandTemplate) {
    const parts = config.commandTemplate.split(/\s+/).filter(Boolean);
    const cmdBase = (parts[0] ?? "").split("/").pop() ?? parts[0];

    // Try to find a matching engine by command name
    for (const engine of engines.values()) {
      if (engine.id === cmdBase && engine.buildFromTemplate) {
        return engine.buildFromTemplate(parts, config);
      }
    }

    // Generic fallback for templates
    return {
      cmd: parts[0],
      args: [...parts.slice(1), ...(config.prompt ? [config.prompt] : [])],
    };
  }

  const engine = getEngine(config.type);
  return engine.buildCommand(config);
}

// ---------------------------------------------------------------------------
// Stream-JSON parsing (Claude-specific, used by claudeEngine.parseOutputLine)
// ---------------------------------------------------------------------------

function parseStreamJsonEvents(event: Record<string, unknown>): AgentActivity[] {
  const now = new Date().toISOString();
  const activities: AgentActivity[] = [];

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

  if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
    activities.push({ kind: "result", summary: event.result.trim(), timestamp: now });
  }

  return activities;
}

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

function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/**
 * Extract displayable text from a stream-json event (for retro extraction).
 */
export function extractTextFromStreamJson(event: Record<string, unknown>): string | null {
  if (event.type === "result" && typeof event.result === "string") return event.result;
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
