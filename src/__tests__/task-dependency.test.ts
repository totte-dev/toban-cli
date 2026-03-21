import { describe, it, expect } from "vitest";
import {
  extractPaths,
  pathsOverlap,
  detectDependencies,
  sortByDependency,
  type Dependency,
} from "../task-dependency.js";
import type { Task } from "../api-client.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: "Test task",
    description: "",
    status: "in_progress",
    priority: "p2",
    owner: "builder",
    ...overrides,
  } as Task;
}

// ---------------------------------------------------------------------------
// extractPaths
// ---------------------------------------------------------------------------

describe("extractPaths", () => {
  it("extracts TypeScript file paths", () => {
    const paths = extractPaths("Modify src/api-client.ts and src/commands/run-loop.ts");
    expect(paths).toContain("src/api-client.ts");
    expect(paths).toContain("src/commands/run-loop.ts");
  });

  it("extracts paths in backticks", () => {
    const paths = extractPaths("Edit `src/utils/parse-labels.ts`");
    expect(paths).toContain("src/utils/parse-labels.ts");
  });

  it("extracts directory paths", () => {
    const paths = extractPaths("Changes in src/commands/ and handlers/git-merge");
    expect(paths).toContain("src/commands/");
    expect(paths).toContain("handlers/git-merge");
  });

  it("ignores non-file strings", () => {
    const paths = extractPaths("This is just a plain text description with no file paths");
    expect(paths).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    expect(extractPaths("")).toHaveLength(0);
    expect(extractPaths(null as unknown as string)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pathsOverlap
// ---------------------------------------------------------------------------

describe("pathsOverlap", () => {
  it("detects same file overlap", () => {
    const result = pathsOverlap(["src/api-client.ts"], ["src/api-client.ts"]);
    expect(result).toContain("same file");
  });

  it("detects same directory overlap", () => {
    const result = pathsOverlap(["src/commands/run-loop.ts"], ["src/commands/setup.ts"]);
    expect(result).toContain("same directory");
  });

  it("returns null for no overlap", () => {
    const result = pathsOverlap(["src/api-client.ts"], ["src/commands/run-loop.ts"]);
    expect(result).toBeNull();
  });

  it("returns null for empty arrays", () => {
    expect(pathsOverlap([], [])).toBeNull();
    expect(pathsOverlap(["src/a.ts"], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDependencies
// ---------------------------------------------------------------------------

describe("detectDependencies", () => {
  it("detects explicit Japanese dependency keywords", () => {
    const taskA = makeTask({ id: "a", title: "API client refactor", description: "Refactor api-client.ts" });
    const taskB = makeTask({ id: "b", title: "Update tests", description: "API client refactorの後にテストを更新" });

    const deps = detectDependencies([taskA, taskB]);
    expect(deps.length).toBeGreaterThanOrEqual(1);
    const dep = deps.find((d) => d.to === "b" && d.from === "a");
    expect(dep).toBeDefined();
    expect(dep!.type).toBe("explicit");
  });

  it("detects explicit English dependency keywords", () => {
    const taskA = makeTask({ id: "a", title: "Setup database schema", description: "Create tables" });
    const taskB = makeTask({ id: "b", title: "API endpoints", description: "depends on Setup database schema" });

    const deps = detectDependencies([taskA, taskB]);
    const dep = deps.find((d) => d.to === "b" && d.from === "a");
    expect(dep).toBeDefined();
    expect(dep!.type).toBe("explicit");
  });

  it("detects file-based conflicts", () => {
    const taskA = makeTask({ id: "a", title: "Fix api client", description: "Modify src/api-client.ts" });
    const taskB = makeTask({ id: "b", title: "Add retry", description: "Add retry to src/api-client.ts" });

    const deps = detectDependencies([taskA, taskB]);
    const dep = deps.find((d) => d.type === "file_conflict");
    expect(dep).toBeDefined();
    expect(dep!.reason).toContain("api-client.ts");
  });

  it("higher priority task is the dependency source for file conflicts", () => {
    const taskA = makeTask({ id: "a", title: "Fix api client", description: "Modify src/api-client.ts", priority: "p1" });
    const taskB = makeTask({ id: "b", title: "Add retry", description: "Add retry to src/api-client.ts", priority: "p3" });

    const deps = detectDependencies([taskA, taskB]);
    const dep = deps.find((d) => d.type === "file_conflict");
    expect(dep).toBeDefined();
    expect(dep!.from).toBe("a"); // p1 goes first
    expect(dep!.to).toBe("b");
  });

  it("returns empty for independent tasks", () => {
    const taskA = makeTask({ id: "a", title: "Build frontend", description: "Create React components" });
    const taskB = makeTask({ id: "b", title: "Write API docs", description: "Document REST endpoints" });

    const deps = detectDependencies([taskA, taskB]);
    expect(deps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortByDependency
// ---------------------------------------------------------------------------

describe("sortByDependency", () => {
  it("puts dependency-free tasks first", () => {
    const taskA = makeTask({ id: "a", title: "Independent task", priority: "p2" });
    const taskB = makeTask({ id: "b", title: "Dependent task", priority: "p2" });

    const deps: Dependency[] = [{ from: "a", to: "b", reason: "test", type: "explicit" }];
    const result = sortByDependency([taskB, taskA], deps);

    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
    expect(result[0].parallelReady).toBe(true);
    expect(result[1].parallelReady).toBe(false);
    expect(result[1].dependsOn).toEqual(["a"]);
  });

  it("marks all tasks as parallelReady when no deps", () => {
    const taskA = makeTask({ id: "a", title: "Task A", priority: "p1" });
    const taskB = makeTask({ id: "b", title: "Task B", priority: "p2" });

    const result = sortByDependency([taskA, taskB], []);
    expect(result.every((t) => t.parallelReady)).toBe(true);
  });

  it("resolves completed dependencies", () => {
    const taskA = makeTask({ id: "a", title: "Task A" });
    const taskB = makeTask({ id: "b", title: "Task B" });

    const deps: Dependency[] = [{ from: "a", to: "b", reason: "test", type: "explicit" }];
    const completed = new Set(["a"]);
    const result = sortByDependency([taskA, taskB], deps, completed);

    // taskB should now be parallelReady since taskA is completed
    const taskBResult = result.find((t) => t.id === "b")!;
    expect(taskBResult.parallelReady).toBe(true);
    expect(taskBResult.dependsOn).toHaveLength(0);
  });

  it("handles circular dependencies gracefully", () => {
    const taskA = makeTask({ id: "a", title: "Task A" });
    const taskB = makeTask({ id: "b", title: "Task B" });

    const deps: Dependency[] = [
      { from: "a", to: "b", reason: "test", type: "explicit" },
      { from: "b", to: "a", reason: "test", type: "explicit" },
    ];

    // Should not throw, should include both tasks
    const result = sortByDependency([taskA, taskB], deps);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toContain("a");
    expect(result.map((t) => t.id)).toContain("b");
  });

  it("sorts by priority within same dependency level", () => {
    const taskA = makeTask({ id: "a", title: "Low priority", priority: "p3" });
    const taskB = makeTask({ id: "b", title: "High priority", priority: "p1" });
    const taskC = makeTask({ id: "c", title: "Medium priority", priority: "p2" });

    const result = sortByDependency([taskA, taskB, taskC], []);
    expect(result[0].id).toBe("b"); // p1
    expect(result[1].id).toBe("c"); // p2
    expect(result[2].id).toBe("a"); // p3
  });

  it("handles chain dependencies (A -> B -> C)", () => {
    const taskA = makeTask({ id: "a", title: "Step 1" });
    const taskB = makeTask({ id: "b", title: "Step 2" });
    const taskC = makeTask({ id: "c", title: "Step 3" });

    const deps: Dependency[] = [
      { from: "a", to: "b", reason: "chain", type: "explicit" },
      { from: "b", to: "c", reason: "chain", type: "explicit" },
    ];

    const result = sortByDependency([taskC, taskA, taskB], deps);
    const ids = result.map((t) => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));

    expect(result.find((t) => t.id === "a")!.parallelReady).toBe(true);
    expect(result.find((t) => t.id === "b")!.parallelReady).toBe(false);
    expect(result.find((t) => t.id === "c")!.parallelReady).toBe(false);
  });

  it("ignores deps referencing tasks not in the list", () => {
    const taskA = makeTask({ id: "a", title: "Task A" });
    const deps: Dependency[] = [{ from: "nonexistent", to: "a", reason: "test", type: "explicit" }];

    const result = sortByDependency([taskA], deps);
    expect(result[0].parallelReady).toBe(true);
  });
});
