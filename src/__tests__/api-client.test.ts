import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApiClient } from "../api-client.js";

const API_URL = "https://api.example.com";
const API_KEY = "test-key";

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("createApiClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchTasks", () => {
    it("returns array when API returns array directly", async () => {
      const tasks = [{ id: "1", title: "Task 1", status: "todo" }];
      globalThis.fetch = mockFetchResponse(tasks);

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchTasks();

      expect(result).toEqual(tasks);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_URL}/api/v1/tasks`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${API_KEY}`,
          }),
        })
      );
    });

    it("returns array when API returns {tasks:[]} format", async () => {
      const tasks = [{ id: "2", title: "Task 2", status: "done" }];
      globalThis.fetch = mockFetchResponse({ tasks });

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchTasks();

      expect(result).toEqual(tasks);
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 500);

      const client = createApiClient(API_URL, API_KEY);
      await expect(client.fetchTasks()).rejects.toThrow("Failed to fetch tasks");
    });
  });

  describe("fetchWorkspace", () => {
    it("returns workspace info", async () => {
      const workspace = {
        id: "ws-1",
        name: "My Workspace",
        github_repo: "org/repo",
        github_org: "org",
        language: "typescript",
        terminal_emulator: null,
      };
      globalThis.fetch = mockFetchResponse(workspace);

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchWorkspace();

      expect(result).toEqual(workspace);
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 404);

      const client = createApiClient(API_URL, API_KEY);
      await expect(client.fetchWorkspace()).rejects.toThrow(
        "Failed to fetch workspace"
      );
    });
  });

  describe("updateTask", () => {
    it("calls PATCH with correct URL and body", async () => {
      globalThis.fetch = mockFetchResponse({});

      const client = createApiClient(API_URL, API_KEY);
      await client.updateTask("task-123", { status: "in_progress" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_URL}/api/v1/tasks/task-123`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "in_progress" }),
        })
      );
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 400);

      const client = createApiClient(API_URL, API_KEY);
      await expect(
        client.updateTask("task-123", { status: "done" })
      ).rejects.toThrow("Failed to update task task-123");
    });
  });

  describe("non-fatal methods", () => {
    it("updateAgent does not throw on failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const client = createApiClient(API_URL, API_KEY);
      // Should not throw
      await expect(
        client.updateAgent({ name: "builder", status: "idle" })
      ).resolves.toBeUndefined();
    });

    it("sendMessage does not throw on failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const client = createApiClient(API_URL, API_KEY);
      await expect(
        client.sendMessage("builder", "user", "hello")
      ).resolves.toBeUndefined();
    });

    it("fetchMessages returns empty array on failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchMessages("builder");
      expect(result).toEqual([]);
    });
  });
});
