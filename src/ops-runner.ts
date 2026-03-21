/**
 * Ops task runner — polls for due ops tasks and executes them.
 *
 * Ops tasks are independent of sprint lifecycle. They run on a schedule
 * (interval-based) or on-demand, and report results back to the API.
 */

import { createAuthHeaders, fetchWithRetry } from "./api-client.js";
import * as ui from "./ui.js";
import { execSync } from "node:child_process";

export interface OpsTask {
  id: string;
  title: string;
  description: string;
  owner: string;
  type: string;
  priority: string;
  category: "auto_check" | "manual";
  schedule: "interval" | "on_complete";
  interval_hours: number;
  status: string;
  next_run_at: string | null;
  enabled: number;
}

export interface OpsRunnerConfig {
  apiUrl: string;
  apiKey: string;
  /** Poll interval in ms (default: 60_000) */
  pollIntervalMs?: number;
}

export class OpsRunner {
  private apiUrl: string;
  private headers: Record<string, string>;
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Track tasks currently being executed to prevent double-runs */
  private executing = new Set<string>();

  constructor(config: OpsRunnerConfig) {
    this.apiUrl = config.apiUrl;
    this.headers = createAuthHeaders(config.apiKey);
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  /** Start the polling loop. Runs in background via setInterval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    ui.info("[ops] Ops runner started");

    // Run immediately, then on interval
    this.tick().catch((err) => ui.warn(`[ops] Poll error: ${err}`));
    this.timer = setInterval(() => {
      this.tick().catch((err) => ui.warn(`[ops] Poll error: ${err}`));
    }, this.pollIntervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    ui.info("[ops] Ops runner stopped");
  }

  /** Single poll + execute cycle. */
  async tick(): Promise<void> {
    const dueTasks = await this.fetchDueTasks();
    if (dueTasks.length === 0) return;

    ui.info(`[ops] ${dueTasks.length} ops task(s) due`);

    for (const task of dueTasks) {
      if (this.executing.has(task.id)) continue;
      this.executing.add(task.id);

      try {
        await this.executeTask(task);
      } finally {
        this.executing.delete(task.id);
      }
    }
  }

  /** Fetch ops tasks that are due for execution. */
  async fetchDueTasks(): Promise<OpsTask[]> {
    try {
      const res = await fetchWithRetry(
        `${this.apiUrl}/api/v1/ops-tasks/due`,
        { headers: this.headers },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data as OpsTask[] : [];
    } catch {
      return [];
    }
  }

  /** Execute a single ops task and report the result. */
  async executeTask(task: OpsTask): Promise<void> {
    ui.step(`[ops] Executing: ${task.title} (${task.id.slice(0, 8)})`);

    // Mark as running
    try {
      await fetchWithRetry(
        `${this.apiUrl}/api/v1/ops-tasks/${task.id}`,
        { method: "PATCH", headers: this.headers, body: JSON.stringify({ status: "running" }) },
      );
    } catch { /* non-fatal */ }

    let passed = false;
    let summary = "";
    let details = "";

    try {
      const result = this.runTask(task);
      passed = result.passed;
      summary = result.summary;
      details = result.details;
    } catch (err) {
      passed = false;
      summary = "Execution error";
      details = err instanceof Error ? err.message : String(err);
    }

    // Report result
    try {
      await fetchWithRetry(
        `${this.apiUrl}/api/v1/ops-tasks/${task.id}/result`,
        {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ passed, summary, details }),
        },
      );
      ui.info(`[ops] ${task.title}: ${passed ? "PASS" : "FAIL"} — ${summary}`);
    } catch (err) {
      ui.warn(`[ops] Failed to report result for ${task.id.slice(0, 8)}: ${err}`);
    }
  }

  /**
   * Run an ops task. Supports two modes:
   * 1. Healthcheck URL: description starts with "http://" or "https://"
   * 2. Shell command: description is executed as a shell command
   */
  runTask(task: OpsTask): { passed: boolean; summary: string; details: string } {
    const desc = (task.description || "").trim();

    // Healthcheck URL
    if (desc.startsWith("http://") || desc.startsWith("https://")) {
      return this.runHealthcheck(desc);
    }

    // Shell command
    if (desc.length > 0) {
      return this.runShellCommand(desc);
    }

    return { passed: false, summary: "No action defined", details: "Task description is empty — set a URL or shell command." };
  }

  /** Run a healthcheck against a URL (synchronous fetch via curl). */
  private runHealthcheck(url: string): { passed: boolean; summary: string; details: string } {
    try {
      const output = execSync(`curl -sf -o /dev/null -w "%{http_code}" "${url}"`, {
        encoding: "utf-8",
        timeout: 30_000,
      }).trim();
      const code = parseInt(output, 10);
      const passed = code >= 200 && code < 400;
      return {
        passed,
        summary: `HTTP ${code}`,
        details: `GET ${url} returned ${code}`,
      };
    } catch (err) {
      return {
        passed: false,
        summary: "Healthcheck failed",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Run a shell command and capture output. */
  private runShellCommand(command: string): { passed: boolean; summary: string; details: string } {
    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        passed: true,
        summary: "Command succeeded",
        details: output.slice(0, 4000),
      };
    } catch (err: unknown) {
      const exitCode = (err as { status?: number }).status ?? 1;
      const stderr = (err as { stderr?: string }).stderr ?? "";
      const stdout = (err as { stdout?: string }).stdout ?? "";
      return {
        passed: false,
        summary: `Exit code ${exitCode}`,
        details: (stderr || stdout).slice(0, 4000),
      };
    }
  }
}
