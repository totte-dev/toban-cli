/**
 * SlotScheduler — manages concurrent agent slots per role.
 *
 * Each role (builder, cloud-engineer) has N slots. Tasks are assigned
 * to available slots. When all slots are busy, new tasks wait.
 */

export interface SlotConfig {
  role: string;
  maxConcurrency: number;
}

export interface Slot {
  name: string;
  role: string;
  taskId: string | null;
  status: "idle" | "running" | "finishing";
}

export class SlotScheduler {
  private slots: Map<string, Slot> = new Map();
  private configs: Map<string, number> = new Map();

  constructor(configs: SlotConfig[]) {
    for (const cfg of configs) {
      this.configs.set(cfg.role, cfg.maxConcurrency);
      for (let i = 1; i <= cfg.maxConcurrency; i++) {
        const name = cfg.maxConcurrency === 1 ? cfg.role : `${cfg.role}-${i}`;
        this.slots.set(name, {
          name,
          role: cfg.role,
          taskId: null,
          status: "idle",
        });
      }
    }
  }

  /** Try to acquire an idle slot for a role. Returns slot name or null. */
  acquireSlot(role: string): string | null {
    for (const [, slot] of this.slots) {
      if (slot.role === role && slot.status === "idle") {
        return slot.name;
      }
    }
    return null;
  }

  /** Assign a task to a slot. */
  assignTask(slotName: string, taskId: string): void {
    const slot = this.slots.get(slotName);
    if (!slot) throw new Error(`Unknown slot: ${slotName}`);
    slot.taskId = taskId;
    slot.status = "running";
  }

  /** Release a slot after task completion. */
  releaseSlot(slotName: string): void {
    const slot = this.slots.get(slotName);
    if (!slot) return;
    slot.taskId = null;
    slot.status = "idle";
  }

  /** Check if a task is already assigned to any slot. */
  isTaskAssigned(taskId: string): boolean {
    for (const [, slot] of this.slots) {
      if (slot.taskId === taskId) return true;
    }
    return false;
  }

  /** Count running slots for a role. */
  runningCount(role: string): number {
    let count = 0;
    for (const [, slot] of this.slots) {
      if (slot.role === role && slot.status !== "idle") count++;
    }
    return count;
  }

  /** Get all slots. */
  getSlots(): Slot[] {
    return Array.from(this.slots.values());
  }

  /** Get slot by name. */
  getSlot(name: string): Slot | undefined {
    return this.slots.get(name);
  }
}
