import { describe, it, expect, beforeEach } from "vitest";
import { trackRetry, clearRetry } from "../utils/retry-tracker.js";

describe("retry-tracker", () => {
  // Each test uses a unique key to avoid cross-test interference
  // (retry-tracker is in-memory singleton)

  describe("trackRetry", () => {
    it("returns retryCount=1 and maxed=false on first call", () => {
      const { retryCount, maxed } = trackRetry("test-first-call");
      expect(retryCount).toBe(1);
      expect(maxed).toBe(false);
    });

    it("increments retryCount on successive calls", () => {
      const key = "test-increment";
      const r1 = trackRetry(key);
      const r2 = trackRetry(key);
      expect(r1.retryCount).toBe(1);
      expect(r2.retryCount).toBe(2);
    });

    it("returns maxed=true when retryCount reaches maxRetries (default=3)", () => {
      const key = "test-default-max";
      trackRetry(key); // 1
      trackRetry(key); // 2
      const r3 = trackRetry(key); // 3
      expect(r3.retryCount).toBe(3);
      expect(r3.maxed).toBe(true);
    });

    it("returns maxed=false at count just below max", () => {
      const key = "test-below-max";
      trackRetry(key); // 1
      const r2 = trackRetry(key); // 2
      expect(r2.retryCount).toBe(2);
      expect(r2.maxed).toBe(false);
    });

    it("respects custom maxRetries", () => {
      const key = "test-custom-max";
      const r1 = trackRetry(key, 1);
      expect(r1.retryCount).toBe(1);
      expect(r1.maxed).toBe(true);
    });

    it("continues counting past maxed", () => {
      const key = "test-past-max";
      trackRetry(key); // 1
      trackRetry(key); // 2
      trackRetry(key); // 3 (maxed)
      const r4 = trackRetry(key); // 4
      expect(r4.retryCount).toBe(4);
      expect(r4.maxed).toBe(true);
    });
  });

  describe("clearRetry", () => {
    it("resets count so next trackRetry starts at 1", () => {
      const key = "test-clear";
      trackRetry(key); // 1
      trackRetry(key); // 2
      clearRetry(key);
      const r = trackRetry(key);
      expect(r.retryCount).toBe(1);
      expect(r.maxed).toBe(false);
    });

    it("does not throw when clearing a key that was never tracked", () => {
      expect(() => clearRetry("nonexistent-key")).not.toThrow();
    });
  });
});
