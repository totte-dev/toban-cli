import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  postMessage,
  readMessages,
  readRecentMessages,
  readMessagesSince,
  readMessagesByTopic,
  readMessagesByType,
  readMessagesFor,
  clearChannel,
  formatChannelMarkdown,
} from "../agent-channel.js";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ORIGINAL_HOME = process.env.HOME;
let testHome: string;

describe("AgentChannel", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "channel-test-"));
    process.env.HOME = testHome;
    clearChannel();
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("posts and reads structured messages", () => {
    postMessage({
      from: "builder-1",
      type: "info",
      topic: "task-abc123",
      to: "all",
      replyTo: null,
      content: "auth.ts refactoring in progress",
      task_id: "abc123",
      task_title: "Fix auth bug",
      sprint: 76,
    });

    const messages = readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("builder-1");
    expect(messages[0].type).toBe("info");
    expect(messages[0].topic).toBe("task-abc123");
    expect(messages[0].content).toBe("auth.ts refactoring in progress");
    expect(messages[0].id).toBeTruthy();
    expect(messages[0].ts).toBeTruthy();
  });

  it("auto-generates id and ts", () => {
    const msg = postMessage({
      from: "builder-1",
      type: "blocker",
      topic: "general",
      to: "all",
      replyTo: null,
      content: "stuck on migration",
      task_id: null,
      task_title: null,
      sprint: null,
    });

    expect(msg.id).toBeTruthy();
    expect(msg.id).not.toBe("legacy");
    expect(msg.ts).toBeTruthy();
  });

  it("reads recent messages with limit", () => {
    for (let i = 0; i < 10; i++) {
      postMessage({
        from: "builder-1",
        type: "progress",
        topic: "general",
        to: "all",
        replyTo: null,
        content: `msg ${i}`,
        task_id: null,
        task_title: null,
        sprint: null,
      });
    }

    const recent = readRecentMessages(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe("msg 7");
    expect(recent[2].content).toBe("msg 9");
  });

  it("reads messages since timestamp", () => {
    const t1 = "2026-03-22T10:00:00Z";
    const t2 = "2026-03-22T10:00:10Z";
    const t3 = "2026-03-22T10:00:20Z";

    postMessage({ from: "a", type: "info", topic: "general", to: "all", replyTo: null, content: "first", task_id: null, task_title: null, sprint: null, ts: t1 });
    postMessage({ from: "b", type: "info", topic: "general", to: "all", replyTo: null, content: "second", task_id: null, task_title: null, sprint: null, ts: t2 });
    postMessage({ from: "c", type: "info", topic: "general", to: "all", replyTo: null, content: "third", task_id: null, task_title: null, sprint: null, ts: t3 });

    const since = readMessagesSince(t1);
    expect(since).toHaveLength(2);
    expect(since[0].content).toBe("second");
    expect(since[1].content).toBe("third");
  });

  it("filters by topic", () => {
    postMessage({ from: "a", type: "info", topic: "task-abc", to: "all", replyTo: null, content: "task msg", task_id: "abc", task_title: null, sprint: null });
    postMessage({ from: "b", type: "info", topic: "general", to: "all", replyTo: null, content: "general msg", task_id: null, task_title: null, sprint: null });
    postMessage({ from: "c", type: "proposal", topic: "task-abc", to: "all", replyTo: null, content: "another task msg", task_id: "abc", task_title: null, sprint: null });

    const topicMsgs = readMessagesByTopic("task-abc");
    expect(topicMsgs).toHaveLength(2);
    expect(topicMsgs[0].content).toBe("task msg");
    expect(topicMsgs[1].content).toBe("another task msg");
  });

  it("filters by type", () => {
    postMessage({ from: "a", type: "blocker", topic: "general", to: "all", replyTo: null, content: "blocked!", task_id: null, task_title: null, sprint: null });
    postMessage({ from: "b", type: "info", topic: "general", to: "all", replyTo: null, content: "fyi", task_id: null, task_title: null, sprint: null });
    postMessage({ from: "c", type: "blocker", topic: "general", to: "all", replyTo: null, content: "also blocked", task_id: null, task_title: null, sprint: null });

    const blockers = readMessagesByType("blocker");
    expect(blockers).toHaveLength(2);
  });

  it("reads messages for specific agent", () => {
    postMessage({ from: "a", type: "request", topic: "general", to: "builder-2", replyTo: null, content: "hey builder-2", task_id: null, task_title: null, sprint: null });
    postMessage({ from: "b", type: "info", topic: "general", to: "all", replyTo: null, content: "broadcast", task_id: null, task_title: null, sprint: null });
    postMessage({ from: "c", type: "request", topic: "general", to: "builder-1", replyTo: null, content: "hey builder-1", task_id: null, task_title: null, sprint: null });

    const forBuilder2 = readMessagesFor("builder-2");
    expect(forBuilder2).toHaveLength(2); // direct + broadcast
    expect(forBuilder2[0].content).toBe("hey builder-2");
    expect(forBuilder2[1].content).toBe("broadcast");
  });

  it("migrates old format (text field) to new format (content field)", () => {
    // Write a legacy format message directly to the channel file
    const channelDir = join(testHome, ".toban", "channel");
    mkdirSync(channelDir, { recursive: true });
    const messagesFile = join(channelDir, "messages.jsonl");
    const legacyMsg = JSON.stringify({
      from: "builder-1",
      task_id: "abc",
      task_title: "Fix auth",
      sprint: 76,
      text: "old format message",
      ts: "2026-03-22T10:00:00Z",
    });
    appendFileSync(messagesFile, legacyMsg + "\n", "utf-8");

    const messages = readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("old format message");
    expect(messages[0].type).toBe("info");
    expect(messages[0].topic).toBe("task-abc");
    expect(messages[0].to).toBe("all");
    expect(messages[0].id).toBe("legacy");
  });

  it("clears channel", () => {
    postMessage({ from: "a", type: "info", topic: "general", to: "all", replyTo: null, content: "hello", task_id: null, task_title: null, sprint: null });
    expect(readMessages()).toHaveLength(1);
    clearChannel();
    expect(readMessages()).toHaveLength(0);
  });

  it("formats markdown grouped by topic", () => {
    const messages = [
      { id: "1", from: "builder-1", type: "blocker" as const, topic: "task-abc", to: "all", replyTo: null, content: "DB migration fails", task_id: "abc", task_title: "Fix auth", sprint: 76, ts: "2026-03-22T10:00:00Z" },
      { id: "2", from: "builder-2", type: "info" as const, topic: "general", to: "all", replyTo: null, content: "starting work", task_id: "def", task_title: "Add login", sprint: 76, ts: "2026-03-22T10:00:15Z" },
      { id: "3", from: "reviewer", type: "review" as const, topic: "task-abc", to: "builder-1", replyTo: "1", content: "try rolling back", task_id: null, task_title: null, sprint: 76, ts: "2026-03-22T10:01:00Z" },
    ];

    const md = formatChannelMarkdown(messages);
    expect(md).toContain("## task-abc");
    expect(md).toContain("## general");
    expect(md).toContain("[BLOCKER]");
    expect(md).toContain("[REVIEW]");
    expect(md).toContain("→ @builder-1");
    expect(md).toContain("(re:1)");
    expect(md).toContain("DB migration fails");
  });

  it("formats empty channel", () => {
    const md = formatChannelMarkdown([]);
    expect(md).toContain("No messages yet");
  });
});
