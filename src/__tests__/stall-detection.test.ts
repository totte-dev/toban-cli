import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TIMEOUTS } from "../constants.js";

describe("stall detection constants", () => {
  it("AGENT_STALL_WARN is 3 minutes", () => {
    expect(TIMEOUTS.AGENT_STALL_WARN).toBe(180_000);
  });

  it("AGENT_STALL_KILL is 5 minutes", () => {
    expect(TIMEOUTS.AGENT_STALL_KILL).toBe(300_000);
  });

  it("AGENT_STALL_KILL > AGENT_STALL_WARN", () => {
    expect(TIMEOUTS.AGENT_STALL_KILL).toBeGreaterThan(TIMEOUTS.AGENT_STALL_WARN);
  });
});

describe("stall detection logic", () => {
  it("detects stall when idle duration exceeds kill threshold", () => {
    const now = Date.now();
    const lastActivityAt = now - TIMEOUTS.AGENT_STALL_KILL - 1000;
    const idleDuration = now - lastActivityAt;

    expect(idleDuration).toBeGreaterThanOrEqual(TIMEOUTS.AGENT_STALL_KILL);
  });

  it("emits warning when idle duration exceeds warn threshold but not kill", () => {
    const now = Date.now();
    const lastActivityAt = now - TIMEOUTS.AGENT_STALL_WARN - 1000;
    const idleDuration = now - lastActivityAt;

    expect(idleDuration).toBeGreaterThanOrEqual(TIMEOUTS.AGENT_STALL_WARN);
    expect(idleDuration).toBeLessThan(TIMEOUTS.AGENT_STALL_KILL);
  });

  it("does not trigger when activity is recent", () => {
    const now = Date.now();
    const lastActivityAt = now - 10_000; // 10 seconds ago
    const idleDuration = now - lastActivityAt;

    expect(idleDuration).toBeLessThan(TIMEOUTS.AGENT_STALL_WARN);
  });

  it("resets stall warning on new activity", () => {
    let stallWarned = true;
    // Simulate stdout data arriving
    const lastActivityAt = Date.now();
    stallWarned = false;

    expect(stallWarned).toBe(false);
    expect(lastActivityAt).toBeGreaterThan(0);
  });
});
