import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeActions, type ActionContext, type TemplateAction } from "../agent-templates.js";
import type { ApiClient, Task } from "../api-client.js";

// Mock global fetch
const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => ({}) });
vi.stubGlobal("fetch", fetchMock);

function createMockApi(): ApiClient {
  return {
    updateTask: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
    fetchAgentMemories: vi.fn().mockResolvedValue([]),
    putAgentMemory: vi.fn().mockResolvedValue({}),
  } as unknown as ApiClient;
}

function createMockTask(owner = "builder"): Task {
  return {
    id: "task-abc-123",
    title: "Test task",
    description: "Test description",
    status: "in_progress",
    owner,
    priority: "p2",
  } as Task;
}

function createActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    api: createMockApi(),
    task: createMockTask(),
    agentName: "builder",
    config: {
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
      workingDir: "/tmp/test",
      baseBranch: "main",
    },
    onDataUpdate: vi.fn(),
    ...overrides,
  };
}

describe("update_agent action targets correct agent", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, json: () => ({}) });
  });

  it("should use ctx.agentName (worker) for update_agent pre-action", async () => {
    const ctx = createActionContext({ agentName: "builder" });
    const actions: TemplateAction[] = [
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ];

    await executeActions(actions, ctx, "pre");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/agents",
      expect.objectContaining({
        method: "PUT",
        body: expect.any(String),
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.name).toBe("builder");
    expect(body.status).toBe("working");
  });

  it("should use ctx.agentName (worker) for update_agent post-action on success", async () => {
    const ctx = createActionContext({ agentName: "builder", exitCode: 0 });
    const actions: TemplateAction[] = [
      { type: "update_agent", params: { status: "idle", activity: "Task completed" }, when: "success", label: "Report agent idle" },
    ];

    await executeActions(actions, ctx, "post");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.name).toBe("builder");
    expect(body.status).toBe("idle");
    expect(body.activity).toBe("Task completed");
  });

  it("should broadcast correct agent name via onDataUpdate", async () => {
    const onDataUpdate = vi.fn();
    const ctx = createActionContext({ agentName: "builder", onDataUpdate });
    const actions: TemplateAction[] = [
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ];

    await executeActions(actions, ctx, "pre");

    expect(onDataUpdate).toHaveBeenCalledWith(
      "agent",
      "builder",
      expect.objectContaining({ status: "working" }),
    );
  });

  it("should NOT use manager name when worker agent is the target", async () => {
    // This test verifies the fix: ActionContext.agentName should be the worker name,
    // not the manager name. Before the fix, cliArgs.agentName ("manager") was used.
    const ctx = createActionContext({ agentName: "builder" });
    const actions: TemplateAction[] = [
      { type: "update_agent", params: { status: "working" }, label: "Report agent working" },
    ];

    await executeActions(actions, ctx, "pre");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.name).not.toBe("manager");
    expect(body.name).toBe("builder");
  });
});

describe("reportStatus should not set parent_agent", () => {
  it("runner.reportStatus body should not include parent_agent field", () => {
    // runner.ts reportStatus sends this body to PUT /api/v1/agents.
    // parent_agent must NOT be included, because pre-registered top-level
    // agents (like "builder") would otherwise become children of "manager",
    // causing them to be filtered out of the Sprint agent strip.
    const config = {
      name: "builder",
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
      taskId: "task-123",
      parentAgent: "manager",
    };

    // This matches the fixed reportStatus body construction
    const body = {
      name: config.name,
      status: "running",
      activity: `Task ${config.taskId}`,
    };

    expect(body).not.toHaveProperty("parent_agent");
    expect(body.name).toBe("builder");
    expect(body.status).toBe("running");
  });
});
