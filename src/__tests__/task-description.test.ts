import { describe, it, expect } from "vitest";
import {
  parseStructuredDescription,
  formatDescriptionForPrompt,
  getPromptDescription,
  getTaskCategory,
} from "../utils/task-description.js";

describe("parseStructuredDescription", () => {
  it("parses valid structured JSON", () => {
    const desc = JSON.stringify({
      category: "destructive",
      target_repo: "toban-cli",
      context: "Fix the push bug",
      steps: ["Find the handler", "Add error propagation"],
      acceptance_criteria: ["Push failure sets exitCode", "Test passes"],
      files_hint: ["src/handlers/git-push.ts"],
      constraints: ["Don't change merge logic"],
      related_tasks: ["4c18b0a6"],
    });

    const result = parseStructuredDescription(desc);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("destructive");
    expect(result!.steps).toHaveLength(2);
    expect(result!.files_hint).toEqual(["src/handlers/git-push.ts"]);
  });

  it("returns null for free text", () => {
    expect(parseStructuredDescription("Just a plain text description")).toBeNull();
  });

  it("returns null for empty/null input", () => {
    expect(parseStructuredDescription("")).toBeNull();
    expect(parseStructuredDescription(null)).toBeNull();
    expect(parseStructuredDescription(undefined)).toBeNull();
  });

  it("returns null for JSON without structured fields", () => {
    expect(parseStructuredDescription('{"foo":"bar"}')).toBeNull();
  });

  it("handles partial structured JSON (only some fields)", () => {
    const desc = JSON.stringify({ context: "Background info", acceptance_criteria: ["Build passes"] });
    const result = parseStructuredDescription(desc);
    expect(result).not.toBeNull();
    expect(result!.context).toBe("Background info");
    expect(result!.category).toBeUndefined();
    expect(result!.steps).toBeUndefined();
  });

  it("ignores invalid category values", () => {
    const desc = JSON.stringify({ category: "invalid", context: "test" });
    const result = parseStructuredDescription(desc);
    expect(result!.category).toBeUndefined();
  });
});

describe("formatDescriptionForPrompt", () => {
  it("formats all fields", () => {
    const result = formatDescriptionForPrompt({
      context: "Fix bug",
      steps: ["Step 1", "Step 2"],
      acceptance_criteria: ["Criterion A"],
      files_hint: ["src/foo.ts"],
      constraints: ["No breaking changes"],
    });

    expect(result).toContain("Context:\nFix bug");
    expect(result).toContain("1. Step 1");
    expect(result).toContain("2. Step 2");
    expect(result).toContain("- Criterion A");
    expect(result).toContain("- src/foo.ts");
    expect(result).toContain("- No breaking changes");
  });

  it("skips empty fields", () => {
    const result = formatDescriptionForPrompt({ context: "Only context" });
    expect(result).toBe("Context:\nOnly context");
    expect(result).not.toContain("Steps");
  });
});

describe("getPromptDescription", () => {
  it("returns formatted output for structured JSON", () => {
    const desc = JSON.stringify({
      context: "Background",
      steps: ["Do thing"],
      acceptance_criteria: ["It works"],
    });
    const result = getPromptDescription(desc);
    expect(result).toContain("Context:\nBackground");
    expect(result).toContain("1. Do thing");
  });

  it("returns raw text for free text descriptions", () => {
    expect(getPromptDescription("Plain description")).toBe("Plain description");
  });

  it("returns empty string for empty input", () => {
    expect(getPromptDescription("")).toBe("");
    expect(getPromptDescription(null)).toBe("");
  });
});

describe("getTaskCategory", () => {
  it("extracts category from structured description", () => {
    const desc = JSON.stringify({ category: "destructive", context: "test" });
    expect(getTaskCategory(desc)).toBe("destructive");
  });

  it("defaults to mutating for free text", () => {
    expect(getTaskCategory("plain text")).toBe("mutating");
  });

  it("defaults to mutating for missing category", () => {
    const desc = JSON.stringify({ context: "no category" });
    expect(getTaskCategory(desc)).toBe("mutating");
  });
});
