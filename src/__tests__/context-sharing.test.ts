/**
 * Tests for context-sharing handlers (fetch_recent_changes, record_changes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleFetchRecentChanges, handleRecordChanges } from "../handlers/context-sharing.js";
import type { ActionContext, TemplateAction } from "../agent-templates.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.startsWith("git diff --name-only")) return Buffer.from("src/foo.ts\nsrc/bar.ts");
    if (cmd.startsWith("git log -1")) return Buffer.from("feat: add new feature");
    return Buffer.from("");
  }),
}));

// Mock ui
vi.mock("../ui.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

function createMockCtx(overrides?: Partial<ActionContext>): ActionContext {
  const tmpDir = fs.mkdtempSync(path.join("/tmp", "ctx-sharing-test-"));
  // Write a basic CLAUDE.md
  fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test Project\n");

  return {
    api: {
      putAgentMemory: vi.fn(),
      fetchAgentMemories: vi.fn().mockResolvedValue([]),
    } as unknown as ActionContext["api"],
    task: { id: "abcd1234-5678-90ab-cdef-111111111111", title: "Test task", description: "desc", status: "in_progress", priority: "p2" },
    agentName: "builder-1",
    config: {
      apiUrl: "http://localhost:8787",
      apiKey: "tb_test",
      workingDir: tmpDir,
      baseBranch: "main",
    },
    template: undefined as unknown as ActionContext["template"],
    ...overrides,
  };
}

describe("handleFetchRecentChanges", () => {
  const action: TemplateAction = { type: "fetch_recent_changes", label: "Fetch recent changes" };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("injects recent changes into CLAUDE.md", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        memories: [
          { key: "agent-change-abcd1234", content: "feat: add login\nFiles: src/auth.ts", agent_name: "builder-2", type: "project" },
          { key: "agent-change-efgh5678", content: "fix: typo\nFiles: src/utils.ts", agent_name: "builder-3", type: "project" },
        ],
      }),
    });

    const ctx = createMockCtx();
    await handleFetchRecentChanges(action, ctx, "pre");

    const claudeMd = fs.readFileSync(path.join(ctx.config.workingDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("TOBAN_RECENT_CHANGES_START");
    expect(claudeMd).toContain("builder-2");
    expect(claudeMd).toContain("builder-3");
    expect(claudeMd).toContain("feat: add login");
    expect(claudeMd).toContain("fix: typo");
    expect(claudeMd).toContain("TOBAN_RECENT_CHANGES_END");
  });

  it("does nothing when no recent changes exist", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ memories: [] }),
    });

    const ctx = createMockCtx();
    await handleFetchRecentChanges(action, ctx, "pre");

    const claudeMd = fs.readFileSync(path.join(ctx.config.workingDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("TOBAN_RECENT_CHANGES_START");
  });

  it("does not fail when API returns error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const ctx = createMockCtx();
    // Should not throw
    await handleFetchRecentChanges(action, ctx, "pre");
  });

  it("replaces previous change block to avoid duplicates", async () => {
    const memories = [
      { key: "agent-change-new", content: "new change\nFiles: src/new.ts", agent_name: "builder-2", type: "project" },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ memories }),
    });

    const ctx = createMockCtx();
    // Run twice
    await handleFetchRecentChanges(action, ctx, "pre");
    await handleFetchRecentChanges(action, ctx, "pre");

    const claudeMd = fs.readFileSync(path.join(ctx.config.workingDir, "CLAUDE.md"), "utf-8");
    const matches = claudeMd.match(/TOBAN_RECENT_CHANGES_START/g);
    expect(matches).toHaveLength(1);
  });
});

describe("handleRecordChanges", () => {
  const action: TemplateAction = { type: "record_changes", label: "Record changes" };

  it("records change summary to shared memory", async () => {
    const ctx = createMockCtx();
    const putSpy = ctx.api.putAgentMemory as ReturnType<typeof vi.fn>;

    await handleRecordChanges(action, ctx, "post");

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(
      "builder-1",
      "agent-change-abcd1234",
      expect.objectContaining({
        type: "project",
        shared: true,
        tags: "agent-change",
      })
    );
    // Verify content includes commit message and files
    const content = putSpy.mock.calls[0][2].content as string;
    expect(content).toContain("feat: add new feature");
    expect(content).toContain("src/foo.ts");
  });
});
