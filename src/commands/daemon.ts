/**
 * Daemon management for `toban start` / `toban stop`.
 *
 * `toban start` spawns a detached child process running in --foreground mode.
 * PID is saved to ~/.toban/runner.pid. `toban stop` reads it and sends SIGTERM.
 * `toban status` checks if the process is alive.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function pidFilePath(): string {
  const dir = join(homedir(), ".toban");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "runner.pid");
}

function logFilePath(): string {
  const dir = join(homedir(), ".toban", "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "runner.log");
}

/** Check if a runner process is alive. Returns PID or null. */
export function getRunnerPid(): number | null {
  const pidFile = pidFilePath();
  if (!existsSync(pidFile)) return null;

  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not alive — clean up stale PID file
    try { unlinkSync(pidFile); } catch { /* */ }
    return null;
  }
}

/** Start the runner as a daemon process. */
export function startDaemon(originalArgs: string[]): void {
  const existingPid = getRunnerPid();
  if (existingPid) {
    console.log(`Runner already running (PID ${existingPid}). Use \`toban stop\` first.`);
    return;
  }

  // Rebuild args: replace 'start' with 'start --foreground'
  const args = originalArgs.slice(2).filter((a) => a !== "start");
  args.unshift("start", "--foreground");

  const logFile = logFilePath();
  const out = require("node:fs").openSync(logFile, "a");
  const err = require("node:fs").openSync(logFile, "a");

  const child = spawn(process.execPath, [originalArgs[1], ...args], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, TOBAN_FOREGROUND: "1" },
  });

  child.unref();

  if (child.pid) {
    writeFileSync(pidFilePath(), String(child.pid));
    console.log(`Runner started (PID ${child.pid}). Log: ${logFile}`);
    console.log(`Use \`toban status\` to monitor, \`toban stop\` to stop.`);
  } else {
    console.error("Failed to start runner.");
  }
}

/** Stop the runner daemon. */
export function stopRunner(): void {
  const pid = getRunnerPid();
  if (!pid) {
    console.log("No runner is running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Runner stopped (PID ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop runner (PID ${pid}): ${err}`);
  }

  try { unlinkSync(pidFilePath()); } catch { /* */ }
}
