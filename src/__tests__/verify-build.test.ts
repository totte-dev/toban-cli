import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeActions, type ActionContext, type TemplateAction } from "../agent-templates.js";
import type { ApiClient, Task } from "../api-client.js";

// Mock execSync
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

// Mock resolveRepoRoot to return cwd as-is
vi.mock("../git-ops.js", () => ({
  resolveRepoRoot: (dir: string) => dir,
}));

// Mock global fetch (used by update_agent action)
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => ({}) }));

function createMockApi(): ApiClient {
  return {
    updateTask: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
    recordFailure: vi.fn().mockResolvedValue({}),
    fetchAgentMemories: vi.fn().mockResolvedValue([]),
    putAgentMemory: vi.fn().mockResolvedValue({}),
  } as unknown as ApiClient;
}

function createCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    api: createMockApi(),
    task: {
      id: "task-123",
      title: "Test task",
      description: "desc",
      status: "in_progress",
      owner: "builder",
      priority: "p2",
      sprint: 75,
    } as Task,
    agentName: "builder",
    exitCode: 0,
    config: {
      apiUrl: "http://localhost:8787",
      apiKey: "test-key",
      workingDir: "/tmp/test-repo",
      baseBranch: "main",
    },
    taskLog: { event: vi.fn() },
    onDataUpdate: vi.fn(),
    ...overrides,
  };
}

const VERIFY_BUILD: TemplateAction = {
  type: "verify_build",
  when: "success",
  label: "Verify build and tests pass",
};

describe("verify_build action", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it("passes when both build and test succeed", async () => {
    execSyncMock.mockReturnValue(Buffer.from("ok"));
    const ctx = createCtx();

    await executeActions([VERIFY_BUILD], ctx, "post");

    expect(ctx.exitCode).toBe(0);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    // First call = build, second = test
    expect(execSyncMock.mock.calls[0][0]).toBe("npm run build");
    expect(execSyncMock.mock.calls[1][0]).toBe("npm test");
    expect(ctx.api.recordFailure).not.toHaveBeenCalled();
  });

  it("uses workspace commands when configured", async () => {
    execSyncMock.mockReturnValue(Buffer.from("ok"));
    const ctx = createCtx({
      config: {
        apiUrl: "http://localhost:8787",
        apiKey: "test-key",
        workingDir: "/tmp/test-repo",
        baseBranch: "main",
        buildCommand: "make build",
        testCommand: "make test",
      },
    });

    await executeActions([VERIFY_BUILD], ctx, "post");

    expect(ctx.exitCode).toBe(0);
    expect(execSyncMock.mock.calls[0][0]).toBe("make build");
    expect(execSyncMock.mock.calls[1][0]).toBe("make test");
  });

  it("sets exitCode=1 and records failure when build fails", async () => {
    const buildError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("src/main.ts(10,5): error TS2322: Type mismatch"),
      stdout: Buffer.from(""),
      status: 1,
    });
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("build")) throw buildError;
      return Buffer.from("ok");
    });
    const ctx = createCtx();

    await executeActions([VERIFY_BUILD], ctx, "post");

    expect(ctx.exitCode).toBe(1);
    // Build (1) + git reset to revert merge (2), test was skipped
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock.mock.calls[1][0]).toContain("git reset --hard");
    expect(ctx.api.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "task-123",
        failure_type: "verify_build",
        summary: expect.stringContaining("TS2322"),
      }),
    );
  });

  it("sets exitCode=1 and records failure when tests fail", async () => {
    const testError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from(""),
      stdout: Buffer.from("FAIL src/foo.test.ts\n  ✕ expected true to be false"),
      status: 1,
    });
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("test")) throw testError;
      return Buffer.from("ok");
    });
    const ctx = createCtx();

    await executeActions([VERIFY_BUILD], ctx, "post");

    expect(ctx.exitCode).toBe(1);
    // Build (1) + test (2) + git reset to revert merge (3)
    expect(execSyncMock).toHaveBeenCalledTimes(3);
    expect(execSyncMock.mock.calls[2][0]).toContain("git reset --hard");
    expect(ctx.api.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_type: "verify_build",
        summary: expect.stringContaining("expected true to be false"),
      }),
    );
  });

  it("skips subsequent success actions after verify_build failure", async () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("error"), stdout: Buffer.from("") });
    });
    const ctx = createCtx();
    const actions: TemplateAction[] = [
      VERIFY_BUILD,
      { type: "update_task", params: { status: "review" }, when: "success", label: "Move to review" },
      { type: "update_task", params: { status: "todo" }, when: "failure", label: "Reset to todo" },
    ];

    await executeActions(actions, ctx, "post");

    expect(ctx.exitCode).toBe(1);
    // spawn_reviewer-like action should be skipped, failure action should run
    expect(ctx.api.updateTask).toHaveBeenCalledWith("task-123", { status: "todo" });
    expect(ctx.api.updateTask).not.toHaveBeenCalledWith("task-123", expect.objectContaining({ status: "review" }));
  });

  it("runs failure actions after verify_build failure", async () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("err"), stdout: Buffer.from("") });
    });
    const ctx = createCtx();
    const actions: TemplateAction[] = [
      VERIFY_BUILD,
      { type: "notify_user", params: { message: "Task failed" }, when: "failure", label: "Notify" },
    ];

    await executeActions(actions, ctx, "post");

    expect(ctx.exitCode).toBe(1);
    expect(ctx.api.sendMessage).toHaveBeenCalled();
  });

  it("logs action_error on failure, not action_ok", async () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("compile error"), stdout: Buffer.from("") });
    });
    const ctx = createCtx();

    await executeActions([VERIFY_BUILD], ctx, "post");

    const eventCalls = (ctx.taskLog!.event as ReturnType<typeof vi.fn>).mock.calls;
    const actionOkCalls = eventCalls.filter(([name]: [string]) => name === "action_ok");
    const actionErrorCalls = eventCalls.filter(([name]: [string]) => name === "action_error");
    expect(actionOkCalls).toHaveLength(0);
    expect(actionErrorCalls).toHaveLength(1);
    expect(actionErrorCalls[0][1].error).toContain("compile error");
  });

  it("skips verify_build when exitCode already non-zero", async () => {
    const ctx = createCtx({ exitCode: 1 });

    await executeActions([VERIFY_BUILD], ctx, "post");

    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
