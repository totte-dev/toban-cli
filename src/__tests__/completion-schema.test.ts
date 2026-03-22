import { describe, it, expect } from "vitest";
import {
  normalizeCompletion,
  normalizeReviewerCompletion,
  toLegacyFormat,
} from "../utils/completion-schema.js";

describe("completion-schema", () => {
  describe("normalizeCompletion", () => {
    it("normalizes standard fields", () => {
      const result = normalizeCompletion({
        summary: "Added auth middleware",
        commits: ["abc123", "def456"],
        files_changed: ["src/auth.ts", "src/index.ts"],
      });
      expect(result.summary).toBe("Added auth middleware");
      expect(result.commits).toEqual(["abc123", "def456"]);
      expect(result.files_changed).toEqual(["src/auth.ts", "src/index.ts"]);
    });

    it("maps review_comment to summary (backwards compat)", () => {
      const result = normalizeCompletion({
        review_comment: "Fixed the bug in auth flow",
        commits: "abc123,def456",
      });
      expect(result.summary).toBe("Fixed the bug in auth flow");
      expect(result.commits).toEqual(["abc123", "def456"]);
    });

    it("prefers summary over review_comment", () => {
      const result = normalizeCompletion({
        summary: "New format",
        review_comment: "Old format",
      });
      expect(result.summary).toBe("New format");
    });

    it("handles comma-separated commits string", () => {
      const result = normalizeCompletion({ summary: "test", commits: "abc,def, ghi" });
      expect(result.commits).toEqual(["abc", "def", "ghi"]);
    });

    it("handles empty commits string", () => {
      const result = normalizeCompletion({ summary: "test", commits: "" });
      expect(result.commits).toBeUndefined();
    });

    it("handles comma-separated files_changed string", () => {
      const result = normalizeCompletion({
        summary: "test",
        files_changed: "src/a.ts, src/b.ts",
      });
      expect(result.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("handles missing optional fields", () => {
      const result = normalizeCompletion({ summary: "minimal" });
      expect(result.summary).toBe("minimal");
      expect(result.commits).toBeUndefined();
      expect(result.files_changed).toBeUndefined();
    });

    it("handles completely empty input", () => {
      const result = normalizeCompletion({});
      expect(result.summary).toBe("");
    });
  });

  describe("normalizeReviewerCompletion", () => {
    it("normalizes reviewer output", () => {
      const result = normalizeReviewerCompletion({
        review_comment: "Code looks good",
        verdict: "APPROVE",
        requirement_match: "met",
        code_quality: "clean",
        test_coverage: "all tests pass",
        risks: "none",
        score: 85,
      });
      expect(result.summary).toBe("Code looks good");
      expect(result.verdict).toBe("APPROVE");
      expect(result.requirement_match).toBe("met");
      expect(result.score).toBe(85);
    });

    it("defaults verdict to NEEDS_CHANGES for invalid value", () => {
      const result = normalizeReviewerCompletion({
        summary: "Issues found",
        verdict: "INVALID",
      });
      expect(result.verdict).toBe("NEEDS_CHANGES");
    });

    it("handles missing optional reviewer fields", () => {
      const result = normalizeReviewerCompletion({
        summary: "review",
        verdict: "APPROVE",
      });
      expect(result.requirement_match).toBe("");
      expect(result.risks).toBe("none");
      expect(result.score).toBeUndefined();
    });
  });

  describe("toLegacyFormat", () => {
    it("converts back to legacy format", () => {
      const legacy = toLegacyFormat({
        summary: "Did the thing",
        commits: ["abc", "def"],
      });
      expect(legacy.review_comment).toBe("Did the thing");
      expect(legacy.commits).toBe("abc,def");
    });

    it("handles missing commits", () => {
      const legacy = toLegacyFormat({ summary: "test" });
      expect(legacy.commits).toBe("");
    });
  });
});
