import { describe, it, expect } from "vitest";
import { classifyRejection } from "../utils/infra-classifier.js";

describe("classifyRejection", () => {
  it("returns code_quality for normal rejections", () => {
    const result = classifyRejection(
      '{"verdict":"NEEDS_CHANGES","code_quality":"Missing error handling"}',
      "",
      false,
    );
    expect(result.classification).toBe("code_quality");
    expect(result.category).toBeUndefined();
  });

  it("detects merge conflict in review comment", () => {
    const result = classifyRejection(
      "NEEDS_CHANGES: merge conflict in src/index.ts",
      "",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("merge_conflict");
  });

  it("detects CONFLICT in stderr", () => {
    const result = classifyRejection(
      '{"verdict":"NEEDS_CHANGES"}',
      "CONFLICT (content): Merge conflict in src/app.tsx\nAutomatic merge failed",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("merge_conflict");
  });

  it("detects worktree setup failure", () => {
    const result = classifyRejection(
      "",
      "fatal: 'agent/builder-1-abc123' is already checked out at '/tmp/worktree'",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("worktree_setup");
  });

  it("detects branch already exists", () => {
    const result = classifyRejection(
      "branch 'agent/builder-2' already exists",
      "",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("worktree_setup");
  });

  it("detects npm install failures", () => {
    const result = classifyRejection(
      "",
      "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("build_env");
  });

  it("detects MODULE_NOT_FOUND", () => {
    const result = classifyRejection(
      "",
      "Error: Cannot find module '../lib/utils'\nMODULE_NOT_FOUND",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("build_env");
  });

  it("detects Manager override as reviewer override", () => {
    const result = classifyRejection(
      '{"verdict":"NEEDS_CHANGES","code_quality":"Style issue"}',
      "",
      true,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("reviewer_override");
  });

  it("detects CLAUDE.md issues", () => {
    const result = classifyRejection(
      "CLAUDE.md missing or not found in worktree",
      "",
      false,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("prompt_injection");
  });

  it("prioritizes Manager override over other patterns", () => {
    // Even if there's a merge conflict mention, override takes precedence
    const result = classifyRejection(
      "merge conflict mentioned but Manager overrode",
      "",
      true,
    );
    expect(result.classification).toBe("infra");
    expect(result.category).toBe("reviewer_override");
  });
});
