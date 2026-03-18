import { describe, it, expect } from "vitest";
import { WS_MSG } from "../ws-types.js";

describe("WS_MSG.REVIEW_UPDATE", () => {
  it("should be defined as 'review_update'", () => {
    expect(WS_MSG.REVIEW_UPDATE).toBe("review_update");
  });

  it("should be included in the WS_MSG constants", () => {
    const allTypes = Object.values(WS_MSG);
    expect(allTypes).toContain("review_update");
  });
});

describe("REVIEW_UPDATE message format", () => {
  it("should produce a valid message structure with all fields", () => {
    const message = {
      type: WS_MSG.REVIEW_UPDATE,
      task_id: "task-123",
      agent_name: "builder",
      phase: "completed",
      review_comment: '{"verdict":"APPROVE"}',
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("review_update");
    expect(message.task_id).toBe("task-123");
    expect(message.agent_name).toBe("builder");
    expect(message.phase).toBe("completed");
    expect(message.review_comment).toBeDefined();
  });

  it("should allow message without review_comment for progress phases", () => {
    const message = {
      type: WS_MSG.REVIEW_UPDATE,
      task_id: "task-456",
      agent_name: "builder",
      phase: "started",
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("review_update");
    expect(message.phase).toBe("started");
    expect(message.review_comment).toBeUndefined();
  });

  it("should support all review phases", () => {
    const phases = ["started", "analyzing", "agent_submitted", "completed", "failed"];
    for (const phase of phases) {
      const message = {
        type: WS_MSG.REVIEW_UPDATE,
        task_id: "task-789",
        phase,
      };
      expect(message.phase).toBe(phase);
    }
  });
});
