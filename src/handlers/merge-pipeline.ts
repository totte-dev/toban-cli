/**
 * Merge Pipeline — orchestrates git_merge → verify_build → git_push as a single unit.
 *
 * These three actions have strong sequential dependencies:
 * - verify_build must run after merge (builds from merged main)
 * - git_push must NOT run if verify_build fails (revert already happened)
 * - All three share ActionContext state (exitCode, preMergeHash, mergeSkipped)
 *
 * This pipeline replaces three separate post_actions with one atomic operation.
 */

import type { ActionContext, TemplateAction } from "../agent-templates.js";
import { handleGitMerge } from "./git-merge.js";
import { handleGitPush } from "./git-push.js";
import { handleVerifyBuild } from "./verify-build.js";
import * as ui from "../ui.js";

export async function handleMergePipeline(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: string,
): Promise<void> {
  // Step 1: Merge agent branch to base
  const mergeAction: TemplateAction = { type: "git_merge", label: "Merge branch to base" };
  await handleGitMerge(mergeAction, ctx, phase);

  // If merge was skipped (no meaningful commits) or failed, stop pipeline
  if (ctx.mergeSkipped) {
    ui.info(`[${phase}] merge-pipeline: merge skipped (no commits) — skipping build/push`);
    return;
  }
  if (ctx.exitCode != null && ctx.exitCode !== 0) {
    ui.warn(`[${phase}] merge-pipeline: merge failed — skipping build/push`);
    return;
  }

  // Step 2: Verify build and tests
  const verifyAction: TemplateAction = { type: "verify_build", label: "Verify build and tests pass" };
  await handleVerifyBuild(verifyAction, ctx, phase);

  // If verify failed (exitCode set, merge already reverted), stop pipeline
  if (ctx.exitCode != null && ctx.exitCode !== 0) {
    ui.warn(`[${phase}] merge-pipeline: verify_build failed — skipping push`);
    return;
  }

  // Step 3: Push to remote
  const pushAction: TemplateAction = { type: "git_push", label: "Push main to remote" };
  await handleGitPush(pushAction, ctx, phase);
}
