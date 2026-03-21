/**
 * Ops task runner — polls for due ops tasks and executes them.
 *
 * Ops tasks are independent of sprint lifecycle. They run on a schedule
 * (interval-based) or on-demand, and report results back to the API.
 */

import { createAuthHeaders, fetchWithRetry } from "./api-client.js";
import type { Task } from "./api-client.js";
import * as ui from "./ui.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** QA scan configuration parsed from ops task description JSON */
export interface QaScanConfig {
  type: "qa_scan";
  repo_dir?: string;
  commands?: { build?: string; test?: string };
  health_urls?: string[];
  error_log?: string;
}

interface QaScanIssue {
  check: string;
  detail: string;
}

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

    // Check for qa_scan type
    const desc = (task.description || "").trim();
    if (desc.startsWith("{")) {
      try {
        const config = JSON.parse(desc) as QaScanConfig;
        if (config.type === "qa_scan") {
          await this.runQaScan(task, config);
          return;
        }
      } catch { /* not JSON, fall through to normal execution */ }
    }

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
   * Run an ops task. Supports three modes:
   * 1. QA scan: description is JSON with type:"qa_scan"
   * 2. Healthcheck URL: description starts with "http://" or "https://"
   * 3. Shell command: description is executed as a shell command
   */
  runTask(task: OpsTask): { passed: boolean; summary: string; details: string } {
    const desc = (task.description || "").trim();

    // QA scan (JSON with type field)
    if (desc.startsWith("{")) {
      try {
        const config = JSON.parse(desc) as QaScanConfig;
        if (config.type === "qa_scan") {
          // qa_scan is async — return placeholder, actual execution in executeTask
          return { passed: true, summary: "qa_scan delegated", details: "" };
        }
      } catch { /* not JSON, fall through */ }
    }

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

  // ---------------------------------------------------------------------------
  // QA Scan
  // ---------------------------------------------------------------------------

  /** Run a QA scan: build, test, error log check, health URLs. Create bug tasks for failures. */
  async runQaScan(task: OpsTask, config: QaScanConfig): Promise<void> {
    const repoDir = config.repo_dir || process.cwd();
    const buildCmd = config.commands?.build || "npm run build";
    const testCmd = config.commands?.test || "npm test";
    const issues: QaScanIssue[] = [];
    const timeout = 180_000;

    // 1. Build check
    ui.info(`[qa] Build check: ${buildCmd}`);
    try {
      execSync(buildCmd, { cwd: repoDir, stdio: "pipe", timeout });
      ui.info("[qa] Build: PASS");
    } catch (err) {
      const detail = this.getExecError(err);
      issues.push({ check: "build", detail: detail.slice(0, 1000) });
      ui.warn(`[qa] Build: FAIL — ${detail.slice(0, 200)}`);
    }

    // 2. Test check
    ui.info(`[qa] Test check: ${testCmd}`);
    try {
      execSync(testCmd, { cwd: repoDir, stdio: "pipe", timeout });
      ui.info("[qa] Tests: PASS");
    } catch (err) {
      const detail = this.getExecError(err);
      issues.push({ check: "test", detail: detail.slice(0, 1000) });
      ui.warn(`[qa] Tests: FAIL — ${detail.slice(0, 200)}`);
    }

    // 3. Error log check
    const errorLogPath = config.error_log || `${repoDir}/.toban/logs/error.log`;
    if (existsSync(errorLogPath)) {
      try {
        const content = readFileSync(errorLogPath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        // Check last 10 entries for recent errors (within 24h)
        const recentLines = lines.slice(-10);
        const now = Date.now();
        const recentErrors = recentLines.filter((line) => {
          try {
            const entry = JSON.parse(line);
            const ts = new Date(entry.timestamp || entry.ts || 0).getTime();
            return now - ts < 24 * 60 * 60 * 1000;
          } catch { return false; }
        });
        if (recentErrors.length > 0) {
          issues.push({ check: "error_log", detail: `${recentErrors.length} recent error(s) in ${errorLogPath}\n${recentErrors.slice(0, 3).join("\n")}` });
          ui.warn(`[qa] Error log: ${recentErrors.length} recent error(s)`);
        } else {
          ui.info("[qa] Error log: clean");
        }
      } catch { ui.info("[qa] Error log: could not read"); }
    }

    // 4. Health URL checks
    if (config.health_urls?.length) {
      for (const url of config.health_urls) {
        const result = this.runHealthcheck(url);
        if (!result.passed) {
          issues.push({ check: "health", detail: `${url}: ${result.summary}` });
          ui.warn(`[qa] Health ${url}: FAIL`);
        } else {
          ui.info(`[qa] Health ${url}: OK`);
        }
      }
    }

    // Create bug tasks for issues (with dedup)
    if (issues.length > 0) {
      await this.createBugTasks(issues);
    }

    // Report result
    const passed = issues.length === 0;
    const summary = passed
      ? "All QA checks passed"
      : `${issues.length} issue(s): ${issues.map((i) => i.check).join(", ")}`;
    const details = JSON.stringify({ issues, timestamp: new Date().toISOString() });

    try {
      await fetchWithRetry(
        `${this.apiUrl}/api/v1/ops-tasks/${task.id}/result`,
        {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ passed, summary, details }),
        },
      );
      ui.info(`[qa] Scan complete: ${summary}`);
    } catch (err) {
      ui.warn(`[qa] Failed to report scan result: ${err}`);
    }
  }

  /** Create bug tasks for QA issues, deduplicating against existing open tasks. */
  private async createBugTasks(issues: QaScanIssue[]): Promise<void> {
    // Fetch existing open tasks to avoid duplicates
    let existingTitles: Set<string>;
    try {
      const res = await fetchWithRetry(
        `${this.apiUrl}/api/v1/tasks?status=todo,in_progress,review,blocked`,
        { headers: this.headers },
      );
      if (res.ok) {
        const data = await res.json() as { tasks?: Task[] } | Task[];
        const tasks = Array.isArray(data) ? data : (data.tasks ?? []);
        existingTitles = new Set(tasks.map((t: Task) => t.title.toLowerCase()));
      } else {
        existingTitles = new Set();
      }
    } catch {
      existingTitles = new Set();
    }

    for (const issue of issues) {
      const title = `[QA] ${issue.check} failure detected`;
      if (existingTitles.has(title.toLowerCase())) {
        ui.info(`[qa] Skipping duplicate: ${title}`);
        continue;
      }

      try {
        await fetchWithRetry(
          `${this.apiUrl}/api/v1/tasks`,
          {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({
              title,
              description: issue.detail.slice(0, 2000),
              type: "bug",
              priority: issue.check === "build" ? "p0" : "p1",
              owner: "user",
              sprint: -1,
            }),
          },
        );
        existingTitles.add(title.toLowerCase());
        ui.info(`[qa] Created bug task: ${title}`);
      } catch (err) {
        ui.warn(`[qa] Failed to create bug task: ${err}`);
      }
    }
  }

  /** Extract useful error output from execSync failures. */
  private getExecError(err: unknown): string {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString();
    return (stderr?.trim() || stdout?.trim() || e.message || String(err));
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
