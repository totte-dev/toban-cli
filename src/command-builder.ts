import type { AgentConfig } from "./types.js";

export interface CommandSpec {
  cmd: string;
  args: string[];
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
          ...(config.prompt ? [config.prompt] : []),
          ...(config.args ?? []),
        ],
      };

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
