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
  const pipelineStart = Date.now();

  // Step 1: Merge agent branch to base
  const mergeAction: TemplateAction = { type: "git_merge", label: "Merge branch to base" };
  await handleGitMerge(mergeAction, ctx, phase);

  // If merge was skipped (no meaningful commits) or failed, stop pipeline
  if (ctx.mergeSkipped) {
    ui.info(`[${phase}] merge-pipeline: merge skipped (no commits) — skipping build/push`);
    ctx.taskLog?.event("merge_pipeline_done", { skipped: true, duration_seconds: 0 });
    return;
  }
  if (ctx.exitCode != null && ctx.exitCode !== 0) {
    ui.warn(`[${phase}] merge-pipeline: merge failed — skipping build/push`);
    ctx.taskLog?.event("merge_pipeline_done", { result: "merge_failed", duration_seconds: Math.round((Date.now() - pipelineStart) / 1000) });
    return;
  }

  const mergeMs = Date.now() - pipelineStart;

  // Step 2: Verify build and tests
  const verifyAction: TemplateAction = { type: "verify_build", label: "Verify build and tests pass" };
  await handleVerifyBuild(verifyAction, ctx, phase);

  // If verify failed (exitCode set, merge already reverted), stop pipeline
  if (ctx.exitCode != null && ctx.exitCode !== 0) {
    ui.warn(`[${phase}] merge-pipeline: verify_build failed — skipping push`);
    ctx.taskLog?.event("merge_pipeline_done", { result: "build_failed", duration_seconds: Math.round((Date.now() - pipelineStart) / 1000) });
    return;
  }

  const verifyMs = Date.now() - pipelineStart - mergeMs;

  // Step 3: Push to remote
  const pushAction: TemplateAction = { type: "git_push", label: "Push main to remote" };
  await handleGitPush(pushAction, ctx, phase);

  const totalSeconds = Math.round((Date.now() - pipelineStart) / 1000);
  ctx.taskLog?.event("merge_pipeline_done", {
    result: "success",
    duration_seconds: totalSeconds,
    merge_seconds: Math.round(mergeMs / 1000),
    verify_seconds: Math.round(verifyMs / 1000),
    push_seconds: totalSeconds - Math.round(mergeMs / 1000) - Math.round(verifyMs / 1000),
  });
}
