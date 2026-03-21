import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRuleMatch, evaluateRuleMatches, type RuleMatch } from "../rule-evaluator.js";

// Mock spawnClaudeOnce
const spawnClaudeMock = vi.fn();
vi.mock("../utils/spawn-claude.js", () => ({
  spawnClaudeOnce: (...args: unknown[]) => spawnClaudeMock(...args),
}));

function makeMatch(overrides: Partial<RuleMatch> = {}): RuleMatch {
  return {
    id: "match-1",
    rule_id: "rule-1",
    rule_title: "Always run npm install in worktree",
    rule_content: "Worktree environments must have npm install before build",
    matched_text: "npm install was skipped in the worktree setup",
    confidence: 0.6,
    ...overrides,
  };
}

describe("rule-evaluator", () => {
  beforeEach(() => {
    spawnClaudeMock.mockReset();
  });

  it("returns structured result for a relevant match", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":true,"confidence":0.9,"reasoning":"The text directly describes skipping npm install in worktree"}'
    );

    const result = await evaluateRuleMatch(makeMatch());

    expect(result).not.toBeNull();
    expect(result!.relevant).toBe(true);
    expect(result!.confidence).toBe(0.9);
    expect(result!.reasoning).toContain("npm install");
    expect(result!.matchId).toBe("match-1");
    expect(result!.ruleId).toBe("rule-1");
  });

  it("returns structured result for a false positive", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":false,"confidence":0.8,"reasoning":"Keyword match but context is about a different topic"}'
    );

    const result = await evaluateRuleMatch(makeMatch());

    expect(result).not.toBeNull();
    expect(result!.relevant).toBe(false);
    expect(result!.confidence).toBe(0.8);
  });

  it("returns null when no COMPLETION_JSON in output", async () => {
    spawnClaudeMock.mockResolvedValue("I think this is relevant but here is no JSON output.");

    const result = await evaluateRuleMatch(makeMatch());
    expect(result).toBeNull();
  });

  it("returns null when Claude CLI fails", async () => {
    spawnClaudeMock.mockRejectedValue(new Error("Claude not installed"));

    const result = await evaluateRuleMatch(makeMatch());
    expect(result).toBeNull();
  });

  it("clamps confidence to 0-1 range", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":true,"confidence":1.5,"reasoning":"very sure"}'
    );

    const result = await evaluateRuleMatch(makeMatch());
    expect(result!.confidence).toBe(1.0);
  });

  it("handles NaN confidence gracefully", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":true,"confidence":"high","reasoning":"sure"}'
    );

    const result = await evaluateRuleMatch(makeMatch());
    expect(result!.confidence).toBe(0.5); // default
  });

  it("treats non-true relevant as false", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":"yes","confidence":0.7,"reasoning":"maybe"}'
    );

    const result = await evaluateRuleMatch(makeMatch());
    expect(result!.relevant).toBe(false); // strict boolean
  });

  it("sanitizes prompt input (strips control chars)", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":false,"confidence":0.5,"reasoning":"test"}'
    );

    await evaluateRuleMatch(makeMatch({
      rule_title: "Rule with\x00control\x1fchars",
      matched_text: "Text\nwith\nnewlines",
    }));

    const prompt = spawnClaudeMock.mock.calls[0][0] as string;
    expect(prompt).not.toContain("\x00");
    expect(prompt).not.toContain("\x1f");
  });

  it("evaluateRuleMatches processes batch and limits to maxEvaluations", async () => {
    spawnClaudeMock.mockResolvedValue(
      'COMPLETION_JSON:{"relevant":true,"confidence":0.8,"reasoning":"ok"}'
    );

    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `match-${i}`, rule_id: `rule-${i}` })
    );

    const results = await evaluateRuleMatches(matches, 3);

    expect(results).toHaveLength(3);
    expect(spawnClaudeMock).toHaveBeenCalledTimes(3);
  });

  it("evaluateRuleMatches skips failed evaluations", async () => {
    let callCount = 0;
    spawnClaudeMock.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.resolve("no json here");
      return Promise.resolve('COMPLETION_JSON:{"relevant":true,"confidence":0.8,"reasoning":"ok"}');
    });

    const matches = [makeMatch({ id: "m1" }), makeMatch({ id: "m2" }), makeMatch({ id: "m3" })];
    const results = await evaluateRuleMatches(matches);

    expect(results).toHaveLength(2); // m2 failed, so only m1 and m3
  });
});
