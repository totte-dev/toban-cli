/**
 * Classifies review rejections as infrastructure issues vs code quality problems.
 * Infrastructure issues should not be retried by the agent — they need human/system fixes.
 */

export type RejectionClass = "infra" | "code_quality";
export type InfraCategory =
  | "merge_conflict"
  | "worktree_setup"
  | "build_env"
  | "playbook_false_positive"
  | "prompt_injection";

export interface ClassificationResult {
  classification: RejectionClass;
  category?: InfraCategory;
  reason?: string;
}

const INFRA_PATTERNS: Array<{ pattern: RegExp; category: InfraCategory; reason: string }> = [
  // Merge conflicts
  { pattern: /merge conflict/i, category: "merge_conflict", reason: "Git merge conflict detected" },
  { pattern: /CONFLICT \(content\)/i, category: "merge_conflict", reason: "Git merge conflict in file content" },
  { pattern: /automatic merge failed/i, category: "merge_conflict", reason: "Git automatic merge failed" },

  // Worktree setup failures
  { pattern: /fatal:.*worktree/i, category: "worktree_setup", reason: "Git worktree operation failed" },
  { pattern: /branch.*already exists/i, category: "worktree_setup", reason: "Branch already exists (worktree conflict)" },
  { pattern: /fatal:.*is already checked out/i, category: "worktree_setup", reason: "Branch already checked out in another worktree" },

  // Build environment issues (not caused by agent's code)
  { pattern: /npm ERR! code E(?:RESOLVE|NOENT|ACCES)/i, category: "build_env", reason: "npm dependency resolution failure" },
  { pattern: /MODULE_NOT_FOUND/i, category: "build_env", reason: "Missing module (environment setup issue)" },
  { pattern: /ENOENT.*node_modules/i, category: "build_env", reason: "node_modules not installed" },
  { pattern: /npm ci.*failed/i, category: "build_env", reason: "npm ci failed during worktree setup" },

  // CLAUDE.md / prompt injection issues
  { pattern: /CLAUDE\.md.*(?:missing|not found|corrupt)/i, category: "prompt_injection", reason: "CLAUDE.md missing or corrupted" },
  { pattern: /missing instructions/i, category: "prompt_injection", reason: "Agent prompt instructions missing" },
];

/**
 * Classify a review rejection as infrastructure issue or code quality problem.
 *
 * @param reviewComment - The Reviewer's assessment (may be JSON string)
 * @param agentStderr - The agent's stderr output during execution
 * @param wasOverridden - Whether Manager issued OVERRIDE_APPROVE (indicates false positive)
 */
export function classifyRejection(
  reviewComment: string,
  agentStderr: string,
  wasOverridden: boolean,
): ClassificationResult {
  // Manager override = Reviewer was too strict = Playbook false positive
  if (wasOverridden) {
    return {
      classification: "infra",
      category: "playbook_false_positive",
      reason: "Manager overrode Reviewer rejection (Playbook rule false positive)",
    };
  }

  // Check stderr and review comment against known infra patterns
  const combined = `${reviewComment}\n${agentStderr}`;
  for (const { pattern, category, reason } of INFRA_PATTERNS) {
    if (pattern.test(combined)) {
      return { classification: "infra", category, reason };
    }
  }

  return { classification: "code_quality" };
}
