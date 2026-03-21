/**
 * LLM-based rule evaluation using Claude CLI (`claude --print`).
 * Evaluates whether keyword-matched rules are genuine violations
 * by asking Claude for structured judgment via COMPLETION_JSON.
 */

import { spawnClaudeOnce } from "./utils/spawn-claude.js";
import * as ui from "./ui.js";

export interface RuleMatch {
  id: string;
  rule_id: string;
  rule_title: string;
  rule_content: string;
  matched_text: string;
  record_text?: string;
  confidence: number;
}

export interface EvaluationResult {
  matchId: string;
  ruleId: string;
  relevant: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * Evaluate a single keyword match using Claude CLI.
 * Returns structured result or null if evaluation failed.
 */
/** Sanitize text for prompt injection: strip control chars and limit length. */
function sanitize(text: string, maxLen = 500): string {
  return text.replace(/[\x00-\x1f]/g, " ").slice(0, maxLen);
}

export async function evaluateRuleMatch(match: RuleMatch): Promise<EvaluationResult | null> {
  const ruleTitle = sanitize(match.rule_title, 200);
  const ruleContent = sanitize(match.rule_content, 500);
  const matchedText = sanitize(match.matched_text, 500);
  const recordText = match.record_text ? sanitize(match.record_text, 2000) : "";

  const prompt = `You are evaluating whether a keyword-based rule match is a genuine rule violation or a false positive.

Rule: ${ruleTitle}
Rule content: ${ruleContent}

Matched text (keyword hit): ${matchedText}

${recordText ? `Full record context:\n${recordText}` : ""}

Evaluate:
1. Does the matched text actually violate or relate to this rule?
2. Or is it a false positive (keyword appeared but context is unrelated)?

Respond with ONLY this JSON on a single line, no other text:
COMPLETION_JSON:{"relevant":true_or_false,"confidence":0.0_to_1.0,"reasoning":"one sentence explanation"}`;

  try {
    const output = await spawnClaudeOnce(prompt, {
      role: "reviewer",
      maxTurns: 1,
      timeout: 60_000,
    });

    // Parse COMPLETION_JSON from output (use last occurrence to avoid partial matches)
    const jsonMatch = output.match(/COMPLETION_JSON:(\{[^}]+\})/);
    if (!jsonMatch) {
      ui.warn(`[rule-eval] No COMPLETION_JSON in output for match ${match.id}`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;

    // Validate and normalize fields
    const relevant = parsed.relevant === true;
    const rawConfidence = Number(parsed.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "No reasoning provided";

    return {
      matchId: match.id,
      ruleId: match.rule_id,
      relevant,
      confidence,
      reasoning,
    };
  } catch (err) {
    ui.warn(`[rule-eval] Evaluation failed for match ${match.id}: ${err}`);
    return null;
  }
}

/**
 * Evaluate a batch of rule matches (up to maxEvaluations).
 * Returns results for successfully evaluated matches.
 */
export async function evaluateRuleMatches(
  matches: RuleMatch[],
  maxEvaluations = 20,
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  const batch = matches.slice(0, maxEvaluations);

  ui.info(`[rule-eval] Evaluating ${batch.length} match(es) via Claude CLI`);

  for (const match of batch) {
    const result = await evaluateRuleMatch(match);
    if (result) {
      results.push(result);
      ui.info(`[rule-eval] ${match.rule_title}: ${result.relevant ? "RELEVANT" : "FALSE POSITIVE"} (${result.confidence.toFixed(1)})`);
    }
  }

  return results;
}
