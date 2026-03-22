import { describe, it, expect } from "vitest";
import { detectContext } from "../utils/telemetry-sync.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "telemetry-test-"));
}

describe("detectContext", () => {
  it("detects typescript from package.json", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      dependencies: {},
      devDependencies: { typescript: "^5.0.0" },
    }));
    const ctx = detectContext(dir);
    expect(ctx).toContain("typescript");
  });

  it("detects react + nextjs", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      dependencies: { react: "^18.0.0", next: "^14.0.0" },
    }));
    const ctx = detectContext(dir);
    expect(ctx).toContain("react");
    expect(ctx).toContain("nextjs");
  });

  it("detects python from requirements.txt", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "requirements.txt"), "flask==2.0\n");
    const ctx = detectContext(dir);
    expect(ctx).toContain("python");
  });

  it("detects go from go.mod", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/app\ngo 1.21\n");
    const ctx = detectContext(dir);
    expect(ctx).toContain("go");
  });

  it("returns empty string for empty directory", () => {
    const dir = makeTmpDir();
    const ctx = detectContext(dir);
    expect(ctx).toBe("");
  });

  it("detects testing tools", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
    }));
    const ctx = detectContext(dir);
    expect(ctx).toContain("testing");
  });
});
