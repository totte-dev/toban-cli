import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpsRunner, type OpsTask, type QaScanConfig } from "../ops-runner.js";

const API_URL = "https://api.example.com";
const API_KEY = "test-key";

// Track all fetch calls
let fetchCalls: Array<{ url: string; method?: string; body?: string }> = [];

function makeOpsTask(config: QaScanConfig): OpsTask {
  return {
    id: "qa-1",
    title: "QA Scan",
    description: JSON.stringify(config),
    owner: "qa",
    type: "chore",
    priority: "p1",
    category: "auto_check",
    schedule: "interval",
    interval_hours: 4,
    status: "idle",
    next_run_at: null,
    enabled: 1,
  };
}

// Mock execSync
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// Mock fs
const existsSyncMock = vi.fn().mockReturnValue(false);
const readFileSyncMock = vi.fn().mockReturnValue("");
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

describe("OpsRunner QA Scan", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    execSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("");

    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      fetchCalls.push({ url, method: opts?.method, body: opts?.body as string });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tasks: [] }),
        text: () => Promise.resolve(""),
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("all checks pass — no bug tasks created", async () => {
    execSyncMock.mockReturnValue(Buffer.from("ok"));
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const task = makeOpsTask({ type: "qa_scan" });

    await runner.runQaScan(task, JSON.parse(task.description));

    // Build + test calls
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    // No POST to /tasks (no bugs)
    const taskCreates = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/v1/tasks"));
    expect(taskCreates).toHaveLength(0);
    // Result reported
    const resultPost = fetchCalls.find((c) => c.url.includes("/result"));
    expect(resultPost).toBeDefined();
    const result = JSON.parse(resultPost!.body!);
    expect(result.passed).toBe(true);
    expect(result.summary).toContain("All QA checks passed");
  });

  it("build failure creates p0 bug task", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("build")) {
        throw Object.assign(new Error("fail"), {
          stderr: Buffer.from("error TS2322: Type mismatch"),
          stdout: Buffer.from(""),
        });
      }
      return Buffer.from("ok");
    });
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const task = makeOpsTask({ type: "qa_scan" });

    await runner.runQaScan(task, JSON.parse(task.description));

    const taskCreates = fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/tasks"));
    expect(taskCreates).toHaveLength(1);
    const body = JSON.parse(taskCreates[0].body!);
    expect(body.title).toBe("[QA] build failure detected");
    expect(body.priority).toBe("p0");
    expect(body.type).toBe("bug");
    expect(body.description).toContain("TS2322");
  });

  it("test failure creates p1 bug task", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("test")) {
        throw Object.assign(new Error("fail"), {
          stderr: Buffer.from(""),
          stdout: Buffer.from("FAIL: expected 1 to be 2"),
        });
      }
      return Buffer.from("ok");
    });
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const task = makeOpsTask({ type: "qa_scan" });

    await runner.runQaScan(task, JSON.parse(task.description));

    const taskCreates = fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/tasks"));
    expect(taskCreates).toHaveLength(1);
    const body = JSON.parse(taskCreates[0].body!);
    expect(body.title).toBe("[QA] test failure detected");
    expect(body.priority).toBe("p1");
  });

  it("does not create duplicate bug tasks", async () => {
    // Simulate existing task with matching title
    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      fetchCalls.push({ url, method: opts?.method, body: opts?.body as string });
      // Return existing tasks with matching title on task list query
      if (url.includes("/api/v1/tasks") && !opts?.method) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ tasks: [{ id: "existing-1", title: "[QA] build failure detected", status: "todo" }] }),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });
    });

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("build")) {
        throw Object.assign(new Error("fail"), { stderr: Buffer.from("err"), stdout: Buffer.from("") });
      }
      return Buffer.from("ok");
    });

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const task = makeOpsTask({ type: "qa_scan" });

    await runner.runQaScan(task, JSON.parse(task.description));

    // Should NOT create a new task (duplicate)
    const taskCreates = fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/tasks"));
    expect(taskCreates).toHaveLength(0);
  });

  it("uses custom commands from config", async () => {
    execSyncMock.mockReturnValue(Buffer.from("ok"));
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const config: QaScanConfig = {
      type: "qa_scan",
      commands: { build: "cargo build", test: "cargo test" },
    };
    const task = makeOpsTask(config);

    await runner.runQaScan(task, config);

    expect(execSyncMock.mock.calls[0][0]).toBe("cargo build");
    expect(execSyncMock.mock.calls[1][0]).toBe("cargo test");
  });

  it("checks error log for recent entries", async () => {
    execSyncMock.mockReturnValue(Buffer.from("ok"));
    existsSyncMock.mockReturnValue(true);
    const recentEntry = JSON.stringify({ timestamp: new Date().toISOString(), code: "CLI_ERR_BUILD", message: "build failed" });
    readFileSyncMock.mockReturnValue(recentEntry);

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const config: QaScanConfig = { type: "qa_scan", error_log: "/tmp/error.log" };
    const task = makeOpsTask(config);

    await runner.runQaScan(task, config);

    // Should create a bug task for error log
    const taskCreates = fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/tasks"));
    expect(taskCreates).toHaveLength(1);
    const body = JSON.parse(taskCreates[0].body!);
    expect(body.title).toBe("[QA] error_log failure detected");
  });

  it("reports structured result with issues list", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("build")) {
        throw Object.assign(new Error("fail"), { stderr: Buffer.from("err"), stdout: Buffer.from("") });
      }
      if (cmd.includes("test")) {
        throw Object.assign(new Error("fail"), { stderr: Buffer.from("err2"), stdout: Buffer.from("") });
      }
      return Buffer.from("ok");
    });

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const task = makeOpsTask({ type: "qa_scan" });

    await runner.runQaScan(task, JSON.parse(task.description));

    const resultPost = fetchCalls.find((c) => c.url.includes("/result"));
    expect(resultPost).toBeDefined();
    const result = JSON.parse(resultPost!.body!);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("2 issue(s)");
    const details = JSON.parse(result.details);
    expect(details.issues).toHaveLength(2);
    expect(details.issues[0].check).toBe("build");
    expect(details.issues[1].check).toBe("test");
  });
});
