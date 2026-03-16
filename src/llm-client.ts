/**
 * Shared LLM client utilities — Claude CLI spawn and auth headers.
 */
import { spawn } from "node:child_process";

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
  const { systemPrompt, history, userMessage, model, timeoutMs = 180_000 } = opts;

  const contextLines = history.slice(-6).map((m) => {
    const label = m.role === "user" ? "User" : "Manager";
    return `${label}: ${m.content}`;
  });

  const fullPrompt = contextLines.length > 0
    ? `Recent conversation:\n${contextLines.join("\n")}\n\nUser: ${userMessage}`
    : userMessage;

  const env = { ...process.env };
  delete env.CLAUDECODE;

  return new Promise<string>((resolve, reject) => {
    const child = spawn("claude", [
      "--print",
      "--system-prompt", systemPrompt,
      "--model", model,
      fullPrompt,
    ], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

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
      if (code === 0) {
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
