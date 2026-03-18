import { describe, it, expect } from "vitest";
import { buildSprintStats, formatSprintStats } from "../sprint-stats.js";

describe("buildSprintStats", () => {
  it("returns zero stats for empty task list", () => {
    const stats = buildSprintStats([]);
    expect(stats.totalTasks).toBe(0);
    expect(stats.doneTasks).toBe(0);
    expect(stats.completionRate).toBe(0);
    expect(stats.tasksByStatus).toEqual({ todo: 0, in_progress: 0, review: 0, done: 0 });
  });

  it("computes completion rate correctly", () => {
    const tasks = [
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "done" },
      { id: "3", title: "C", status: "review" },
      { id: "4", title: "D", status: "todo" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.totalTasks).toBe(4);
    expect(stats.doneTasks).toBe(2);
    expect(stats.completionRate).toBe(50);
    expect(stats.tasksByStatus).toEqual({ todo: 1, in_progress: 0, review: 1, done: 2 });
  });

  it("returns 100% when all tasks are done", () => {
    const tasks = [
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "done" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.completionRate).toBe(100);
  });

  it("computes story point stats when available", () => {
    const tasks = [
      { id: "1", title: "A", status: "done", story_points: 3 },
      { id: "2", title: "B", status: "done", story_points: 5 },
      { id: "3", title: "C", status: "review", story_points: 2 },
      { id: "4", title: "D", status: "todo" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.totalStoryPoints).toBe(10);
    expect(stats.doneStoryPoints).toBe(8);
  });

  it("omits story point stats when none are set", () => {
    const tasks = [
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "todo" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.totalStoryPoints).toBe(0);
    expect(stats.doneStoryPoints).toBe(0);
  });

  it("computes task durations from created_at and updated_at", () => {
    const tasks = [
      {
        id: "1",
        title: "Fast task",
        status: "done",
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T11:30:00Z",
      },
      {
        id: "2",
        title: "Slow task",
        status: "done",
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-02T10:00:00Z",
      },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.taskDurations).toHaveLength(2);
    expect(stats.taskDurations[0].title).toBe("Fast task");
    expect(stats.taskDurations[0].durationMinutes).toBe(90);
    expect(stats.taskDurations[1].title).toBe("Slow task");
    expect(stats.taskDurations[1].durationMinutes).toBe(1440);
  });

  it("skips duration for tasks without timing data", () => {
    const tasks = [
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "done", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T12:00:00Z" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.taskDurations).toHaveLength(1);
    expect(stats.taskDurations[0].title).toBe("B");
  });

  it("computes average duration", () => {
    const tasks = [
      { id: "1", title: "A", status: "done", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T11:00:00Z" },
      { id: "2", title: "B", status: "done", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T13:00:00Z" },
    ];
    const stats = buildSprintStats(tasks);
    expect(stats.avgDurationMinutes).toBe(120); // (60 + 180) / 2
  });
});

describe("formatSprintStats", () => {
  it("formats stats as readable text", () => {
    const stats = buildSprintStats([
      { id: "1", title: "Task A", status: "done", story_points: 3 },
      { id: "2", title: "Task B", status: "done", story_points: 5 },
      { id: "3", title: "Task C", status: "review", story_points: 2 },
      { id: "4", title: "Task D", status: "todo" },
    ]);
    const formatted = formatSprintStats(stats);
    expect(formatted).toContain("50%");
    expect(formatted).toContain("2/4");
    expect(formatted).toContain("8/10 SP");
  });

  it("returns empty string for zero tasks", () => {
    const stats = buildSprintStats([]);
    const formatted = formatSprintStats(stats);
    expect(formatted).toBe("");
  });

  it("includes duration info when available", () => {
    const stats = buildSprintStats([
      { id: "1", title: "Task A", status: "done", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T11:30:00Z" },
    ]);
    const formatted = formatSprintStats(stats);
    expect(formatted).toContain("1h 30m");
  });

  it("formats long durations with days", () => {
    const stats = buildSprintStats([
      { id: "1", title: "Long task", status: "done", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-03T14:00:00Z" },
    ]);
    const formatted = formatSprintStats(stats);
    expect(formatted).toContain("2d 4h");
  });

  it("omits story points line when none set", () => {
    const stats = buildSprintStats([
      { id: "1", title: "A", status: "done" },
      { id: "2", title: "B", status: "todo" },
    ]);
    const formatted = formatSprintStats(stats);
    expect(formatted).not.toContain("SP");
  });
});
