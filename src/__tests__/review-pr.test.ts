import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process for git/gh commands
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: () => void) => { if (event === "close") setTimeout(cb, 10); }),
    kill: vi.fn(),
  }),
}));

// Mock agent-engine
vi.mock("../agents/agent-engine.js", () => ({
  getEngine: () => ({ supportsStructuredOutput: false }),
  extractTextFromStreamJson: () => "",
  resolveModelForRole: () => "claude-sonnet-4-20250514",
}));

// Mock spawner
vi.mock("../agents/spawner.js", () => ({
  spawnAgent: () => ({
    process: {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: () => void) => { if (event === "close") setTimeout(cb, 10); }),
      kill: vi.fn(),
    },
    agent: {},
  }),
}));

// Mock api-client
vi.mock("../services/api-client.js", () => ({
  createApiClient: () => ({
    fetchTasks: vi.fn().mockResolvedValue([]),
    fetchPlaybookPrompt: vi.fn().mockResolvedValue(""),
  }),
  createAuthHeaders: (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
}));

// Mock prompt templates
vi.mock("../manager/prompts/templates.js", () => ({
  PROMPT_TEMPLATES: {
    "reviewer-system": "Review system for {{projectName}}",
    "reviewer-type-hints": "{}",
    "reviewer-output-format": '{"verdict":"APPROVE or NEEDS_CHANGES"}',
  },
}));

// Mock agent-templates
vi.mock("../agents/agent-templates.js", () => ({
  interpolate: (template: string, vars: Record<string, string>) => {
    let result = template;
    for (const [k, v] of Object.entries(vars)) result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
    return result;
  },
}));

// Mock parse-labels
vi.mock("../utils/parse-labels.js", () => ({
  parseTaskLabels: () => [],
}));

// Mock ui
vi.mock("../ui.js", () => ({
  intro: vi.fn(),
  createSpinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock constants
vi.mock("../constants.js", () => ({
  TIMEOUTS: { REVIEWER: 300_000 },
}));

// Mock fetch
const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
vi.stubGlobal("fetch", fetchMock);

describe("review --pr flow", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock.mockClear();

    // Default git command responses
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("branch --show-current")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse --abbrev-ref")) return Buffer.from("main\n");
      if (cmd.includes("cat-file -p HEAD")) return Buffer.from("parent abc123\n");
      if (cmd.includes("git log --format=%s")) return Buffer.from("feat: some change\n");
      if (cmd.includes("gh pr create")) return Buffer.from("https://github.com/org/repo/pull/42\n");
      if (cmd.includes("git branch")) return Buffer.from("");
      if (cmd.includes("git reset")) return Buffer.from("");
      if (cmd.includes("git push")) return Buffer.from("");
      if (cmd.includes("gh pr comment")) return Buffer.from("");
      if (cmd.includes("gh pr merge")) return Buffer.from("");
      return Buffer.from("");
    });
  });

  it("creates a review branch when on main with --pr", async () => {
    const { handleReview } = await import("../commands/review.js");

    await handleReview("http://localhost:8787", "test-key", undefined, undefined, "HEAD~1..HEAD", "claude", true);

    // Should have created branch, reset main, pushed
    const calls = execSyncMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((c: string) => c.startsWith("git branch review/"))).toBe(true);
    expect(calls.some((c: string) => c.includes("git reset --hard"))).toBe(true);
    expect(calls.some((c: string) => c.includes("gh pr create"))).toBe(true);
  });

  it("pushes existing branch when not on main", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("branch --show-current")) return Buffer.from("feature/my-branch\n");
      if (cmd.includes("rev-parse --abbrev-ref")) return Buffer.from("main\n");
      if (cmd.includes("cat-file -p HEAD")) return Buffer.from("parent abc123\n");
      if (cmd.includes("gh pr create")) return Buffer.from("https://github.com/org/repo/pull/43\n");
      return Buffer.from("");
    });

    const { handleReview } = await import("../commands/review.js");
    await handleReview("http://localhost:8787", "test-key", undefined, undefined, "HEAD~1..HEAD", "claude", true);

    const calls = execSyncMock.mock.calls.map((c: unknown[]) => String(c[0]));
    // Should push the feature branch, not create a new one
    expect(calls.some((c: string) => c.includes("git push -u origin feature/my-branch"))).toBe(true);
    // Should NOT reset main
    expect(calls.some((c: string) => c.includes("git reset --hard"))).toBe(false);
  });

  it("falls back to local review when gh pr create fails", async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("branch --show-current")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse --abbrev-ref")) return Buffer.from("main\n");
      if (cmd.includes("cat-file -p HEAD")) return Buffer.from("parent abc123\n");
      if (cmd.includes("gh pr create")) throw new Error("gh: not found");
      return Buffer.from("");
    });

    const { handleReview } = await import("../commands/review.js");

    // Should not throw — falls back to local review
    await expect(
      handleReview("http://localhost:8787", "test-key", undefined, undefined, "HEAD~1..HEAD", "claude", true)
    ).resolves.not.toThrow();
  });
});
