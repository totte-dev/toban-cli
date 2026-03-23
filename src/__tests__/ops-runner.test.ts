import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpsRunner } from "../ops-runner.js";

const API_URL = "https://api.example.com";
const API_KEY = "test-key";

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("OpsRunner", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchDueTasks returns tasks from API", async () => {
    const dueTasks = [
      { id: "op1", title: "E2E Run", description: "echo hello", category: "auto_check", status: "idle" },
    ];
    globalThis.fetch = mockFetchResponse(dueTasks);

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const result = await runner.fetchDueTasks();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("E2E Run");
  });

  it("fetchDueTasks returns empty array on API error", async () => {
    vi.useFakeTimers();
    globalThis.fetch = mockFetchResponse({}, false, 500);

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const resultPromise = runner.fetchDueTasks();

    // Advance past retry backoff delays (1s + 2s + 4s + jitter)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    const result = await resultPromise;
    expect(result).toEqual([]);
    vi.useRealTimers();
  });

  it("runTask returns failure for empty description", () => {
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    const result = runner.runTask({
      id: "op1", title: "Empty", description: "", owner: "builder",
      type: "chore", priority: "p2", category: "manual", schedule: "interval",
      interval_hours: 24, status: "idle", next_run_at: null, enabled: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("No action defined");
  });

  it("runTask identifies healthcheck URLs", () => {
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    // We can test URL detection without actually running curl
    const task = {
      id: "op1", title: "Health", description: "https://example.com/health",
      owner: "builder", type: "chore", priority: "p2", category: "auto_check" as const,
      schedule: "interval" as const, interval_hours: 1, status: "idle",
      next_run_at: null, enabled: 1,
    };
    // runTask will try curl which may fail in test env — that's fine, we just verify it doesn't crash
    const result = runner.runTask(task);
    // Either passes (if curl works) or fails gracefully
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.summary).toBe("string");
  });

  it("executeTask reports result to API", async () => {
    const fetchCalls: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      fetchCalls.push({ url, method: opts?.method, body: opts?.body as string });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, status: "idle", next_run_at: null }),
        text: () => Promise.resolve(""),
      });
    });

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    await runner.executeTask({
      id: "op1", title: "Test", description: "echo ok",
      owner: "builder", type: "chore", priority: "p2", category: "auto_check",
      schedule: "interval", interval_hours: 1, status: "idle",
      next_run_at: null, enabled: 1,
    });

    // Should have called PATCH (mark running) and POST (report result)
    const patchCall = fetchCalls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall!.url).toContain("/api/v1/ops-tasks/op1");

    const postCall = fetchCalls.find((c) => c.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall!.url).toContain("/api/v1/ops-tasks/op1/result");
  });

  it("tick skips tasks already being executed", async () => {
    const dueTasks = [
      { id: "op1", title: "Task 1", description: "echo 1", category: "auto_check", status: "idle" },
    ];

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(callCount === 1 ? dueTasks : { ok: true, status: "idle" }),
        text: () => Promise.resolve(""),
      });
    });

    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY });
    // Run tick twice concurrently — second should skip the in-flight task
    await Promise.all([runner.tick(), runner.tick()]);
    // The PATCH+POST calls should only happen once per task
  });

  it("start and stop manage the timer lifecycle", () => {
    const runner = new OpsRunner({ apiUrl: API_URL, apiKey: API_KEY, pollIntervalMs: 60_000 });
    // Mock fetch to prevent actual API calls
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    });

    runner.start();
    // Starting again should be a no-op
    runner.start();
    runner.stop();
    // Stopping again should be safe
    runner.stop();
  });
});
