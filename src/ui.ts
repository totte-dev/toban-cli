/**
 * Rich CLI output using @clack/prompts.
 *
 * Provides a structured UI for the toban-cli startup sequence and agent lifecycle.
 * All console.log/warn calls in cli.ts should go through this module.
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

export function isDebug(): boolean {
  return _debug;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Log a chat/message exchange between agents/users.
 * Normal mode: compact single line with timestamp
 * Debug mode: timestamped, full content preserved
 */
export function chatMessage(from: string, to: string, content: string): void {
  if (_debug) {
    const indent = content.split("\n").map(l => `    ${l}`).join("\n");
    console.log(`[${timestamp()}] [chat] ${from} → ${to}:\n${indent}`);
  } else {
    const oneLine = content.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const cols = process.stdout.columns ?? 80;
    const maxLen = Math.max(40, cols - 30);
    const truncated = oneLine.length > maxLen ? oneLine.slice(0, maxLen - 3) + "..." : oneLine;
    const symbol = from.startsWith("user") ? "◇" : "◆";
    const shortFrom = from.startsWith("user:") ? "user" : from;
    console.log(`${color.dim(timestamp())} ${symbol} ${color.bold(shortFrom)}→${to}: ${truncated}`);
  }
}

/**
 * Log a message exchange pair (inbound → reply) on two lines.
 * Format: (from → to)[transport]: content
 */
export function chatExchange(
  from: string,
  inbound: string,
  reply: string,
  actionCount: number,
  transport: "ws" | "api" = "api"
): void {
  if (_debug) {
    chatMessage(from, "manager", inbound);
    chatMessage("manager", from, reply);
    return;
  }
  const ts = timestamp();
  const shortFrom = from.startsWith("user:") ? from : from;
  const tColor = transport === "ws" ? color.green(`[${transport}]`) : color.dim(`[${transport}]`);
  const actionSuffix = actionCount > 0
    ? color.cyan(` [${actionCount} action${actionCount > 1 ? "s" : ""}]`)
    : "";
  console.log(
    `${color.dim(ts)} (${shortFrom} → manager)${tColor}: ${inbound}\n` +
    `${color.dim(ts)} (manager → ${shortFrom})${tColor}: ${reply}${actionSuffix}`
  );
}

function truncateLine(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 3) + "..." : oneLine;
}

/**
 * Debug-only log. Only outputs in debug mode.
 */
export function debug(category: string, message: string): void {
  if (_debug) {
    console.log(`[${timestamp()}] [${category}] ${message}`);
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

/** Log a success step (e.g. authentication, Docker detection) */
export function step(message: string): void {
  p.log.success(message);
}

/** Log an info message */
export function info(message: string): void {
  p.log.info(message);
}

/** Log a warning */
export function warn(message: string): void {
  p.log.warn(color.yellow(message));
}

/** Log an error */
export function error(message: string): void {
  p.log.error(color.red(message));
}

/** Log a plain message */
export function message(text: string): void {
  p.log.message(text);
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
    p.log.info(`Repo: ${repoPath}${suffix}`);
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
  p.log.step(lines.join("\n"));
}

/** Show task completion status */
export function taskResult(taskId: string, title: string, status: "completed" | "failed" | "skipped", detail?: string): void {
  const statusLabel =
    status === "completed" ? color.green("completed") :
    status === "failed" ? color.red("failed") :
    color.yellow("skipped");

  const line = `Task ${color.dim(taskId.slice(0, 8))} ${statusLabel}: ${title}`;

  if (status === "failed") {
    p.log.error(line + (detail ? `\n  ${color.dim(detail)}` : ""));
  } else {
    p.log.success(line);
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
