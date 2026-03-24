import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PeerTracker } from "../channel/peer-tracker.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function createGitWorktree(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `peer-test-${name}-`));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com && git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test");
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("PeerTracker", () => {
  let tracker: PeerTracker;
  let dirs: string[] = [];

  beforeEach(() => {
    tracker = new PeerTracker();
  });

  afterEach(() => {
    tracker.stop();
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
    dirs = [];
  });

  it("registers and tracks peers", { timeout: 30_000 }, () => {
    const dir1 = createGitWorktree("a");
    const dir2 = createGitWorktree("b");
    dirs.push(dir1, dir2);

    tracker.register("builder-1", "task-aaa", "Add login", dir1);
    tracker.register("builder-2", "task-bbb", "Fix bug", dir2);

    const peers = tracker.getPeers();
    expect(peers).toHaveLength(2);
    expect(peers[0].name).toBe("builder-1");
    expect(peers[1].name).toBe("builder-2");
  });

  it("unregisters peers", () => {
    const dir = createGitWorktree("c");
    dirs.push(dir);

    tracker.register("builder-1", "task-aaa", "Add login", dir);
    expect(tracker.getPeers()).toHaveLength(1);

    tracker.unregister("builder-1");
    expect(tracker.getPeers()).toHaveLength(0);
  });

  it("writes .toban-peers.md to each agent worktree", { timeout: 30_000 }, () => {
    const dir1 = createGitWorktree("d");
    const dir2 = createGitWorktree("e");
    dirs.push(dir1, dir2);

    // Make changes in dir1 so git diff shows files
    writeFileSync(join(dir1, "src.ts"), "console.log('hello')");

    tracker.register("builder-1", "task-aaa", "Add login", dir1);
    tracker.register("builder-2", "task-bbb", "Fix bug", dir2);

    // Check that .toban-peers.md exists in dir2 (showing builder-1 as peer)
    const peersFile = join(dir2, ".toban-peers.md");
    expect(existsSync(peersFile)).toBe(true);

    const content = readFileSync(peersFile, "utf-8");
    expect(content).toContain("builder-1");
    expect(content).toContain("Add login");
    expect(content).toContain("src.ts");
    // Should not show itself
    expect(content).not.toContain("builder-2");
  });

  it("detects modified files via git diff", () => {
    const dir = createGitWorktree("f");
    dirs.push(dir);

    // Create a tracked file and modify it
    writeFileSync(join(dir, "app.ts"), "const x = 1;");
    execSync("git add app.ts && git commit -m 'add app'", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "app.ts"), "const x = 2;");

    tracker.register("builder-1", "task-aaa", "Modify app", dir);

    const peers = tracker.getPeers();
    expect(peers[0].files).toContain("app.ts");
  });

  it("shows no peers message when alone", () => {
    const dir = createGitWorktree("g");
    dirs.push(dir);

    tracker.register("builder-1", "task-aaa", "Solo task", dir);

    const peersFile = join(dir, ".toban-peers.md");
    if (existsSync(peersFile)) {
      const content = readFileSync(peersFile, "utf-8");
      expect(content).toContain("No other agents");
    }
  });
});
