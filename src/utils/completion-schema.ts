/**
 * Standardized COMPLETION_JSON schemas for all agent roles.
 *
 * Every agent outputs COMPLETION_JSON:{...} on stdout. This module defines
 * the expected shape per role and provides validation + parsing.
 *
 * Hierarchy:
 *   AgentCompletion (base, all agents)
 *     ├── BuilderCompletion
 *     ├── ReviewerCompletion
 *     ├── ResearchCompletion
 *     ├── StrategyCompletion
 *     └── ContentCompletion
 */

// ── Base Completion (all agents) ─────────────────────────

export interface AgentCompletion {
  /** Summary of what was done (replaces old review_comment) */
  summary: string;
  /** Commit hashes (array of strings, normalized from comma-separated) */
  commits?: string[];
  /** Files that were changed */
  files_changed?: string[];
}

// ── Role-Specific Extensions ─────────────────────────────

export interface BuilderCompletion extends AgentCompletion {
  /** How the implementation was approached */
  approach?: string;
}

export interface ReviewerCompletion extends AgentCompletion {
  verdict: "APPROVE" | "NEEDS_CHANGES";
  requirement_match: string;
  code_quality: string;
  test_coverage: string;
  risks: string;
  score?: number;
}

export interface ResearchCompletion extends AgentCompletion {
  /** Key findings */
  findings?: string;
  /** Recommended next steps */
  recommendations?: string;
}

export interface StrategyCompletion extends AgentCompletion {
  /** Strategic decisions made */
  decisions?: Array<{ topic: string; choice: string; reasoning: string }>;
  /** Proposed new tasks */
  proposed_tasks?: Array<{ title: string; priority?: string; story_points?: number }>;
}

export interface ContentCompletion extends AgentCompletion {
  /** Docs that were created or updated */
  docs_updated?: string[];
}

// ── Parsing & Normalization ──────────────────────────────

/**
 * Normalize a raw COMPLETION_JSON object into the standardized format.
 *
 * Handles backwards compatibility:
 * - review_comment → summary
 * - commits as comma-separated string → string[]
 */
export function normalizeCompletion(raw: Record<string, unknown>): AgentCompletion {
  // Normalize summary (backwards compat: review_comment → summary)
  const summary = (raw.summary ?? raw.review_comment ?? "") as string;

  // Normalize commits (string → string[])
  let commits: string[] | undefined;
  if (typeof raw.commits === "string" && raw.commits.length > 0) {
    commits = raw.commits.split(",").map((s: string) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw.commits)) {
    commits = raw.commits as string[];
  }

  // Normalize files_changed
  let files_changed: string[] | undefined;
  if (typeof raw.files_changed === "string") {
    files_changed = raw.files_changed.split(",").map((s: string) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw.files_changed)) {
    files_changed = raw.files_changed as string[];
  }

  return { summary, commits, files_changed };
}

/**
 * Normalize a Reviewer's completion output.
 */
export function normalizeReviewerCompletion(raw: Record<string, unknown>): ReviewerCompletion {
  const base = normalizeCompletion(raw);
  return {
    ...base,
    verdict: (raw.verdict === "APPROVE" ? "APPROVE" : "NEEDS_CHANGES") as "APPROVE" | "NEEDS_CHANGES",
    requirement_match: (raw.requirement_match ?? "") as string,
    code_quality: (raw.code_quality ?? "") as string,
    test_coverage: (raw.test_coverage ?? "") as string,
    risks: (raw.risks ?? "none") as string,
    score: typeof raw.score === "number" ? raw.score : undefined,
  };
}

/**
 * Convert a standardized completion back to the legacy format
 * (for backwards compatibility with existing code that reads review_comment/commits as strings)
 */
export function toLegacyFormat(completion: AgentCompletion): { review_comment: string; commits: string } {
  return {
    review_comment: completion.summary,
    commits: completion.commits?.join(",") ?? "",
  };
}
