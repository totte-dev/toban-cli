/**
 * Merge Pipeline — orchestrates git_merge → verify_build → git_push as a single unit.
 *
 * Idempotent: persists step state per task so retries skip completed steps.
 * - push failure → retry skips merge+verify, runs push only
 * - verify failure → reverts merge, clears state (Builder must redo)
 * - full success → clears state
 */

import type { ActionContext, TemplateAction } from "../agents/agent-templates.js";
import { handleGitMerge } from "./git-merge.js";
import { handleGitPush } from "./git-push.js";
import { handleVerifyBuild } from "./verify-build.js";
import { loadPipelineState, savePipelineState, clearPipelineState } from "../utils/pipeline-state.js";
import * as ui from "../ui.js";

export async function handleMergePipeline(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: string,
): Promise<void> {
  const taskId = ctx.task.id;
  const pipelineStart = Date.now();
  const saved = loadPipelineState(taskId);

  // Step 1: Merge agent branch to base
  if (saved?.merge_done && saved?.verify_done) {
    ui.info(`[${phase}] merge-pipeline: merge+verify already done — skipping to push`);
  } else if (saved?.merge_done) {
    ui.info(`[${phase}] merge-pipeline: merge already done — skipping to verify`);
  } else {
    const mergeAction: TemplateAction = { type: "git_merge", label: "Merge branch to base" };
    await handleGitMerge(mergeAction, ctx, phase);

    if (ctx.mergeSkipped) {
      ui.info(`[${phase}] merge-pipeline: merge skipped (no commits) — skipping build/push`);
      ctx.taskLog?.event("merge_pipeline_done", { skipped: true, duration_seconds: 0 });
      clearPipelineState(taskId);
      return;
    }
    if (ctx.exitCode != null && ctx.exitCode !== 0) {
      ui.warn(`[${phase}] merge-pipeline: merge failed — skipping build/push`);
      ctx.taskLog?.event("merge_pipeline_done", { result: "merge_failed", duration_seconds: Math.round((Date.now() - pipelineStart) / 1000) });
      clearPipelineState(taskId);
      return;
    }

    savePipelineState(taskId, {
      merge_done: true,
      merge_commit: ctx.preMergeHash,
      verify_done: false,
      push_done: false,
      updated_at: "",
    });
  }

  const mergeMs = Date.now() - pipelineStart;

  // Step 2: Verify build and tests
  if (saved?.merge_done && saved?.verify_done) {
    // Already verified — skip
  } else {
    const verifyAction: TemplateAction = { type: "verify_build", label: "Verify build and tests pass" };
    await handleVerifyBuild(verifyAction, ctx, phase);

    if (ctx.exitCode != null && ctx.exitCode !== 0) {
      ui.warn(`[${phase}] merge-pipeline: verify_build failed — skipping push`);
      ctx.taskLog?.event("merge_pipeline_done", { result: "build_failed", duration_seconds: Math.round((Date.now() - pipelineStart) / 1000) });
      // verify failure reverts the merge, so clear all state
      clearPipelineState(taskId);
      return;
    }

    const state = loadPipelineState(taskId);
    if (state) {
      state.verify_done = true;
      savePipelineState(taskId, state);
    }
  }

  const verifyMs = Date.now() - pipelineStart - mergeMs;

  // Step 3: Push to remote
  const pushAction: TemplateAction = { type: "git_push", label: "Push main to remote" };
  await handleGitPush(pushAction, ctx, phase);

  const totalSeconds = Math.round((Date.now() - pipelineStart) / 1000);
  const pushFailed = ctx.exitCode != null && ctx.exitCode !== 0;

  ctx.taskLog?.event("merge_pipeline_done", {
    result: pushFailed ? "push_failed" : "success",
    duration_seconds: totalSeconds,
    merge_seconds: Math.round(mergeMs / 1000),
    verify_seconds: Math.round(verifyMs / 1000),
    push_seconds: totalSeconds - Math.round(mergeMs / 1000) - Math.round(verifyMs / 1000),
    resumed: !!saved,
  });

  if (pushFailed) {
    // Push failure is an infra issue — move to review with ERROR verdict so user can see it
    ui.warn(`[${phase}] merge-pipeline: push failed — moving to review with error`);
    try {
      await ctx.api.updateTask(taskId, {
        status: "review",
        review_verdict: "ERROR",
        review_comment: JSON.stringify({
          verdict: "ERROR",
          reason: "git push failed — check branch protection rules or Git credentials",
          category: "infra_push",
        }),
      } as any);
      ctx.onDataUpdate?.("task", taskId, { status: "review", review_verdict: "ERROR" });
    } catch { /* non-fatal */ }
    clearPipelineState(taskId);
    // Override exitCode so the template's failure handler doesn't reset to todo
    ctx.exitCode = 0;
    ctx.mergeSkipped = true;
  } else {
    // Full success — clean up
    clearPipelineState(taskId);
  }
}
