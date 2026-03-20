/**
 * Utility for spawning a single-shot `claude --print` process.
 * Consolidates the spawn + stdout collect + timeout + resolved-flag pattern.
 */

import { spawn } from "node:child_process";
import { resolveModelForRole } from "../agent-engine.js";

export interface SpawnClaudeOptions {
  model?: string;
  role?: string;
  maxTurns?: number;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Spawn `claude --print` with the given prompt and collect stdout.
 * Handles the CLAUDECODE env deletion, timeout, and resolved-flag guard.
 */
export function spawnClaudeOnce(prompt: string, opts: SpawnClaudeOptions = {}): Promise<string> {
  const model = opts.model ?? (opts.role ? resolveModelForRole(opts.role) : resolveModelForRole("reviewer"));
  const maxTurns = opts.maxTurns ?? 5;
  const timeout = opts.timeout ?? 300_000;

  const env: Record<string, string | undefined> = opts.env ?? { ...process.env };
  delete env.CLAUDECODE;

  return new Promise<string>((resolve) => {
    const child = spawn("claude", [
      "--print", "--model", model, "--max-turns", String(maxTurns), prompt,
    ], {
      env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], timeout,
    });

    let out = "";
    let resolved = false;

    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", () => {}); // consume stderr

    child.on("close", () => {
      if (!resolved) { resolved = true; resolve(out); }
    });
    child.on("error", () => {
      if (!resolved) { resolved = true; resolve(out || ""); }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch {}
        resolve(out || "");
      }
    }, timeout);
  });
}
