import { describe, it, expect } from "vitest";
import { AgentRunner } from "../runner.js";

describe("AgentRunner tool stats", () => {
  it("recordTool accumulates counts per agent", () => {
    const runner = new AgentRunner({ useDocker: false });
    runner.recordTool("builder-1", "Bash");
    runner.recordTool("builder-1", "Read");
    runner.recordTool("builder-1", "Bash");
    runner.recordTool("builder-2", "Edit");

    const stats1 = runner.consumeToolStats("builder-1");
    expect(stats1).toEqual({ Bash: 2, Read: 1 });

    const stats2 = runner.consumeToolStats("builder-2");
    expect(stats2).toEqual({ Edit: 1 });
  });

  it("consumeToolStats clears stats for that agent", () => {
    const runner = new AgentRunner({ useDocker: false });
    runner.recordTool("builder-1", "Bash");
    runner.consumeToolStats("builder-1");

    const empty = runner.consumeToolStats("builder-1");
    expect(empty).toEqual({});
  });

  it("consumeToolStats returns empty object for unknown agent", () => {
    const runner = new AgentRunner({ useDocker: false });
    expect(runner.consumeToolStats("nonexistent")).toEqual({});
  });
});
