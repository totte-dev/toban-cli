/**
 * CLI output module for toban-cli.
 *
 * Unified format: all output uses "  HH:MM:SS  message" with blank lines between entries.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
})();

// ---------------------------------------------------------------------------
// Debug mode
// ---------------------------------------------------------------------------

let _debug = false;

export function setDebug(enabled: boolean): void {
  _debug = enabled;
}

function isDebug(): boolean {
  return _debug;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

// ---------------------------------------------------------------------------
// Core log — unified format: "  HH:MM:SS  message" with blank line after
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`\n  ${color.dim(timestamp())}  ${msg}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a chat message between agents/users.
 */
export function chatMessage(from: string, to: string, content: string): void {
  if (_debug) {
    const indent = content.split("\n").map(l => `              ${l}`).join("\n");
    log(`[chat] ${from} → ${to}:\n${indent}`);
  } else {
    const oneLine = content.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const cols = process.stdout.columns ?? 80;
    const maxLen = Math.max(40, cols - 30);
    const truncated = oneLine.length > maxLen ? oneLine.slice(0, maxLen - 3) + "..." : oneLine;
    const symbol = from.startsWith("user") ? "◇" : "◆";
    const shortFrom = from.startsWith("user:") ? "user" : from;
    log(`${symbol} ${color.bold(shortFrom)}→${to}: ${truncated}`);
  }
}

/**
 * Debug-only log. Only outputs in debug mode.
 */
export function debug(category: string, message: string): void {
  if (_debug) {
    log(`[${category}] ${message}`);
  }
}

/** Show the intro banner */
export function intro(): void {
  p.intro(color.bgCyan(color.black(` toban-cli v${VERSION} `)));
}

/** Show the outro message */
export function outro(message: string): void {
  p.outro(message);
}

/** Log a success step */
export function step(message: string): void {
  log(`${color.green("✓")} ${message}`);
}

/** Log an info message */
export function info(message: string): void {
  log(`${color.blue("ℹ")} ${message}`);
}

/** Log a warning */
export function warn(message: string): void {
  log(`${color.yellow("⚠")} ${color.yellow(message)}`);
}

/** Log an error */
export function error(message: string): void {
  log(`${color.red("✖")} ${color.red(message)}`);
}

/** Show connection / config details in a note box */
export function connectionInfo(opts: {
  apiUrl: string;
  agent: string;
  branch: string;
  docker: boolean;
  wsPort?: number;
  llmProvider?: string;
}): void {
  const lines = [
    `${color.dim("API:")}      ${opts.apiUrl}`,
    `${color.dim("Agent:")}    ${opts.agent}`,
    `${color.dim("Branch:")}   ${opts.branch}`,
    `${color.dim("Docker:")}   ${opts.docker ? color.green("enabled") : color.yellow("disabled")}`,
  ];
  if (opts.wsPort) {
    lines.push(`${color.dim("WS:")}      ws://127.0.0.1:${opts.wsPort}`);
  }
  if (opts.llmProvider) {
    lines.push(`${color.dim("LLM:")}     ${opts.llmProvider}`);
  }
  p.note(lines.join("\n"), "Configuration");
}

/** Show workspace/repo info */
export function workspaceInfo(name?: string, repoPath?: string, autoCloned?: boolean): void {
  if (name) {
    step(`Workspace: ${color.bold(name)}`);
  }
  if (repoPath) {
    const suffix = autoCloned ? color.dim(" (auto-cloned)") : "";
    info(`Repo: ${repoPath}${suffix}`);
  }
}

/** Create and return a spinner */
export function createSpinner(): ReturnType<typeof p.spinner> {
  return p.spinner();
}

/** Show agent spawn info */
export function agentSpawned(opts: {
  agentName: string;
  taskId: string;
  taskTitle: string;
  repo?: string;
  container?: string;
  docker: boolean;
}): void {
  const mode = opts.docker ? color.dim("(container)") : color.dim("(host)");
  const lines = [
    `${color.cyan("●")} ${color.bold(opts.agentName)} ${mode}`,
    `  task: ${opts.taskTitle}`,
  ];
  if (opts.repo) {
    lines.push(`  repo: ${opts.repo}`);
  }
  if (opts.container) {
    lines.push(`  container: ${color.dim(opts.container)}`);
  }
  step(lines.join("\n"));
}

/** Show task completion status */
export function taskResult(taskId: string, title: string, status: "completed" | "failed" | "skipped", detail?: string): void {
  const statusLabel =
    status === "completed" ? color.green("completed") :
    status === "failed" ? color.red("failed") :
    color.yellow("skipped");

  const line = `Task ${color.dim(taskId.slice(0, 8))} ${statusLabel}: ${title}`;

  if (status === "failed") {
    error(line + (detail ? `\n  ${color.dim(detail)}` : ""));
  } else {
    step(line);
  }
}

/** Show sprint info */
export function sprintInfo(number: number, agentCount: number, taskCount: number): void {
  step(`Sprint ${color.bold(`#${number}`)} started — ${agentCount} agent(s), ${taskCount} task(s)`);
}

/** Show task list summary */
export function tasksSummary(count: number): void {
  if (count === 0) {
    info("No tasks to work on");
  } else {
    info(`${count} task(s) to process`);
  }
}

/** Show shutdown message */
export function shutdown(): void {
  p.outro(color.dim("Goodbye."));
}
