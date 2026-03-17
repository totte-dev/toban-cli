/**
 * Shared LLM client utilities — Claude CLI spawn and auth headers.
 */
import { spawn } from "node:child_process";
import * as ui from "./ui.js";

export interface ClaudeCliOptions {
  systemPrompt: string;
  history: Array<{ role: string; content: string }>;
  userMessage: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Spawn Claude CLI with --print and return the response text.
 * Handles timeout, ENOENT, and non-zero exit codes.
 */
export function callClaudeCli(opts: ClaudeCliOptions): Promise<string> {
  return callClaudeCliStream({ ...opts });
}

export interface ClaudeCliStreamOptions extends ClaudeCliOptions {
  /** Called with each text chunk as it arrives from stdout */
  onChunk?: (chunk: string) => void;
  /** Working directory for the Claude CLI process */
  cwd?: string;
  /** Enable tool access with --dangerously-skip-permissions */
  enableTools?: boolean;
  /** Restrict to specific tools (requires enableTools) */
  allowedTools?: string[];
}

/**
 * Spawn Claude CLI with --print and stream output via onChunk callback.
 * Returns the full response text on completion.
 */
export function callClaudeCliStream(opts: ClaudeCliStreamOptions): Promise<string> {
  const { systemPrompt, history, userMessage, model, timeoutMs = 300_000, onChunk, cwd, enableTools, allowedTools } = opts;

  const contextLines = history.slice(-6).map((m) => {
    const label = m.role === "user" ? "User" : "Manager";
    return `${label}: ${m.content}`;
  });

  const fullPrompt = contextLines.length > 0
    ? `Recent conversation:\n${contextLines.join("\n")}\n\nUser: ${userMessage}`
    : userMessage;

  const env = { ...process.env };
  delete env.CLAUDECODE;

  // When using --allowedTools (variadic flag), the prompt positional arg
  // gets consumed as part of the tools list. Use stdin (-p -) to avoid this.
  const useStdin = enableTools && allowedTools?.length;

  const args = [
    "--print",
    "--system-prompt", systemPrompt,
    "--model", model,
  ];
  if (enableTools) {
    args.push("--dangerously-skip-permissions");
    if (allowedTools?.length) {
      args.push("--allowedTools", allowedTools.join(","));
    }
  }
  if (useStdin) {
    args.push("-p", "-"); // read prompt from stdin
  } else {
    args.push(fullPrompt);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, {
      env,
      detached: true,
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });

    // Write prompt to stdin when using -p -
    if (useStdin && child.stdin) {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (onChunk && text) onChunk(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error("Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
      } else {
        reject(new Error(`Claude CLI error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr.trim()) {
        ui.debug("llm", `Claude CLI stderr: ${stderr.trim().slice(0, 300)}`);
      }
      if (code === 0) {
        if (!stdout.trim()) {
          ui.warn(`[llm] Claude CLI returned empty response (stderr: ${stderr.trim().slice(0, 200) || "none"})`);
        }
        resolve(stdout.trim() || "(no response)");
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Create standard auth headers for API requests.
 */
export function createAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

// ---------------------------------------------------------------------------
// Shared conversation history builder
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  from: string;
  content: string;
  id?: string;
  created_at?: string;
}

/**
 * Build OpenAI-compatible conversation history from raw messages.
 * Merges consecutive same-role messages, ensures user-first ordering.
 */
export function buildConversationHistory(
  messages: ConversationMessage[],
  opts?: { maxTurns?: number; upToId?: string }
): Array<{ role: "user" | "assistant"; content: string }> {
  const maxTurns = opts?.maxTurns ?? 20;

  let relevant = messages;
  if (opts?.upToId) {
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at ?? "").getTime() - new Date(b.created_at ?? "").getTime()
    );
    const upToIdx = sorted.findIndex((m) => m.id === opts.upToId);
    relevant = upToIdx === -1 ? sorted.slice(-maxTurns) : sorted.slice(Math.max(0, upToIdx - maxTurns + 1), upToIdx + 1);
  }

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of relevant) {
    const role: "user" | "assistant" =
      (msg.from === "user" || msg.from.startsWith("user:")) ? "user" : "assistant";
    if (history.length > 0 && history[history.length - 1].role === role) {
      history[history.length - 1].content += "\n" + msg.content;
    } else {
      history.push({ role, content: msg.content });
    }
  }

  // OpenAI-compatible APIs require starting with "user"
  while (history.length > 0 && history[0].role !== "user") {
    history.shift();
  }

  if (history.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    history.push({ role: "user", content: last.content });
  }

  return opts?.upToId ? history : history.slice(-maxTurns);
}
