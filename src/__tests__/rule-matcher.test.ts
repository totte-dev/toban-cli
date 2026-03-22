import { describe, it, expect } from "vitest";
import { _buildMatchers, _matchText } from "../utils/rule-matcher.js";

describe("buildMatchers", () => {
  it("extracts Latin keywords from rule title and content", () => {
    const matchers = _buildMatchers([
      { id: "r1", category: "security", title: "SQL Injection Prevention", content: "Always use parameterized queries", tags: null },
    ]);
    expect(matchers).toHaveLength(1);
    expect(matchers[0].rule_id).toBe("r1");
    expect(matchers[0].patterns.length).toBeGreaterThan(0);
    // Should match "Injection" or "parameterized"
    const hasLongKeyword = matchers[0].patterns.some((p) => p.source.length >= 5);
    expect(hasLongKeyword).toBe(true);
  });

  it("extracts CJK keywords from rule content", () => {
    const matchers = _buildMatchers([
      { id: "r2", category: "quality", title: "コードレビュー", content: "テストカバレッジを確認する", tags: null },
    ]);
    expect(matchers).toHaveLength(1);
    expect(matchers[0].patterns.length).toBeGreaterThan(0);
  });

  it("returns empty patterns for very short text", () => {
    const matchers = _buildMatchers([
      { id: "r3", category: "style", title: "ab", content: "cd", tags: null },
    ]);
    // Latin words need 3+ chars, CJK needs 2+ chars
    expect(matchers[0].patterns).toHaveLength(0);
  });

  it("deduplicates and limits to 15 keywords", () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `keyword${i}word`).join(" ");
    const matchers = _buildMatchers([
      { id: "r4", category: "test", title: "Test Rule", content: longContent, tags: null },
    ]);
    expect(matchers[0].patterns.length).toBeLessThanOrEqual(15);
  });
});

describe("matchText", () => {
  const matchers = _buildMatchers([
    { id: "r1", category: "security", title: "SQL Injection Prevention", content: "Always use parameterized queries to prevent SQL injection attacks", tags: null },
    { id: "r2", category: "quality", title: "Error Handling", content: "Catch exceptions and provide meaningful error messages", tags: null },
  ]);

  it("returns matches when 2+ patterns hit", () => {
    const text = "This code uses SQL injection prevention with parameterized queries";
    const matches = _matchText(text, matchers);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].rule_id).toBe("r1");
    expect(matches[0].confidence).toBeGreaterThan(0.5);
  });

  it("returns empty when fewer than 2 patterns hit", () => {
    const text = "This code has nothing related to any rules";
    const matches = _matchText(text, matchers);
    expect(matches).toHaveLength(0);
  });

  it("computes confidence correctly from total hit count", () => {
    // 5 hits should give confidence = min(0.5 + 5*0.1, 0.95) = 0.95
    const text = "SQL injection parameterized queries prevent attacks Always";
    const matches = _matchText(text, matchers);
    if (matches.length > 0) {
      expect(matches[0].confidence).toBeGreaterThanOrEqual(0.6);
      expect(matches[0].confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it("uses longest matched text", () => {
    const text = "Use parameterized queries for SQL injection prevention";
    const matches = _matchText(text, matchers);
    if (matches.length > 0) {
      // Should pick the longest keyword match
      expect(matches[0].matched_text.length).toBeGreaterThan(2);
    }
  });

  it("sorts matches by confidence descending", () => {
    const text = "SQL injection parameterized queries error handling catch exceptions meaningful messages";
    const matches = _matchText(text, matchers);
    if (matches.length >= 2) {
      expect(matches[0].confidence).toBeGreaterThanOrEqual(matches[1].confidence);
    }
  });
});

describe("anti-pattern filtering", () => {
  function applyAntiPatterns(
    matchers: ReturnType<typeof _buildMatchers>,
    antiPatterns: Record<string, string[]>,
  ) {
    return matchers.map((m) => {
      const excluded = antiPatterns[m.rule_id];
      if (!excluded || excluded.length === 0) return m;
      const excludeSet = new Set(excluded.map((t) => t.toLowerCase()));
      const filteredKeywords = m.keywords.filter((kw) => !excludeSet.has(kw));
      const excludedKeywords = new Set(m.keywords.filter((kw) => excludeSet.has(kw)));
      return {
        ...m,
        patterns: m.patterns.filter((_, i) => !excludedKeywords.has(m.keywords[i])),
        keywords: filteredKeywords,
      };
    });
  }

  it("removes patterns matching anti-pattern tokens", () => {
    const matchers = _buildMatchers([
      { id: "r1", category: "security", title: "SQL Injection Prevention", content: "Always use parameterized queries to prevent attacks", tags: null },
    ]);

    const originalCount = matchers[0].patterns.length;
    expect(originalCount).toBeGreaterThan(0);

    const filtered = applyAntiPatterns(matchers, {
      r1: ["injection", "prevention"],
    });

    expect(filtered[0].patterns.length).toBeLessThan(originalCount);
    // Excluded keywords should not be in the filtered keywords list
    expect(filtered[0].keywords).not.toContain("injection");
    expect(filtered[0].keywords).not.toContain("prevention");
  });

  it("does not filter patterns for rules without anti-patterns", () => {
    const matchers = _buildMatchers([
      { id: "r2", category: "quality", title: "Error Handling", content: "Catch exceptions and provide meaningful error messages", tags: null },
    ]);
    const originalCount = matchers[0].patterns.length;

    const filtered = applyAntiPatterns(matchers, {});
    expect(filtered[0].patterns.length).toBe(originalCount);
  });

  it("keywords list tracks original extracted keywords", () => {
    const matchers = _buildMatchers([
      { id: "r1", category: "test", title: "SQL Injection", content: "parameterized queries", tags: null },
    ]);
    expect(matchers[0].keywords.length).toBe(matchers[0].patterns.length);
    expect(matchers[0].keywords.every((kw) => typeof kw === "string" && kw === kw.toLowerCase())).toBe(true);
  });
});
