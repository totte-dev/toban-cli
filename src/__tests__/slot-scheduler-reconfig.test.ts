import { describe, it, expect } from "vitest";
import { SlotScheduler } from "../services/slot-scheduler.js";

describe("SlotScheduler.reconfigure", () => {
  it("increases concurrency by adding new slots", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 1 },
    ]);
    expect(scheduler.getSlots()).toHaveLength(1);

    scheduler.reconfigure("builder", 3);

    const slots = scheduler.getSlots().filter((s) => s.role === "builder");
    expect(slots).toHaveLength(3);
    expect(scheduler.getMaxConcurrency("builder")).toBe(3);
  });

  it("decreases concurrency by removing idle slots", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 3 },
    ]);
    expect(scheduler.getSlots().filter((s) => s.role === "builder")).toHaveLength(3);

    scheduler.reconfigure("builder", 1);

    const slots = scheduler.getSlots().filter((s) => s.role === "builder");
    expect(slots).toHaveLength(1);
  });

  it("does not remove running slots", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 3 },
    ]);

    // Assign tasks to 2 slots
    const slot1 = scheduler.acquireSlot("builder")!;
    scheduler.assignTask(slot1, "task-1");
    const slot2 = scheduler.acquireSlot("builder")!;
    scheduler.assignTask(slot2, "task-2");

    // Try to reduce to 1 — only the idle slot should be removed
    scheduler.reconfigure("builder", 1);

    const slots = scheduler.getSlots().filter((s) => s.role === "builder");
    expect(slots.length).toBe(2); // 2 running can't be removed
  });

  it("no-ops when concurrency is unchanged", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 2 },
    ]);

    scheduler.reconfigure("builder", 2);

    expect(scheduler.getSlots().filter((s) => s.role === "builder")).toHaveLength(2);
  });

  it("getMaxConcurrency returns updated value", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 1 },
    ]);
    expect(scheduler.getMaxConcurrency("builder")).toBe(1);

    scheduler.reconfigure("builder", 5);
    expect(scheduler.getMaxConcurrency("builder")).toBe(5);
  });

  it("getMaxConcurrency returns 0 for unknown role", () => {
    const scheduler = new SlotScheduler([]);
    expect(scheduler.getMaxConcurrency("unknown")).toBe(0);
  });

  it("reconfigures multiple roles independently", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 2 },
      { role: "cloud-engineer", maxConcurrency: 1 },
    ]);

    scheduler.reconfigure("builder", 3);
    scheduler.reconfigure("cloud-engineer", 2);

    expect(scheduler.getSlots().filter((s) => s.role === "builder")).toHaveLength(3);
    expect(scheduler.getSlots().filter((s) => s.role === "cloud-engineer")).toHaveLength(2);
  });
});

describe("SlotScheduler plan-limits integration", () => {
  it("free tier: 1 builder, 1 cloud-engineer", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 2 },
      { role: "cloud-engineer", maxConcurrency: 1 },
    ]);

    // Simulate free plan limits
    const limits = { max_builders: 1, max_cloud_engineers: 1 };
    scheduler.reconfigure("builder", limits.max_builders);
    scheduler.reconfigure("cloud-engineer", limits.max_cloud_engineers);

    expect(scheduler.getSlots().filter((s) => s.role === "builder")).toHaveLength(1);
    expect(scheduler.getSlots().filter((s) => s.role === "cloud-engineer")).toHaveLength(1);
  });

  it("pro tier: 3 builders, 1 cloud-engineer", () => {
    const scheduler = new SlotScheduler([
      { role: "builder", maxConcurrency: 2 },
      { role: "cloud-engineer", maxConcurrency: 1 },
    ]);

    // Simulate pro plan limits
    const limits = { max_builders: 3, max_cloud_engineers: 1 };
    scheduler.reconfigure("builder", limits.max_builders);
    scheduler.reconfigure("cloud-engineer", limits.max_cloud_engineers);

    expect(scheduler.getSlots().filter((s) => s.role === "builder")).toHaveLength(3);
    expect(scheduler.acquireSlot("builder")).not.toBeNull();
  });
});
