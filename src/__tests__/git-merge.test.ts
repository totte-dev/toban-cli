import { describe, it, expect, vi, beforeEach } from "vitest";
import { rebaseOntoBase, escalateConflict } from "../pipeline/git-merge.js";
import type { ActionContext } from "../agents/agent-templates.js";

describe("rebaseOntoBase", () => {
  it("returns success when rebase completes without conflict", () => {
    const exec = vi.fn();
    const result = rebaseOntoBase("/repo", "agent/builder-abc", "main", exec as never);

    expect(result.success).toBe(true);
    expect(result.conflictedFiles).toEqual([]);
    // Should checkout the branch then rebase
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith(
      'git checkout "agent/builder-abc"',
      { cwd: "/repo", stdio: "pipe" }
    );
    expect(exec).toHaveBeenCalledWith(
      'git rebase "main"',
      { cwd: "/repo", stdio: "pipe" }
    );
  });

  it("returns failure with conflicted files when rebase fails", () => {
    const exec = vi.fn()
      .mockImplementationOnce(() => {}) // checkout succeeds
      .mockImplementationOnce(() => { throw new Error("CONFLICT"); }) // rebase fails
      .mockReturnValueOnce(Buffer.from("src/file-a.ts\nsrc/file-b.ts\n")) // diff --name-only
      .mockImplementationOnce(() => {}); // rebase --abort

    const result = rebaseOntoBase("/repo", "agent/builder-abc", "main", exec as never);

    expect(result.success).toBe(false);
    expect(result.conflictedFiles).toEqual(["src/file-a.ts", "src/file-b.ts"]);
    // Should have called rebase --abort
    expect(exec).toHaveBeenCalledWith(
      "git rebase --abort",
      { cwd: "/repo", stdio: "pipe" }
    );
  });

  it("returns failure with empty conflictedFiles when diff also fails", () => {
    const exec = vi.fn()
      .mockImplementationOnce(() => {}) // checkout
      .mockImplementationOnce(() => { throw new Error("CONFLICT"); }) // rebase
      .mockImplementationOnce(() => { throw new Error("diff failed"); }) // diff fails
      .mockImplementationOnce(() => {}); // rebase --abort

    const result = rebaseOntoBase("/repo", "agent/builder-abc", "main", exec as never);

    expect(result.success).toBe(false);
    expect(result.conflictedFiles).toEqual([]);
  });

  it("handles rebase --abort failure gracefully", () => {
    const exec = vi.fn()
      .mockImplementationOnce(() => {}) // checkout
      .mockImplementationOnce(() => { throw new Error("CONFLICT"); }) // rebase
      .mockReturnValueOnce(Buffer.from("file.ts\n")) // diff
      .mockImplementationOnce(() => { throw new Error("abort failed"); }); // abort fails

    const result = rebaseOntoBase("/repo", "agent/builder-abc", "main", exec as never);

    // Should still return the conflict info even if abort fails
    expect(result.success).toBe(false);
    expect(result.conflictedFiles).toEqual(["file.ts"]);
  });
});

describe("escalateConflict", () => {
  let ctx: ActionContext;
  let mockUpdateTask: ReturnType<typeof vi.fn>;
  let mockOnDataUpdate: ReturnType<typeof vi.fn>;
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let mockRecordFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUpdateTask = vi.fn().mockResolvedValue(undefined);
    mockOnDataUpdate = vi.fn();
    mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockRecordFailure = vi.fn().mockResolvedValue(undefined);
    ctx = {
      api: { updateTask: mockUpdateTask, sendMessage: mockSendMessage, recordFailure: mockRecordFailure } as never,
      task: { id: "task-conflict-1", title: "Test task", description: "desc", status: "in_progress", priority: "p2" },
      agentName: "builder",
      config: {
        apiUrl: "http://localhost:8787",
        apiKey: "tb_test",
        workingDir: "/repo",
        baseBranch: "main",
      },
      onDataUpdate: mockOnDataUpdate as (entity: string, id: string, changes: Record<string, unknown>) => void,
    };
  });

  it("first conflict: resets task to todo for auto-retry", async () => {
    await escalateConflict(ctx, ["src/a.ts", "src/b.ts"], "agent/builder-abc");

    expect(mockUpdateTask).toHaveBeenCalledWith("task-conflict-1", expect.objectContaining({
      status: "todo",
    }));
    expect(ctx.exitCode).toBe(1);
    expect(mockRecordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure_type: "merge_conflict",
    }));
  });

  it("broadcasts todo status via WS on retry", async () => {
    ctx.task.id = "task-conflict-ws";
    await escalateConflict(ctx, ["src/a.ts"], "agent/builder-abc");

    expect(mockOnDataUpdate).toHaveBeenCalledWith("task", "task-conflict-ws", expect.objectContaining({
      status: "todo",
    }));
  });

  it("escalates to blocked after max retries", async () => {
    // Use a unique task ID for this test to get clean retry count
    ctx.task.id = "task-conflict-max";

    // Call 3 times to exceed the 2-retry limit
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    // 3rd call should escalate to blocked
    const lastCall = mockUpdateTask.mock.calls[mockUpdateTask.mock.calls.length - 1];
    expect(lastCall[1].status).toBe("blocked");
    // Should notify user
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it("records failure to Failure DB", async () => {
    ctx.task.id = "task-conflict-db";
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    expect(mockRecordFailure).toHaveBeenCalledWith(expect.objectContaining({
      task_id: "task-conflict-db",
      failure_type: "merge_conflict",
      summary: expect.stringContaining("file.ts"),
    }));
  });

  it("does not throw when API update fails", async () => {
    ctx.task.id = "task-conflict-fail";
    mockUpdateTask.mockRejectedValue(new Error("network error"));

    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    expect(mockOnDataUpdate).toHaveBeenCalled();
  });

  it("works without onDataUpdate callback", async () => {
    ctx.task.id = "task-conflict-no-ws";
    ctx.onDataUpdate = undefined;

    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    expect(mockUpdateTask).toHaveBeenCalled();
  });
});
