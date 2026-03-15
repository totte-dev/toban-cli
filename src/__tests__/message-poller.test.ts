import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessagePoller } from "../message-poller.js";
import type { ApiClient, Message } from "../api-client.js";

// Mock the ui module to suppress console output during tests
vi.mock("../ui.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock fs to avoid real file writes
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

function makeMessage(id: string, from: string, content: string, created_at: string): Message {
  return { id, from, to: "builder", content, read: false, created_at };
}

function makeMockApi(messages: Message[] = []): ApiClient {
  return {
    fetchMessages: vi.fn().mockResolvedValue(messages),
    fetchWorkspace: vi.fn(),
    fetchGitToken: vi.fn(),
    fetchTasks: vi.fn(),
    fetchRepositories: vi.fn(),
    startSprint: vi.fn(),
    updateTask: vi.fn(),
    updateAgent: vi.fn(),
    submitRetroComment: vi.fn(),
    reportProgress: vi.fn(),
    fetchPlaybookPrompt: vi.fn(),
    sendMessage: vi.fn(),
    fetchMySecrets: vi.fn(),
  } as unknown as ApiClient;
}

describe("MessagePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts polling and calls fetchMessages immediately", async () => {
    const api = makeMockApi([]);
    const poller = new MessagePoller({
      api,
      channel: "builder",
      workingDir: "/tmp/test",
    });

    poller.start();
    // The immediate poll is called synchronously in start()
    await vi.advanceTimersByTimeAsync(0);

    expect(api.fetchMessages).toHaveBeenCalledWith("builder");
    poller.stop();
  });

  it("stop() clears the interval", async () => {
    const api = makeMockApi([]);
    const poller = new MessagePoller({
      api,
      channel: "builder",
      workingDir: "/tmp/test",
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    // Advance past several poll intervals - no more calls should happen
    const callCount = (api.fetchMessages as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect((api.fetchMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
  });

  it("first poll marks existing messages as seen without writing", async () => {
    const { writeFileSync } = await import("node:fs");
    const existingMessages = [
      makeMessage("msg-1", "user", "Hello", "2026-03-15T00:00:00Z"),
      makeMessage("msg-2", "strategist", "Hi", "2026-03-15T00:01:00Z"),
    ];
    const api = makeMockApi(existingMessages);
    const poller = new MessagePoller({
      api,
      channel: "builder",
      workingDir: "/tmp/test",
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // writeFileSync should NOT have been called on first poll
    expect(writeFileSync).not.toHaveBeenCalled();
    poller.stop();
  });

  it("deduplicates messages - same ID not delivered twice", async () => {
    const { writeFileSync } = await import("node:fs");
    (writeFileSync as ReturnType<typeof vi.fn>).mockClear();

    const initialMessages = [
      makeMessage("msg-1", "user", "Hello", "2026-03-15T00:00:00Z"),
    ];
    const api = makeMockApi(initialMessages);
    const poller = new MessagePoller({
      api,
      channel: "builder",
      workingDir: "/tmp/test",
    });

    // First poll - marks msg-1 as seen
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // Second poll returns same msg-1 plus new msg-2
    const updatedMessages = [
      makeMessage("msg-1", "user", "Hello", "2026-03-15T00:00:00Z"),
      makeMessage("msg-2", "user", "New message", "2026-03-15T00:02:00Z"),
    ];
    (api.fetchMessages as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMessages);
    await vi.advanceTimersByTimeAsync(10_000);

    // Only msg-2 should have been written (msg-1 was already seen)
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(writtenContent).toContain("New message");
    expect(writtenContent).not.toContain("Hello\n\n### From");

    poller.stop();
  });
});
