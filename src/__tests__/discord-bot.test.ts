import { describe, it, expect } from "vitest";
import { splitMessage } from "../discord-bot.js";

describe("splitMessage", () => {
  it("returns single chunk when text fits", () => {
    const result = splitMessage("hello world", 2000);
    expect(result).toEqual(["hello world"]);
  });

  it("splits at newline boundary when possible", () => {
    const line = "a".repeat(90);
    const text = `${line}\n${line}\n${line}`;
    const result = splitMessage(text, 200);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be within limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // Concatenated chunks should equal original (minus stripped newlines)
    expect(result.join("\n")).toBe(text);
  });

  it("hard-splits when no newline is found", () => {
    const text = "a".repeat(500);
    const result = splitMessage(text, 200);
    expect(result.length).toBe(3);
    expect(result[0].length).toBe(200);
    expect(result[1].length).toBe(200);
    expect(result[2].length).toBe(100);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });
});
