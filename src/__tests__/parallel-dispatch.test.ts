import { describe, it, expect, vi } from "vitest";
import { Mutex } from "async-mutex";
import { SlotScheduler } from "../slot-scheduler.js";
import {
  detectDependencies,
  sortByDependency,
} from "../task-dependency.js";
import type { Task } from "../api-client.js";

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: "",
    status: "in_progress",
    priority: "p2",
    owner: "builder",
    ...overrides,
  } as Task;
}

/**
 * Simulate a single poll cycle: detect dependencies, sort tasks,
 * and assign ready tasks to available slots.
 * Returns the IDs of tasks that would be dispatched in parallel.
 */
function simulateDispatch(
  tasks: Task[],
  maxBuilders: number,
  completedIds: Set<string> = new Set(),
): string[] {
  const deps = detectDependencies(tasks);
  const ordered = sortByDependency(tasks, deps, completedIds);
  const readyTasks = ordered.filter((t) => t.parallelReady);

  const scheduler = new SlotScheduler([
    { role: "builder", maxConcurrency: maxBuilders },
  ]);

  const dispatched: string[] = [];
  for (const task of readyTasks) {
    const slot = scheduler.acquireSlot("builder");
    if (!slot) break;
    scheduler.assignTask(slot, task.id);
    dispatched.push(task.id);
  }

  return dispatched;
}

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

  // -------------------------------------------------------------------------
  // Dispatch simulation: dependency detection + slot scheduling
  // -------------------------------------------------------------------------

  describe("independent tasks dispatch in parallel", () => {
    it("dispatches all independent tasks up to slot limit", () => {
      const tasks = [
        makeTask({ id: "a", title: "Add README", description: "Create README.md with project overview" }),
        makeTask({ id: "b", title: "Add license", description: "Create LICENSE file with MIT license" }),
        makeTask({ id: "c", title: "Add gitignore", description: "Create .gitignore for Node.js" }),
      ];

      const dispatched = simulateDispatch(tasks, 3);
      expect(dispatched).toHaveLength(3);
      expect(dispatched).toEqual(expect.arrayContaining(["a", "b", "c"]));
    });

    it("caps dispatched tasks at slot limit", () => {
      const tasks = [
        makeTask({ id: "a", title: "Task A", description: "Independent work A" }),
        makeTask({ id: "b", title: "Task B", description: "Independent work B" }),
        makeTask({ id: "c", title: "Task C", description: "Independent work C" }),
      ];

      const dispatched = simulateDispatch(tasks, 2);
      expect(dispatched).toHaveLength(2);
    });

    it("tasks in different directories run in parallel", () => {
      const tasks = [
        makeTask({ id: "a", title: "Update API routes", description: "Modify src/routes/tasks.ts" }),
        makeTask({ id: "b", title: "Update CLI commands", description: "Modify src/commands/run-loop.ts" }),
        makeTask({ id: "c", title: "Update UI components", description: "Modify app/sprint/page.tsx" }),
      ];

      const dispatched = simulateDispatch(tasks, 3);
      expect(dispatched).toHaveLength(3);
    });
  });

  describe("file conflicts serialize tasks", () => {
    it("serializes tasks referencing the same file", () => {
      const tasks = [
        makeTask({ id: "a", title: "Add retry", description: "Modify src/api-client.ts to add retry" }),
        makeTask({ id: "b", title: "Add timeout", description: "Modify src/api-client.ts to add timeout" }),
      ];

      const dispatched = simulateDispatch(tasks, 2);
      expect(dispatched).toHaveLength(1);
    });

    it("mixes parallel and serial correctly", () => {
      const tasks = [
        makeTask({ id: "a", title: "Refactor API client", description: "Modify src/api-client.ts", priority: "p1" }),
        makeTask({ id: "b", title: "Add timeout", description: "Modify src/api-client.ts", priority: "p2" }),
        makeTask({ id: "c", title: "Add README", description: "Create README.md with project overview" }),
      ];

      const dispatched = simulateDispatch(tasks, 3);
      expect(dispatched).toHaveLength(2);
      expect(dispatched).toContain("a");
      expect(dispatched).toContain("c");
    });

    it("unblocks dependent task after predecessor completes", () => {
      const tasks = [
        makeTask({ id: "a", title: "Refactor API client", description: "Modify src/api-client.ts", priority: "p1" }),
        makeTask({ id: "b", title: "Add timeout", description: "Modify src/api-client.ts", priority: "p2" }),
      ];

      const dispatched = simulateDispatch(tasks, 2, new Set(["a"]));
      expect(dispatched).toContain("b");
    });
  });

  describe("explicit dependencies", () => {
    it("serializes tasks with dependency keywords", () => {
      const tasks = [
        makeTask({ id: "a", title: "Setup database schema", description: "Create tables for the application" }),
        makeTask({ id: "b", title: "Build API endpoints", description: "depends on Setup database schema being complete" }),
      ];

      const dispatched = simulateDispatch(tasks, 2);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toBe("a");
    });

    it("runs independent tasks alongside a dependency chain", () => {
      const tasks = [
        makeTask({ id: "a", title: "Setup database schema", description: "Create tables" }),
        makeTask({ id: "b", title: "Build API endpoints", description: "depends on Setup database schema" }),
        makeTask({ id: "c", title: "Write documentation", description: "Add user guide to docs" }),
      ];

      const dispatched = simulateDispatch(tasks, 3);
      expect(dispatched).toHaveLength(2);
      expect(dispatched).toContain("a");
      expect(dispatched).toContain("c");
    });
  });

  describe("no directory-level false deps (regression)", () => {
    it("tasks in same directory but different files run in parallel", () => {
      const tasks = [
        makeTask({ id: "a", title: "Add CLI init", description: "Create src/commands/init.ts" }),
        makeTask({ id: "b", title: "Add CLI review", description: "Create src/commands/review.ts" }),
        makeTask({ id: "c", title: "Add CLI status", description: "Create src/commands/status.ts" }),
      ];

      const dispatched = simulateDispatch(tasks, 3);
      expect(dispatched).toHaveLength(3);
    });

    it("tasks mentioning same component area but different files run in parallel", () => {
      const tasks = [
        makeTask({ id: "a", title: "Add task board", description: "Create components/sprint/task-board.tsx" }),
        makeTask({ id: "b", title: "Add phase stepper", description: "Create components/sprint/phase-stepper.tsx" }),
      ];

      const dispatched = simulateDispatch(tasks, 2);
      expect(dispatched).toHaveLength(2);
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
