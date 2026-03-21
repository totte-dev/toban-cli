import { describe, it, expect, vi, beforeEach } from "vitest";
import { rebaseOntoBase, escalateConflict } from "../handlers/git-merge.js";
import type { ActionContext } from "../agent-templates.js";

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

  beforeEach(() => {
    mockUpdateTask = vi.fn().mockResolvedValue(undefined);
    mockOnDataUpdate = vi.fn();
    ctx = {
      api: { updateTask: mockUpdateTask } as never,
      task: { id: "task-123", title: "Test task", description: "desc", status: "in_progress", priority: "p2" },
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

  it("updates task to blocked with conflict file list", async () => {
    await escalateConflict(ctx, ["src/a.ts", "src/b.ts"], "agent/builder-abc");

    expect(mockUpdateTask).toHaveBeenCalledWith("task-123", {
      status: "blocked",
      review_comment: "Merge conflict on agent/builder-abc: src/a.ts, src/b.ts",
    });
  });

  it("broadcasts data update via WS", async () => {
    await escalateConflict(ctx, ["src/a.ts"], "agent/builder-abc");

    expect(mockOnDataUpdate).toHaveBeenCalledWith("task", "task-123", {
      status: "blocked",
      review_comment: "Merge conflict on agent/builder-abc: src/a.ts",
    });
  });

  it("handles unknown files when conflict list is empty", async () => {
    await escalateConflict(ctx, [], "agent/builder-abc");

    expect(mockUpdateTask).toHaveBeenCalledWith("task-123", {
      status: "blocked",
      review_comment: "Merge conflict on agent/builder-abc: (unknown files)",
    });
  });

  it("does not throw when API update fails", async () => {
    mockUpdateTask.mockRejectedValue(new Error("network error"));

    // Should not throw
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    // WS broadcast should still happen
    expect(mockOnDataUpdate).toHaveBeenCalled();
  });

  it("works without onDataUpdate callback", async () => {
    ctx.onDataUpdate = undefined;

    // Should not throw
    await escalateConflict(ctx, ["file.ts"], "agent/builder-abc");

    expect(mockUpdateTask).toHaveBeenCalled();
  });
});
