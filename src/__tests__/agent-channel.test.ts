import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { postMessage, readMessages, readRecentMessages, clearChannel, formatChannelMarkdown } from "../agent-channel.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// Override channel dir for tests
const ORIGINAL_HOME = process.env.HOME;
let testHome: string;

describe("AgentChannel", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "channel-test-"));
    process.env.HOME = testHome;
    // Clear any cached state by clearing the channel
    clearChannel();
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("posts and reads messages", () => {
    postMessage({
      from: "builder-1",
      task_id: "abc123",
      task_title: "Fix auth bug",
      sprint: 76,
      text: "auth.ts refactoring in progress",
    });

    const messages = readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("builder-1");
    expect(messages[0].text).toBe("auth.ts refactoring in progress");
    expect(messages[0].task_title).toBe("Fix auth bug");
    expect(messages[0].ts).toBeTruthy();
  });

  it("reads recent messages with limit", () => {
    for (let i = 0; i < 10; i++) {
      postMessage({ from: "builder-1", task_id: null, task_title: null, sprint: null, text: `msg ${i}` });
    }

    const recent = readRecentMessages(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].text).toBe("msg 7");
    expect(recent[2].text).toBe("msg 9");
  });

  it("clears channel", () => {
    postMessage({ from: "builder-1", task_id: null, task_title: null, sprint: null, text: "hello" });
    expect(readMessages()).toHaveLength(1);

    clearChannel();
    expect(readMessages()).toHaveLength(0);
  });

  it("formats markdown with task context", () => {
    const messages = [
      { from: "builder-1", task_id: "abc", task_title: "Fix auth", sprint: 76, text: "working on auth.ts", ts: "2026-03-22T10:00:00Z" },
      { from: "builder-2", task_id: "def", task_title: "Add login", sprint: 76, text: "@builder-1 avoiding auth.ts", ts: "2026-03-22T10:00:15Z" },
    ];

    const md = formatChannelMarkdown(messages);
    expect(md).toContain("builder-1 | Fix auth");
    expect(md).toContain("builder-2 | Add login");
    expect(md).toContain("working on auth.ts");
    expect(md).toContain("@builder-1 avoiding auth.ts");
  });

  it("formats empty channel", () => {
    const md = formatChannelMarkdown([]);
    expect(md).toContain("No messages yet");
  });
});
