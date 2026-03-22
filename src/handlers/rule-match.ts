/**
 * rule_match action handler — T1 keyword matching after merge pipeline.
 *
 * Runs git diff to get the merged changes, then matches against playbook
 * rules locally. Results are buffered to JSONL for T2 LLM evaluation.
 */

import { execSync } from "node:child_process";
import type { ActionContext, TemplateAction } from "../agent-templates.js";
import { matchRulesLocally } from "../utils/rule-matcher.js";
import { resolveRepoRoot } from "../git-ops.js";
import * as ui from "../ui.js";

export async function handleRuleMatch(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: string,
): Promise<void> {
  // Skip if merge was skipped (no code changes to match against)
  if (ctx.mergeSkipped) return;

  const repoDir = resolveRepoRoot(ctx.config.workingDir);

  // Get the diff of the merged commit(s)
  let diffText: string;
  try {
    const diffRef = ctx.preMergeHash ? `${ctx.preMergeHash}..HEAD` : "HEAD~1..HEAD";
    diffText = execSync(`git diff ${diffRef}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024, // 1MB max
    });
  } catch {
    // Non-fatal: can't get diff
    return;
  }

  if (!diffText || diffText.length < 10) return;

  const startMs = Date.now();
  const matches = await matchRulesLocally(
    ctx.api,
    diffText,
    ctx.task.id,
    ctx.config.sprintNumber,
  );
  const elapsed = Date.now() - startMs;

  if (matches.length > 0) {
    const autoHits = matches.filter((m) => m.tier === "auto_hit").length;
    const candidates = matches.filter((m) => m.tier === "llm_candidate").length;
    ui.info(`[${phase}] rule_match: ${matches.length} match(es) (${autoHits} auto, ${candidates} candidates) in ${elapsed}ms`);
    ctx.taskLog?.event("rule_match", {
      total: matches.length,
      auto_hits: autoHits,
      llm_candidates: candidates,
      elapsed_ms: elapsed,
    });
  }
}
