import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelMonitor } from "../channel-monitor.js";
import { postMessage, clearChannel } from "../agent-channel.js";

describe("ChannelMonitor", () => {
  beforeEach(() => {
    clearChannel();
  });

  it("detects blocker messages and returns notify action", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "builder-1", type: "blocker", topic: "task-abc",
      to: "all", replyTo: null, content: "npm registry timeout",
      task_id: "abc", task_title: "Setup", sprint: 1,
    });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("notify");
    expect(actions[0].message.type).toBe("blocker");
    expect(actions[0].description).toContain("builder-1");
  });

  it("detects request messages and returns create_task action", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "builder-2", type: "request", topic: "general",
      to: "builder-1", replyTo: null, content: "Avoid editing utils.ts",
      task_id: null, task_title: null, sprint: 1,
    });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("create_task");
    expect(actions[0].data?.target).toBe("builder-1");
  });

  it("detects review messages and returns create_task action", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "reviewer", type: "review", topic: "task-abc",
      to: "builder-1", replyTo: null, content: "Missing error handling",
      task_id: null, task_title: null, sprint: 1,
    });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("create_task");
    expect(actions[0].data?.reviewedBy).toBe("reviewer");
  });

  it("detects decision messages and returns log_only action", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "strategist", type: "decision", topic: "architecture",
      to: "all", replyTo: null, content: "Use repository pattern",
      task_id: null, task_title: null, sprint: 1,
    });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("log_only");
  });

  it("ignores info, progress, and opinion messages", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({ from: "b1", type: "info", topic: "g", to: "all", replyTo: null, content: "fyi", task_id: null, task_title: null, sprint: 1 });
    postMessage({ from: "b2", type: "progress", topic: "g", to: "all", replyTo: null, content: "working", task_id: null, task_title: null, sprint: 1 });
    postMessage({ from: "b3", type: "opinion", topic: "g", to: "all", replyTo: null, content: "I agree", task_id: null, task_title: null, sprint: 1 });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(0);
  });

  it("ignores orchestrator's own messages", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "orchestrator", type: "blocker", topic: "general",
      to: "all", replyTo: null, content: "test",
      task_id: null, task_title: null, sprint: 1,
    });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(0);
  });

  it("does not process same message twice", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({
      from: "builder-1", type: "blocker", topic: "general",
      to: "all", replyTo: null, content: "stuck",
      task_id: null, task_title: null, sprint: 1,
    });

    const first = monitor.processNewMessages();
    expect(first).toHaveLength(1);

    const second = monitor.processNewMessages();
    expect(second).toHaveLength(0);
  });

  it("handles multiple messages in one poll", () => {
    const monitor = new ChannelMonitor("2000-01-01T00:00:00Z");

    postMessage({ from: "b1", type: "blocker", topic: "g", to: "all", replyTo: null, content: "blocked", task_id: null, task_title: null, sprint: 1 });
    postMessage({ from: "b2", type: "request", topic: "g", to: "b1", replyTo: null, content: "help", task_id: null, task_title: null, sprint: 1 });
    postMessage({ from: "b3", type: "progress", topic: "g", to: "all", replyTo: null, content: "ok", task_id: null, task_title: null, sprint: 1 });

    const actions = monitor.processNewMessages();
    expect(actions).toHaveLength(2); // blocker + request, progress ignored
  });
});
