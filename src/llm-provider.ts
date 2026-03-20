/**
 * LLM Provider abstraction — decouples Manager from specific LLM backends.
 *
 * Each provider implements the LlmProvider interface, handling CLI spawning
 * or API calls specific to its engine. The Manager calls provider.call()
 * without knowing the underlying implementation.
 *
 * Currently supported:
 * - ClaudeCliProvider: Claude Code CLI with tool access and streaming
 * - OpenAiApiProvider: OpenAI-compatible chat completions API
 */

import { spawn } from "node:child_process";
import { summarizeToolInput } from "./agent-engine.js";
import * as ui from "./ui.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface LlmCallOptions {
  systemPrompt: string;
  history: Array<{ role: string; content: string }>;
  userMessage: string;
  model: string;
  timeoutMs?: number;
  /** Called with each text chunk for streaming */
  onChunk?: (chunk: string) => void;
  /** Called when the LLM executes a tool (Read, Grep, etc.) */
  onToolUse?: (tool: string, summary: string) => void;
  /** Working directory for CLI-based providers */
  cwd?: string;
  /** Enable tool access (provider-specific) */
  enableTools?: boolean;
  /** Tool restriction list (provider-specific) */
  allowedTools?: string[];
}

export interface LlmProvider {
  /** Provider identifier */
  readonly id: string;
  /** Call the LLM and return the full response text */
  call(opts: LlmCallOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Claude Code CLI Provider
// ---------------------------------------------------------------------------

export class ClaudeCliProvider implements LlmProvider {
  readonly id = "claude-cli";

  async call(opts: LlmCallOptions): Promise<string> {
    const { systemPrompt, history, userMessage, model, timeoutMs = 300_000, onChunk, onToolUse, cwd, enableTools, allowedTools } = opts;

    const contextLines = history.slice(-6).map((m) => {
      const label = m.role === "user" ? "User" : "Manager";
      return `${label}: ${m.content}`;
    });

    const fullPrompt = contextLines.length > 0
      ? `Recent conversation:\n${contextLines.join("\n")}\n\nUser: ${userMessage}`
      : userMessage;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Use stream-json when tools are enabled (allows parsing tool_use events)
    const useStreamJson = !!enableTools;

    const args = [
      "--print",
      "--system-prompt", systemPrompt,
      "--model", model,
    ];

    if (useStreamJson) {
      args.push("--verbose", "--output-format", "stream-json");
    }

    if (enableTools) {
      args.push("--permission-mode", "plan");
      if (allowedTools?.length) {
        args.push("--allowedTools", allowedTools.join(","));
      }
    }

    // When using --allowedTools (variadic flag), use stdin to pass prompt
    const useStdin = enableTools && allowedTools?.length;
    if (useStdin) {
      args.push("-p", "-");
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

      if (useStdin && child.stdin) {
        child.stdin.write(fullPrompt);
        child.stdin.end();
      }

      let stdout = "";
      let stderr = "";
      let resultText = "";
      let stdoutBuffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const raw = chunk.toString();
        stdout += raw;

        if (useStreamJson) {
          // Parse stream-json JSONL for tool_use events and text
          stdoutBuffer += raw;
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;

              // Extract tool_use events
              if (event.type === "content_block_start") {
                const block = event.content_block as Record<string, unknown> | undefined;
                if (block?.type === "tool_use" && typeof block.name === "string") {
                  onToolUse?.(block.name, summarizeToolInput(block.name, block.input as Record<string, unknown>));
                }
              }
              if (event.type === "assistant") {
                const content = (event.message as Record<string, unknown>)?.content;
                if (Array.isArray(content)) {
                  for (const b of content) {
                    if (b.type === "tool_use" && typeof b.name === "string") {
                      onToolUse?.(b.name, summarizeTool(b.name, b.input as Record<string, unknown>));
                    }
                    if (b.type === "text" && typeof b.text === "string") {
                      onChunk?.(b.text);
                    }
                  }
                }
              }

              // Capture final result
              if (event.type === "result" && typeof event.result === "string") {
                resultText = event.result;
                onChunk?.(event.result);
              }
            } catch {
              // Not valid JSON in stream-json mode — skip (do not send to chat)
            }
          }
        } else {
          if (onChunk && raw) onChunk(raw);
        }
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
          // stream-json: use parsed resultText; plain: use raw stdout
          const response = useStreamJson ? (resultText || stdout.trim()) : stdout.trim();
          if (!response) {
            ui.warn(`[llm] Claude CLI returned empty response (stderr: ${stderr.trim().slice(0, 200) || "none"})`);
          }
          resolve(response || "(no response)");
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API Provider
// ---------------------------------------------------------------------------

export class OpenAiApiProvider implements LlmProvider {
  readonly id = "openai-api";

  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async call(opts: LlmCallOptions): Promise<string> {
    const { systemPrompt, history, userMessage, model } = opts;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history,
      { role: "user" as const, content: userMessage },
    ];

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "(no response)";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate LLM provider based on configuration.
 * If llmBaseUrl + llmApiKey are provided, uses OpenAI-compatible API.
 * Otherwise, defaults to Claude Code CLI.
 */
export function createLlmProvider(opts: {
  llmBaseUrl?: string;
  llmApiKey?: string;
}): LlmProvider {
  if (opts.llmBaseUrl && opts.llmApiKey) {
    return new OpenAiApiProvider(opts.llmBaseUrl, opts.llmApiKey);
  }
  return new ClaudeCliProvider();
}
