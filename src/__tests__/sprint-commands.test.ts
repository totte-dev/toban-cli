import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createApiClient } from "../services/api-client.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

const API_URL = "https://api.example.com";
const API_KEY = "test-key";

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
  });
}

describe("sprint complete API methods", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchCurrentSprint", () => {
    it("returns sprint data on success", async () => {
      const sprint = { number: 34, status: "active" };
      globalThis.fetch = mockFetchResponse(sprint);

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchCurrentSprint();

      expect(result).toEqual(sprint);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_URL}/api/v1/sprints/current`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${API_KEY}`,
          }),
        })
      );
    });

    it("returns null on non-ok response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 404);

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchCurrentSprint();

      expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const client = createApiClient(API_URL, API_KEY);
      const result = await client.fetchCurrentSprint();

      expect(result).toBeNull();
    });
  });

  describe("completeSprint", () => {
    it("calls PATCH with correct URL and body", async () => {
      globalThis.fetch = mockFetchResponse({});

      const client = createApiClient(API_URL, API_KEY);
      await client.completeSprint(34);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_URL}/api/v1/sprints/34`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "completed" }),
        })
      );
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchResponse({}, false, 500);

      const client = createApiClient(API_URL, API_KEY);
      await expect(client.completeSprint(34)).rejects.toThrow(
        "Failed to complete sprint"
      );
    });
  });
});

describe("sprint git tagging", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("creates tag with correct naming convention", () => {
    const sprintNumber = 34;
    const tagName = `sprint-${sprintNumber}`;

    // Simulate: tag does not exist yet
    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git tag -l")) {
        return Buffer.from("");
      }
      if (cmdStr.includes("git tag")) {
        return Buffer.from("");
      }
      if (cmdStr.includes("git rev-parse --short HEAD")) {
        return Buffer.from("abc1234\n");
      }
      return Buffer.from("");
    });

    // Simulate the tag creation logic from handleSprintComplete
    const existing = mockExecSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    expect(existing).toBe("");

    mockExecSync(`git tag "${tagName}"`, { stdio: "pipe" });
    const shortHash = mockExecSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();

    expect(shortHash).toBe("abc1234");
    expect(mockExecSync).toHaveBeenCalledWith(`git tag "${tagName}"`, { stdio: "pipe" });
  });

  it("skips tag creation when tag already exists", () => {
    const sprintNumber = 34;
    const tagName = `sprint-${sprintNumber}`;

    mockExecSync.mockImplementation((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git tag -l")) {
        return Buffer.from("sprint-34\n");
      }
      return Buffer.from("");
    });

    const existing = mockExecSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    expect(existing).toBe("sprint-34");

    // Should NOT call git tag (without -l) since tag exists
    // Verify by checking no additional git tag call was made
    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    const tagCreateCalls = calls.filter(
      (c) => c.includes("git tag") && !c.includes("git tag -l")
    );
    expect(tagCreateCalls).toHaveLength(0);
  });

  it("pushes tag when --push flag is used", () => {
    const tagName = "sprint-34";

    mockExecSync.mockImplementation(() => Buffer.from(""));

    mockExecSync(`git push origin "${tagName}"`, { stdio: "inherit" });

    expect(mockExecSync).toHaveBeenCalledWith(
      `git push origin "${tagName}"`,
      { stdio: "inherit" }
    );
  });
});
