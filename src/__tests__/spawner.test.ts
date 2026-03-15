import { describe, it, expect } from "vitest";
import { buildBranchName } from "../spawner.js";

describe("buildBranchName", () => {
  it("builds branch name from agent name and task ID", () => {
    expect(buildBranchName("builder", "task-abc-123")).toBe(
      "agent/builder-task-abc"
    );
  });

  it("sanitizes agent name with special characters", () => {
    const result = buildBranchName("cloud-engineer", "TASK.456!xyz");
    expect(result).toBe("agent/cloud-engineer-TASK.456");
  });

  it("lowercases uppercase agent names", () => {
    const result = buildBranchName("Builder", "abcd1234");
    expect(result).toBe("agent/builder-abcd1234");
  });

  it("replaces non-alphanumeric chars (except dash/underscore) with dashes", () => {
    const result = buildBranchName("my.agent!v2", "12345678rest");
    expect(result).toBe("agent/my-agent-v2-12345678");
  });

  it("truncates task ID to first 8 characters", () => {
    const result = buildBranchName("builder", "abcdefghijklmnop");
    expect(result).toBe("agent/builder-abcdefgh");
  });

  it("handles short task IDs without padding", () => {
    const result = buildBranchName("builder", "abc");
    expect(result).toBe("agent/builder-abc");
  });
});
