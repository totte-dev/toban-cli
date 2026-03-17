import type { AgentConfig } from "./types.js";

export interface CommandSpec {
  cmd: string;
  args: string[];
}

/** Tools allowed in read-only mode */
const READ_ONLY_TOOLS = "Read,Grep,Glob,Bash,Agent";

/**
 * Build a mock agent command that simulates work without calling an LLM.
 * Creates a small file, commits it, and outputs a retro comment.
 * Token cost: zero.
 */
function buildMockCommand(config: AgentConfig): CommandSpec {
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

  return {
    cmd: "bash",
    args: ["-c", script],
  };
}

/**
 * Build the command and args for a given agent config.
 * If commandTemplate is set (from provider config), it takes precedence.
 */
export function buildCommand(config: AgentConfig): CommandSpec {
  // If a command template is provided, parse it and append prompt/flags
  if (config.commandTemplate) {
    const parts = config.commandTemplate.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const templateArgs = parts.slice(1);

    // Detect the CLI type from the command name for proper prompt passing
    const cmdBase = cmd.split("/").pop() ?? cmd;
    if (cmdBase === "claude") {
      return {
        cmd,
        args: [
          ...templateArgs,
          "--dangerously-skip-permissions",
          "--print",
          "--output-format", "stream-json",
          ...(config.readOnly ? ["--allowedTools", READ_ONLY_TOOLS] : []),
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
          "-y",
          ...(config.prompt ? ["-p", config.prompt] : []),
        ],
      };
    } else {
      // Generic: pass template args + prompt as positional
      return {
        cmd,
        args: [
          ...templateArgs,
          ...(config.prompt ? [config.prompt] : []),
        ],
      };
    }
  }

  // Legacy fallback: use type-based switching
  switch (config.type) {
    case "claude":
      return {
        cmd: "claude",
        args: [
          "--dangerously-skip-permissions",
          "--print",
          "--output-format", "stream-json",
          ...(config.readOnly ? ["--allowedTools", READ_ONLY_TOOLS] : []),
          ...(config.prompt ? [config.prompt] : []),
        ],
      };

    case "cursor":
      return {
        cmd: "cursor",
        args: ["--wait", ...(config.args ?? [])],
      };

    case "codex":
      return {
        cmd: "codex",
        args: [
          "--quiet",
          ...(config.prompt ? ["--prompt", config.prompt] : []),
          ...(config.args ?? []),
        ],
      };

    case "gemini":
      return {
        cmd: "gemini",
        args: [
          "-y",
          ...(config.prompt ? ["-p", config.prompt] : []),
          ...(config.args ?? []),
        ],
      };

    case "mock":
      return buildMockCommand(config);

    case "custom":
      if (!config.command) {
        throw new Error("Custom agent type requires a command");
      }
      return {
        cmd: config.command,
        args: config.args ?? [],
      };

    default:
      throw new Error(`Unknown agent type: ${config.type}`);
  }
}
