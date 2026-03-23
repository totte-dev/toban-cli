import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldSplit, autoSplitTasks, type SubtaskDef } from "../services/task-splitter.js";
import type { Task } from "../services/api-client.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    title: "Implement feature X",
    description: "Build the feature X with tests",
    status: "todo",
    priority: "p2",
    story_points: 8,
    owner: "builder",
    type: "feature",
    ...overrides,
  } as Task;
}

describe("shouldSplit", () => {
  it("returns true for task with SP >= threshold", () => {
    expect(shouldSplit(makeTask({ story_points: 8 }), 8)).toBe(true);
    expect(shouldSplit(makeTask({ story_points: 13 }), 8)).toBe(true);
  });

  it("returns false for task with SP < threshold", () => {
    expect(shouldSplit(makeTask({ story_points: 5 }), 8)).toBe(false);
    expect(shouldSplit(makeTask({ story_points: 7 }), 8)).toBe(false);
  });

  it("returns false for null/undefined SP", () => {
    expect(shouldSplit(makeTask({ story_points: null }), 8)).toBe(false);
    expect(shouldSplit(makeTask({ story_points: undefined }), 8)).toBe(false);
  });

  it("returns false for task with auto_split:false label", () => {
    expect(shouldSplit(makeTask({ labels: ["auto_split:false"] }), 8)).toBe(false);
  });

  it("returns false for task with no_split label", () => {
    expect(shouldSplit(makeTask({ labels: '["no_split"]' }), 8)).toBe(false);
  });

  it("returns false for already-blocked tasks", () => {
    expect(shouldSplit(makeTask({ status: "blocked" as Task["status"] }), 8)).toBe(false);
  });

  it("returns false for sub-tasks (has parent_task)", () => {
    expect(shouldSplit(makeTask({ parent_task: "parent-001" }), 8)).toBe(false);
  });

  it("returns false for done tasks", () => {
    expect(shouldSplit(makeTask({ status: "done" as Task["status"] }), 8)).toBe(false);
  });
});

describe("autoSplitTasks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
  });

  const mockSubtasks: SubtaskDef[] = [
    { title: "Subtask 1", description: "First part", owner: "builder", type: "feature", priority: "p2", story_points: 3 },
    { title: "Subtask 2", description: "Second part", owner: "builder", type: "feature", priority: "p2", story_points: 3 },
  ];

  it("splits tasks and creates subtasks via API", async () => {
    const task = makeTask({ story_points: 10 });
    const splitFn = vi.fn().mockResolvedValue(mockSubtasks);

    const results = await autoSplitTasks([task], 5, {
      minSp: 8,
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
    }, splitFn);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].subtasks).toHaveLength(2);
    expect(splitFn).toHaveBeenCalledOnce();

    // 2 subtask creates + 1 parent status update = 3 fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify subtask creation calls
    const createCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit).method === "POST"
    );
    expect(createCalls).toHaveLength(2);
    const body1 = JSON.parse((createCalls[0][1] as RequestInit).body as string);
    expect(body1.parent_task).toBe("task-001");
    expect(body1.sprint).toBe(5);
    expect(body1.status).toBe("todo");

    // Verify parent blocked
    const patchCall = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: "blocked" });
  });

  it("skips tasks below SP threshold", async () => {
    const task = makeTask({ story_points: 5 });
    const splitFn = vi.fn().mockResolvedValue(mockSubtasks);

    const results = await autoSplitTasks([task], 5, {
      minSp: 8,
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
    }, splitFn);

    expect(results).toHaveLength(0);
    expect(splitFn).not.toHaveBeenCalled();
  });

  it("handles LLM returning empty subtasks", async () => {
    const task = makeTask({ story_points: 10 });
    const splitFn = vi.fn().mockResolvedValue([]);

    const results = await autoSplitTasks([task], 5, {
      minSp: 8,
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
    }, splitFn);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toContain("no valid subtasks");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles LLM errors gracefully", async () => {
    const task = makeTask({ story_points: 10 });
    const splitFn = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const results = await autoSplitTasks([task], 5, {
      minSp: 8,
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
    }, splitFn);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toContain("LLM timeout");
  });

  it("skips tasks with auto_split:false label", async () => {
    const task = makeTask({ story_points: 10, labels: ["auto_split:false"] });
    const splitFn = vi.fn().mockResolvedValue(mockSubtasks);

    const results = await autoSplitTasks([task], 5, {
      minSp: 8,
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
    }, splitFn);

    expect(results).toHaveLength(0);
    expect(splitFn).not.toHaveBeenCalled();
  });
});
