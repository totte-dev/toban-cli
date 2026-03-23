import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadPipelineState, savePipelineState, clearPipelineState, type PipelineStepState } from "../utils/pipeline-state.js";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_TASK_ID = "test-pipeline-state-" + Date.now();
const STATE_DIR = join(homedir(), ".toban", "pipeline");
const STATE_FILE = join(STATE_DIR, `${TEST_TASK_ID}.json`);

describe("pipeline-state", () => {
  beforeEach(() => {
    clearPipelineState(TEST_TASK_ID);
  });

  afterEach(() => {
    try { unlinkSync(STATE_FILE); } catch { /* ok */ }
  });

  it("returns null when no state exists", () => {
    expect(loadPipelineState(TEST_TASK_ID)).toBeNull();
  });

  it("saves and loads state correctly", () => {
    const state: PipelineStepState = {
      merge_done: true,
      merge_commit: "abc123",
      verify_done: false,
      push_done: false,
      updated_at: "",
    };
    savePipelineState(TEST_TASK_ID, state);

    const loaded = loadPipelineState(TEST_TASK_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.merge_done).toBe(true);
    expect(loaded!.merge_commit).toBe("abc123");
    expect(loaded!.verify_done).toBe(false);
    expect(loaded!.updated_at).toBeTruthy();
  });

  it("updates state incrementally", () => {
    savePipelineState(TEST_TASK_ID, {
      merge_done: true,
      verify_done: false,
      push_done: false,
      updated_at: "",
    });

    const state = loadPipelineState(TEST_TASK_ID)!;
    state.verify_done = true;
    savePipelineState(TEST_TASK_ID, state);

    const loaded = loadPipelineState(TEST_TASK_ID)!;
    expect(loaded.merge_done).toBe(true);
    expect(loaded.verify_done).toBe(true);
    expect(loaded.push_done).toBe(false);
  });

  it("clearPipelineState removes the file", () => {
    savePipelineState(TEST_TASK_ID, {
      merge_done: true,
      verify_done: true,
      push_done: false,
      updated_at: "",
    });
    expect(loadPipelineState(TEST_TASK_ID)).not.toBeNull();

    clearPipelineState(TEST_TASK_ID);
    expect(loadPipelineState(TEST_TASK_ID)).toBeNull();
  });

  it("clearPipelineState does not throw when no state exists", () => {
    expect(() => clearPipelineState("nonexistent-task-id")).not.toThrow();
  });
});
