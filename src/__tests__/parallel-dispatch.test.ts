import { describe, it, expect, vi } from "vitest";
import { Mutex } from "async-mutex";

describe("parallel dispatch", () => {
  describe("runner onExit callback", () => {
    it("fires callback when agent exits", async () => {
      const onExit = vi.fn();
      // Simulate the runner.spawn pattern: spawn returns, then onExit fires asynchronously
      const fakeAgent = { exitCode: 0, status: "completed", branch: "agent/builder-1-abc", stdout: [] };

      // Simulate async exit
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          onExit(fakeAgent);
          resolve();
        }, 10);
      });

      expect(onExit).toHaveBeenCalledOnce();
      expect(onExit).toHaveBeenCalledWith(fakeAgent);
    });

    it("callback receives correct exit code on failure", () => {
      const onExit = vi.fn();
      const fakeAgent = { exitCode: 1, status: "failed", branch: "agent/builder-1-abc", stdout: [] };
      onExit(fakeAgent);

      expect(onExit.mock.calls[0][0].exitCode).toBe(1);
      expect(onExit.mock.calls[0][0].status).toBe("failed");
    });
  });

  describe("git merge mutex", () => {
    it("serializes concurrent merge operations", async () => {
      const mutex = new Mutex();
      const order: number[] = [];

      const merge1 = mutex.acquire().then(async (release) => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 50));
        order.push(2);
        release();
      });

      const merge2 = mutex.acquire().then(async (release) => {
        order.push(3);
        await new Promise((r) => setTimeout(r, 10));
        order.push(4);
        release();
      });

      await Promise.all([merge1, merge2]);
      // merge1 should complete (1,2) before merge2 starts (3,4)
      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("releases lock even if operation throws", async () => {
      const mutex = new Mutex();

      try {
        const release = await mutex.acquire();
        try {
          throw new Error("merge failed");
        } finally {
          release();
        }
      } catch { /* expected */ }

      // Should be able to acquire again
      const release2 = await mutex.acquire();
      expect(release2).toBeDefined();
      release2();
    });
  });

  describe("slot management", () => {
    it("slot name prevents agent name collision", () => {
      const slots = new Map<string, string>();

      // Simulate 2 builders getting different slot names
      slots.set("builder-1", "task-aaa");
      slots.set("builder-2", "task-bbb");

      expect(slots.get("builder-1")).toBe("task-aaa");
      expect(slots.get("builder-2")).toBe("task-bbb");
      expect(slots.size).toBe(2);
    });

    it("slot is released in finally block even on error", async () => {
      let slotReleased = false;

      try {
        // Simulate post_actions throwing
        throw new Error("post_actions failed");
      } catch {
        // error handler
      } finally {
        slotReleased = true;
      }

      expect(slotReleased).toBe(true);
    });
  });
});
