/**
 * Local keyword-based rule matcher.
 *
 * Fetches playbook rules from API once, then matches locally against
 * git diff text. Results are buffered to ~/.toban/events/rule-matches.jsonl
 * for later T2 LLM evaluation and telemetry sync.
 *
 * This runs synchronously in post-action (T1 tier, ~0ms).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ApiClient } from "../api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleMatchResult {
  id: string;
  rule_id: string;
  category: string;
  confidence: number;
  matched_text: string;
  record_type: "task_diff";
  record_id: string;
  /** "auto_hit" (>=0.8) or "llm_candidate" (0.3-0.8) */
  tier: "auto_hit" | "llm_candidate";
  timestamp: string;
  sprint?: number;
}

interface PlaybookRule {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string | null;
}

interface MatcherPattern {
  rule_id: string;
  category: string;
  patterns: RegExp[];
}

// ---------------------------------------------------------------------------
// Buffer path
// ---------------------------------------------------------------------------

export function getMatchBufferPath(): string {
  const dir = join(homedir(), ".toban", "events");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "rule-matches.jsonl");
}

// ---------------------------------------------------------------------------
// Build matchers from playbook rules
// ---------------------------------------------------------------------------

function buildMatchers(rules: PlaybookRule[]): MatcherPattern[] {
  return rules.map((r) => {
    const patterns: RegExp[] = [];

    // Extract keywords from title + content
    const text = [r.title, r.content].join(" ");
    const latinWords = text.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) || [];
    const cjkPhrases = text.match(/[\u3000-\u9fff\uf900-\ufaff]{2,6}/g) || [];
    const keywords = [...latinWords, ...cjkPhrases];

    if (keywords.length > 0) {
      const unique = [...new Set(keywords)]
        .sort((a, b) => b.length - a.length)
        .slice(0, 15);
      for (const kw of unique) {
        try {
          patterns.push(new RegExp(kw, "i"));
        } catch { /* skip invalid regex */ }
      }
    }

    return { rule_id: r.id, category: r.category, patterns };
  });
}

// ---------------------------------------------------------------------------
// Match text against patterns
// ---------------------------------------------------------------------------

function matchText(
  text: string,
  matchers: MatcherPattern[],
): Array<{ rule_id: string; category: string; confidence: number; matched_text: string }> {
  const matches: Array<{
    rule_id: string;
    category: string;
    confidence: number;
    matched_text: string;
  }> = [];

  for (const matcher of matchers) {
    let longestMatch = "";
    let hitCount = 0;

    for (const pattern of matcher.patterns) {
      const m = text.match(pattern);
      if (m) {
        hitCount++;
        if (m[0].length > longestMatch.length) {
          longestMatch = m[0].slice(0, 200);
        }
      }
    }

    // Require at least 2 pattern hits to reduce false positives
    if (hitCount >= 2 && longestMatch) {
      matches.push({
        rule_id: matcher.rule_id,
        category: matcher.category,
        confidence: Math.min(0.5 + hitCount * 0.1, 0.95),
        matched_text: longestMatch,
      });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Buffer rotation
// ---------------------------------------------------------------------------

function rotateBuffer(filePath: string, maxLines: number): void {
  try {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > maxLines) {
      // Keep the most recent entries
      const trimmed = lines.slice(-maxLines);
      writeFileSync(filePath, trimmed.join("\n") + "\n");
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch playbook rules from API, match against diff text, buffer results.
 * Returns match results (empty array if no matches or on error).
 */
export async function matchRulesLocally(
  api: ApiClient,
  diffText: string,
  taskId: string,
  sprint?: number,
): Promise<RuleMatchResult[]> {
  if (!diffText || diffText.length < 10) return [];

  // Fetch rules from API
  let rules: PlaybookRule[];
  try {
    rules = await api.fetchPlaybookRules();
  } catch {
    return []; // Non-fatal: rules not available
  }

  if (rules.length === 0) return [];

  // Fetch anti-patterns (rejected false positives) to filter out
  let antiPatterns: Record<string, string[]> = {};
  try {
    antiPatterns = await api.fetchAntiPatterns();
  } catch { /* non-fatal */ }

  // Build matchers and apply anti-pattern filtering
  const matchers = buildMatchers(rules).map((m) => {
    const excluded = antiPatterns[m.rule_id];
    if (!excluded || excluded.length === 0) return m;
    const excludeSet = new Set(excluded.map((t) => t.toLowerCase()));
    return {
      ...m,
      patterns: m.patterns.filter((p) => !excludeSet.has(p.source.toLowerCase())),
    };
  });
  const rawMatches = matchText(diffText, matchers);

  if (rawMatches.length === 0) return [];

  // Convert to RuleMatchResult with tier classification
  const now = new Date().toISOString();
  const results: RuleMatchResult[] = rawMatches.map((m) => ({
    id: crypto.randomUUID(),
    rule_id: m.rule_id,
    category: m.category,
    confidence: m.confidence,
    matched_text: m.matched_text,
    record_type: "task_diff" as const,
    record_id: taskId,
    tier: m.confidence >= 0.8 ? "auto_hit" as const : "llm_candidate" as const,
    timestamp: now,
    sprint,
  }));

  // Buffer to JSONL file (with rotation at 1000 lines)
  const bufferPath = getMatchBufferPath();
  for (const result of results) {
    try {
      appendFileSync(bufferPath, JSON.stringify(result) + "\n");
    } catch { /* best-effort */ }
  }
  rotateBuffer(bufferPath, 1000);

  return results;
}

/**
 * Read buffered match results (for T2 LLM evaluation).
 * Returns only llm_candidate tier entries that haven't been evaluated.
 */
export function readPendingCandidates(maxCount = 10): RuleMatchResult[] {
  const bufferPath = getMatchBufferPath();
  if (!existsSync(bufferPath)) return [];

  try {
    const content = readFileSync(bufferPath, "utf-8").trim();
    if (!content) return [];

    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as RuleMatchResult; } catch { return null; }
      })
      .filter((r): r is RuleMatchResult => r !== null && r.tier === "llm_candidate")
      .slice(0, maxCount);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------
export { buildMatchers as _buildMatchers, matchText as _matchText };
