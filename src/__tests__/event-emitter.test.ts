import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventEmitter } from "../utils/event-emitter.js";
import type { ApiClient, EventInput } from "../services/api-client.js";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function createMockApiClient(): ApiClient & { recordedEvents: EventInput[][] } {
  const recorded: EventInput[][] = [];
  return {
    recordedEvents: recorded,
    recordEvent: vi.fn(async () => {}),
    recordEvents: vi.fn(async (events: EventInput[]) => { recorded.push(events); }),
    fetchWorkspace: vi.fn(),
    fetchGitToken: vi.fn(),
    fetchTasks: vi.fn(),
    fetchRepositories: vi.fn(),
    startSprint: vi.fn(),
    fetchSprintData: vi.fn(),
    fetchCurrentSprint: vi.fn(),
    completeSprint: vi.fn(),
    updateTask: vi.fn(),
    updateAgent: vi.fn(),
    submitRetroComment: vi.fn(),
    reportProgress: vi.fn(),
    fetchPlaybookPrompt: vi.fn(),
    fetchMessages: vi.fn(),
    sendMessage: vi.fn(),
    fetchMySecrets: vi.fn(),
    fetchApiDocs: vi.fn(),
    fetchAgentMemories: vi.fn(),
    putAgentMemory: vi.fn(),
    fetchRelevantFailures: vi.fn(),
    recordFailure: vi.fn(),
    fetchPlanLimits: vi.fn(),
  } as unknown as ApiClient & { recordedEvents: EventInput[][] };
}

/** Clear the disk buffer to isolate tests */
function clearDiskBuffer(): void {
  const dir = join(homedir(), ".toban", "events");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "buffer.jsonl"), "");
}

describe("EventEmitter", () => {
  beforeEach(() => {
    clearDiskBuffer();
  });

  afterEach(() => {
    clearDiskBuffer();
  });

  it("does not send events until flush is called", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.agentSpawned("builder", "task-1", { role: "builder" });
    emitter.agentSpawned("builder", "task-2", { role: "builder" });

    // Not flushed yet — no API calls
    expect(api.recordEvents).not.toHaveBeenCalled();
    expect(emitter.pending).toBe(2);

    // Flush sends all buffered events
    await emitter.flush();

    expect(api.recordEvents).toHaveBeenCalledTimes(1);
    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch).toHaveLength(2);
    expect(batch[0].type).toBe("agent.spawned");
    expect(batch[1].type).toBe("agent.spawned");
  });

  it("sets trace_id and sprint from constructor", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76, "custom-trace");

    emitter.taskStatusChanged("task-1", "todo", "in_progress");
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].trace_id).toBe("custom-trace");
    expect(batch[0].sprint).toBe(76);
  });

  it("auto-generates trace_id from sprint number", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 42);

    emitter.buildEvent("passed", { command: "npm test" });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].trace_id).toBe("sprint-42");
  });

  it("emits agent lifecycle events with correct structure", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.agentSpawned("builder", "task-1", { role: "builder", model: "claude-opus" });
    emitter.agentCompleted("builder", "task-1", { role: "builder", duration_ms: 5000 });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("agent.spawned");
    expect(batch[0].agent_name).toBe("builder");
    expect(batch[0].task_id).toBe("task-1");
    expect(batch[0].data?.role).toBe("builder");
    expect(batch[1].type).toBe("agent.completed");
    expect(batch[1].data?.duration_ms).toBe(5000);
  });

  it("emits task status change events", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.taskStatusChanged("task-1", "todo", "in_progress", { title: "Fix bug" });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("task.status_changed");
    expect(batch[0].data?.previous_status).toBe("todo");
    expect(batch[0].data?.new_status).toBe("in_progress");
    expect(batch[0].data?.title).toBe("Fix bug");
  });

  it("emits build events", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.buildEvent("started", { command: "npm run build" });
    emitter.buildEvent("passed", { command: "npm run build", duration_ms: 3000 });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("build.started");
    expect(batch[1].type).toBe("build.passed");
  });

  it("emits review completed events", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.reviewCompleted("task-1", "reviewer", { verdict: "APPROVE", score: 85 });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("review.completed");
    expect(batch[0].task_id).toBe("task-1");
    expect(batch[0].data?.verdict).toBe("APPROVE");
  });

  it("emits sprint events", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.sprintEvent("sprint.started", { sprint_number: 76, goal: "Fix all bugs" });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("sprint.started");
  });

  it("emits guardrail events", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.guardrailEvent("guardrail.blocked", { layer: 1, rule: "no-npm-publish", operation: "npm publish" });
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].type).toBe("guardrail.blocked");
    expect(batch[0].data?.layer).toBe(1);
  });

  it("flush sends immediately without waiting", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.agentSpawned("builder", "task-1");
    await emitter.flush();

    expect(api.recordEvents).toHaveBeenCalledTimes(1);
  });

  it("handles empty flush gracefully", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    await emitter.flush();
    expect(api.recordEvents).not.toHaveBeenCalled();
  });

  it("generates unique span_ids per event", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.agentSpawned("builder", "task-1");
    emitter.agentSpawned("builder", "task-2");
    await emitter.flush();

    const batch = (api.recordEvents as ReturnType<typeof vi.fn>).mock.calls[0][0] as EventInput[];
    expect(batch[0].span_id).not.toBe(batch[1].span_id);
  });

  it("clears pending count after flush", async () => {
    const api = createMockApiClient();
    const emitter = createEventEmitter(api, 76);

    emitter.agentSpawned("builder", "task-1");
    expect(emitter.pending).toBe(1);

    await emitter.flush();
    expect(emitter.pending).toBe(0);
  });
});
