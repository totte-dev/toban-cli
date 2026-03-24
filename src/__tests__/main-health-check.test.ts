import { describe, it, expect, vi, beforeEach } from "vitest";
import { runHealthCheck } from "../utils/main-health-check.js";

const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

// Silence ui output during tests
vi.mock("../ui.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const REPO_DIR = "/tmp/test-repo";

/** Default: repo dir exists, no package.json */
function mockRepoExists(hasPackageJson = false, packageJson?: object) {
  existsSyncMock.mockImplementation((p: string) => {
    if (p === REPO_DIR) return true;
    if (p.endsWith("package.json")) return hasPackageJson;
    return false;
  });
  if (hasPackageJson && packageJson) {
    readFileSyncMock.mockReturnValue(JSON.stringify(packageJson));
  }
}

describe("runHealthCheck", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it("returns passed=true when build and test both succeed", () => {
    mockRepoExists(true, { scripts: { test: "npm test" } });
    execSyncMock.mockReturnValue(Buffer.from("ok"));

    const result = runHealthCheck(REPO_DIR, "npm run build", "npm test");

    expect(result.passed).toBe(true);
    const cmds = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(cmds).toContain("npm run build");
    expect(cmds).toContain("npm test");
  });

  it("returns passed=false with details when build fails", () => {
    mockRepoExists();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm run build") {
        throw Object.assign(new Error("build failed"), {
          stderr: Buffer.from("src/foo.ts(1,1): error TS2322"),
          stdout: Buffer.from(""),
          status: 1,
        });
      }
      return Buffer.from("ok");
    });

    const result = runHealthCheck(REPO_DIR, "npm run build", "npm test");

    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe("npm run build");
    expect(result.errorDetail).toContain("TS2322");
    // Test command should not be called after build failure
    const cmds = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(cmds).not.toContain("npm test");
  });

  it("returns passed=false with details when tests fail", () => {
    mockRepoExists(true, { scripts: { test: "npm test" } });
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "npm test") {
        throw Object.assign(new Error("tests failed"), {
          stderr: Buffer.from(""),
          stdout: Buffer.from("FAIL src/foo.test.ts — expected true to be false"),
          status: 1,
        });
      }
      return Buffer.from("ok");
    });

    const result = runHealthCheck(REPO_DIR, "npm run build", "npm test");

    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe("npm test");
    expect(result.errorDetail).toContain("expected true to be false");
  });

  it("skips test command when package.json has no test script", () => {
    mockRepoExists(true, { scripts: { build: "tsc" } });
    execSyncMock.mockReturnValue(Buffer.from("ok"));

    const result = runHealthCheck(REPO_DIR, "npm run build", "npm test");

    expect(result.passed).toBe(true);
    const cmds = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(cmds).toContain("npm run build");
    expect(cmds).not.toContain("npm test");
  });

  it("runs test command when package.json has a test script", () => {
    mockRepoExists(true, { scripts: { test: "vitest run" } });
    execSyncMock.mockReturnValue(Buffer.from("ok"));

    const result = runHealthCheck(REPO_DIR, "npm run build", "npm test");

    expect(result.passed).toBe(true);
    const cmds = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(cmds).toContain("npm run build");
    expect(cmds).toContain("npm test");
  });

  it("skips health check and returns passed=true when repo dir does not exist", () => {
    existsSyncMock.mockReturnValue(false);

    const result = runHealthCheck("/nonexistent", "npm run build", "npm test");

    expect(result.passed).toBe(true);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("uses custom build and test commands when provided", () => {
    mockRepoExists();
    execSyncMock.mockReturnValue(Buffer.from("ok"));

    const result = runHealthCheck(REPO_DIR, "make build", "make test");

    expect(result.passed).toBe(true);
    const cmds = execSyncMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(cmds).toContain("make build");
    expect(cmds).toContain("make test");
  });
});
