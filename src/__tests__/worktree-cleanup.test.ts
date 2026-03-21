import { describe, it, expect } from "vitest";
import { parseWorktreeList } from "../commands/sprint-complete.js";

describe("parseWorktreeList", () => {
  it("parses porcelain output with branches", () => {
    const output = `worktree /Users/test/repo
branch refs/heads/main

worktree /Users/test/repo/.worktrees/agent-builder-1-abc12345
branch refs/heads/agent/builder-1-abc12345

worktree /Users/test/repo/.worktrees/agent-builder-2-def67890
branch refs/heads/agent/builder-2-def67890

`;
    const result = parseWorktreeList(output);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ path: "/Users/test/repo", branch: "refs/heads/main" });
    expect(result[1]).toEqual({
      path: "/Users/test/repo/.worktrees/agent-builder-1-abc12345",
      branch: "refs/heads/agent/builder-1-abc12345",
    });
    expect(result[2]).toEqual({
      path: "/Users/test/repo/.worktrees/agent-builder-2-def67890",
      branch: "refs/heads/agent/builder-2-def67890",
    });
  });

  it("handles entries without branches (detached HEAD)", () => {
    const output = `worktree /Users/test/repo
branch refs/heads/main

worktree /Users/test/repo/.worktrees/detached
HEAD abc1234567890
detached

`;
    const result = parseWorktreeList(output);

    expect(result).toHaveLength(2);
    expect(result[0].branch).toBe("refs/heads/main");
    expect(result[1].branch).toBeNull();
  });

  it("returns empty for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("identifies agent worktree branches", () => {
    const output = `worktree /repo
branch refs/heads/main

worktree /repo/.worktrees/agent-builder-abc
branch refs/heads/agent/builder-abc

worktree /repo/.worktrees/feature-branch
branch refs/heads/feature/new-feature

`;
    const result = parseWorktreeList(output);
    const agentWorktrees = result.filter((w) => w.branch?.startsWith("refs/heads/agent/"));

    expect(agentWorktrees).toHaveLength(1);
    expect(agentWorktrees[0].branch).toBe("refs/heads/agent/builder-abc");
  });
});
