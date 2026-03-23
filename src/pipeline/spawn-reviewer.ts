/**
 * Handler for the spawn_reviewer template action.
 * Spawns a Reviewer agent process to review code changes.
 */

import { execSync } from "node:child_process";
import type { TemplateAction, ActionContext } from "../agents/agent-templates.js";
import type { Task } from "../services/api-client.js";
import { createAuthHeaders, fetchWithRetry } from "../services/api-client.js";
import { interpolate, getDefaultTemplates } from "../agents/agent-templates.js";
import * as ui from "../ui.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { spawnClaudeOnce } from "../utils/spawn-claude.js";
import { resolveRepoRoot } from "../services/git-ops.js";
import { resolveModelForRole } from "../agents/agent-engine.js";
import { TIMEOUTS, LIMITS } from "../constants.js";
import { classifyRejection } from "../utils/infra-classifier.js";
import type { ReviewerRecord, ReviewFinding, ManagerRecord, ReviewRecord } from "../utils/completion-schema.js";

export async function handleSpawnReviewer(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post",
  _actions: TemplateAction[]
): Promise<void> {
  const label = action.label ?? "spawn_reviewer";
  if (ctx.mergeSkipped) {
    const allowNoCommit = ctx.template?.allow_no_commit_completion ?? false;
    if (!allowNoCommit || !ctx.completionJson?.review_comment) {
      ui.info(`[${phase}] ${label}: skipped (no merge${!ctx.completionJson ? ", no completion" : ""})`);
      ctx.reviewVerdict = "NEEDS_CHANGES";
      return;
    }
    // No commits but agent reported completion — still run Reviewer
    // to verify the claim (e.g. "already implemented")
    ui.info(`[${phase}] ${label}: no code changes, running Reviewer to verify completion`);
  }
  ctx.onReviewUpdate?.(ctx.task.id, "started");
  const revExec2 = execSync;

  // Resolve repo root
  const reviewRepoDir = resolveRepoRoot(ctx.config.workingDir);

  // Get diff ref for the reviewer prompt — use preMergeHash..mergeCommit for accurate agent-only diff
  // Using mergeCommit (not HEAD) prevents including unrelated commits added after the merge
  const diffRef = (() => {
    if (ctx.preMergeHash && ctx.mergeCommit) return `${ctx.preMergeHash}..${ctx.mergeCommit}`;
    if (ctx.preMergeHash) return `${ctx.preMergeHash}..HEAD`;
    try {
      const parents = revExec2("git cat-file -p HEAD", { cwd: reviewRepoDir, stdio: "pipe" }).toString();
      const parentCount = (parents.match(/^parent /gm) || []).length;
      return parentCount === 0 ? "--root HEAD" : "HEAD~1..HEAD";
    } catch { return "HEAD~1..HEAD"; }
  })();

  // Get diff stat for context (full output with line counts)
  let filesChanged: string[] = [];
  let diffStatFull = "";
  try {
    diffStatFull = revExec2(`git diff ${diffRef} --stat`, { cwd: reviewRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
    filesChanged = diffStatFull.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch { /* empty */ }

  // Check diff size — too large means task should be split
  let diffLineCount = 0;
  try {
    const diffRaw = revExec2(`git diff ${diffRef} --stat`, { cwd: reviewRepoDir, stdio: "pipe", timeout: 10_000 }).toString();
    const lastLine = diffRaw.trim().split("\n").pop() || "";
    const insertMatch = lastLine.match(/(\d+) insertion/);
    const deleteMatch = lastLine.match(/(\d+) deletion/);
    diffLineCount = (parseInt(insertMatch?.[1] || "0") + parseInt(deleteMatch?.[1] || "0"));
  } catch { /* non-fatal */ }

  if (diffLineCount > LIMITS.MAX_DIFF_LINES) {
    ui.warn(`[${phase}] ${label}: diff too large (${diffLineCount} lines) — NEEDS_CHANGES`);
    ctx.reviewVerdict = "NEEDS_CHANGES";
    try {
      await ctx.api.updateTask(ctx.task.id, {
        review_comment: JSON.stringify({
          verdict: "NEEDS_CHANGES",
          requirement_match: "not assessed — diff too large",
          files_changed: diffStatFull || filesChanged.join(", "),
          code_quality: "not assessed",
          test_coverage: "not assessed",
          risks: `Diff is ${diffLineCount} lines. Task should be split into smaller subtasks for reliable review.`,
        }),
        review_verdict: "NEEDS_CHANGES",
      } as Partial<Task>);
    } catch { /* non-fatal */ }
    return;
  }

  // Extract Builder's intent from RETRO_JSON (if available in ctx)
  let builderIntent = "";
  if (ctx.retroJson) {
    const parts: string[] = [];
    if (ctx.retroJson.went_well) parts.push(`What went well: ${ctx.retroJson.went_well}`);
    if (ctx.retroJson.to_improve) parts.push(`What to improve: ${ctx.retroJson.to_improve}`);
    if (parts.length > 0) {
      builderIntent = `\n## Builder's Self-Assessment\n${parts.join("\n")}\n`;
      ui.info(`[${phase}] ${label}: injecting Builder intent (${parts.length} items)`);
    }
  }

  // Re-fetch task to ensure we have the latest data (prevents wrong-task reference bug)
  try {
    const res = await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}`, {
      headers: createAuthHeaders(ctx.config.apiKey),
    });
    if (res.ok) {
      const freshTask = (await res.json()) as Task;
      ctx.task = { ...ctx.task, ...freshTask };
    }
  } catch { /* use existing task data */ }

  // Build reviewer prompt
  const taskType = ctx.task.type as string || "implementation";
  const { PROMPT_TEMPLATES } = await import("../manager/prompts/templates.js");
  const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

  // Fetch playbook rules for reviewer, including skill rules matching task labels
  let customRules = "";
  const taskLabels = parseTaskLabels(ctx.task);
  try { customRules = await ctx.api.fetchPlaybookPrompt("reviewer", taskLabels) || ""; } catch { /* non-fatal */ }

  let fullPrompt: string;

  if (ctx.mergeSkipped && ctx.completionJson?.review_comment) {
    // No code changes — Reviewer verifies the agent's completion claim
    const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';
    fullPrompt = `You are a strict code reviewer for project.
Task: ${ctx.task.title}
Type: ${taskType}
Description: ${ctx.task.description || "(no description)"}

The Builder agent reported NO CODE CHANGES were needed:
"${ctx.completionJson.review_comment}"

Verify this claim:
1. Check if the task requirements are actually already met in the codebase
2. Run tests if applicable (${ctx.config.testCommand || "npm test"})
3. If the agent's claim is correct and the task is truly complete, verdict = APPROVE
4. If the task is NOT actually complete, verdict = NEEDS_CHANGES with explanation

${customRules}

Output format: ${outputFormat}`;
  } else {
    const reviewerTemplate = getDefaultTemplates().find((t) => t.id === "reviewer")!;
    const reviewCriteria = [
      "1. REQUIREMENT MATCH: Do changes address the task description? Unrelated = NEEDS_CHANGES",
      "2. SCOPE: Limited to what the task asks? Out-of-scope = NEEDS_CHANGES",
      "3. MEANINGFUL CHANGES: Real code/content? Metadata-only = NEEDS_CHANGES",
      "4. CODE QUALITY: Readability, security, error handling",
      `5. ${typeHints[taskType] || typeHints.implementation || ""}`,
      "",
      "If tests fail, verdict MUST be NEEDS_CHANGES.",
      "If changes don't match the task, verdict MUST be NEEDS_CHANGES.",
    ].join("\n");

    const reviewPrompt = interpolate(reviewerTemplate.prompt.completion, {
      diffRef,
      taskTitle: ctx.task.title,
      taskDescription: ctx.task.description || "(no description)",
      taskType,
      reviewCriteria,
      customReviewRules: customRules ? `\n${customRules}` : "",
      testCommand: ctx.config.testCommand || "npm test",
    });

    fullPrompt = `${reviewerTemplate.prompt.mode_header}\n\nTask: ${ctx.task.title}\nType: ${taskType}\n\n## Diff Stat\n${diffStatFull || "unknown"}\n${builderIntent}\n${reviewPrompt}`;
  }

  // Spawn reviewer as agent process
  ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
  ui.info(`[${phase}] ${label}: spawning Reviewer agent (${filesChanged.length} files)`);

  // Use agent's DB engine setting for model resolution (respects dashboard config)
  const reviewerModel = resolveModelForRole("reviewer", ctx.config.agentEngine);
  const reviewResult = await spawnClaudeOnce(fullPrompt, {
    model: reviewerModel, role: "reviewer", maxTurns: 5, timeout: TIMEOUTS.REVIEWER, cwd: reviewRepoDir,
  });

  // Parse COMPLETION_JSON from reviewer output (supports COMPLETION_JSON: prefix and ```json blocks)
  let verdict: "APPROVE" | "NEEDS_CHANGES" = "NEEDS_CHANGES";
  let reviewComment = "";
  let reviewerRecord: ReviewerRecord | undefined;
  const completionMatch = reviewResult.match(/COMPLETION_JSON:(\{[\s\S]*?\})\s*$/m)
    || reviewResult.match(/```json\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/m)
    || reviewResult.match(/(\{[\s\S]*?"verdict"\s*:\s*"(?:APPROVE|NEEDS_CHANGES)"[\s\S]*?\})\s*$/m);
  if (completionMatch) {
    try {
      const report = JSON.parse(completionMatch[1]) as Record<string, unknown>;
      // Normalize verdict
      const v = String(report.verdict || "").toUpperCase();
      verdict = (v.includes("APPROVE") && !v.includes("NEEDS")) ? "APPROVE" : "NEEDS_CHANGES";
      report.verdict = verdict;
      reviewComment = JSON.stringify(report);

      // Build ReviewerRecord from report fields
      const findings: ReviewFinding[] = [];
      if (report.requirement_match) findings.push({ severity: "info", message: `[requirement] ${report.requirement_match}` });
      if (report.code_quality) findings.push({ severity: "info", message: `[quality] ${report.code_quality}` });
      if (report.test_coverage) findings.push({ severity: "info", message: `[tests] ${report.test_coverage}` });
      if (report.risks && String(report.risks).toLowerCase() !== "none") findings.push({ severity: "warn", message: `[risks] ${report.risks}` });
      const reasoningParts = [report.requirement_match, report.code_quality, report.test_coverage, report.risks].filter(Boolean).map(String);
      reviewerRecord = {
        verdict,
        findings,
        reasoning: reasoningParts.join(" | ") || "No detailed reasoning",
        score: typeof report.score === "number" ? report.score : undefined,
      };

      // Save structured review
      try {
        await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}/review-report`, {
          method: "POST",
          headers: createAuthHeaders(ctx.config.apiKey),
          body: JSON.stringify(report),
        });
      } catch { /* fallback below */ }
    } catch {
      reviewComment = reviewResult.slice(-2000);
    }
  } else {
    // No COMPLETION_JSON — use raw output as review
    reviewComment = reviewResult.slice(-2000) || "Reviewer agent produced no output";
  }

  // Save review comment if not saved via review-report
  if (!completionMatch) {
    await ctx.api.updateTask(ctx.task.id, { review_comment: reviewComment } as Partial<Task>);
  }

  // Second opinion gate: Manager re-evaluates NEEDS_CHANGES verdicts
  if (verdict === "NEEDS_CHANGES" && reviewComment) {
    ui.info(`[${phase}] ${label}: NEEDS_CHANGES — requesting Manager second opinion...`);
    try {
      const secondOpinionPrompt = `A Reviewer agent judged this task as NEEDS_CHANGES. Review the assessment and decide if the rejection is justified.

Task: ${ctx.task.title}
Type: ${taskType}
Description: ${ctx.task.description || "(none)"}

Reviewer's assessment:
${reviewComment}

If the rejection is clearly correct (real bugs, test failures, missing requirements), respond: CONFIRM_REJECT
If the rejection seems overly strict, cosmetic, or based on style preferences rather than correctness, respond: OVERRIDE_APPROVE

Respond with ONLY one of: CONFIRM_REJECT or OVERRIDE_APPROVE`;

      const managerResult = await spawnClaudeOnce(secondOpinionPrompt, {
        role: "manager", maxTurns: 1, timeout: 60_000, cwd: resolveRepoRoot(ctx.config.workingDir),
      });

      // Extract Manager reasoning from output (first line or full text)
      const managerReasoning = managerResult.replace(/^(OVERRIDE_APPROVE|CONFIRM_REJECT)\s*/i, "").trim().slice(0, 500) || "No detailed reasoning provided";

      const isOverride = managerResult.includes("OVERRIDE_APPROVE");
      const managerRecord: ManagerRecord = {
        action: isOverride ? "override" : "accept",
        original_verdict: "NEEDS_CHANGES",
        reasoning: managerReasoning,
      };
      // Build fallback reviewerRecord from raw reviewComment if structured parse failed
      const finalReviewerRecord = reviewerRecord ?? {
        verdict: "NEEDS_CHANGES" as const,
        findings: [{ severity: "info" as const, message: reviewComment.slice(0, 500) }],
        reasoning: reviewComment.slice(0, 300),
      };
      ctx.reviewRecord = { ...ctx.reviewRecord, reviewer: finalReviewerRecord, manager: managerRecord };

      if (isOverride) {
        ui.info(`[${phase}] ${label}: Manager overrides → APPROVE (Reviewer was too strict)`);
        ctx.eventEmitter?.infraError(ctx.agentName, ctx.task.id, {
          category: "playbook_false_positive",
          summary: "Manager overrode Reviewer rejection — deemed overly strict",
        });
        ctx.eventEmitter?.reviewCompleted(ctx.task.id, ctx.agentName, {
          verdict: "APPROVE", classification: "infra", infra_category: "playbook_false_positive",
          original_verdict: "NEEDS_CHANGES",
        });
        verdict = "APPROVE";
        // Preserve original reviewer report, add override metadata
        const overrideComment = JSON.stringify({
          ...(completionMatch ? JSON.parse(completionMatch[1]) : {}),
          verdict: "APPROVE",
          manager_override: managerReasoning,
          original_reviewer_verdict: "NEEDS_CHANGES",
        });
        // Don't overwrite reviewComment — keep original for reference in review_record
        await ctx.api.updateTask(ctx.task.id, { review_comment: overrideComment } as Partial<Task>);
      } else {
        ui.info(`[${phase}] ${label}: Manager confirms NEEDS_CHANGES`);
      }
    } catch (err) {
      ui.warn(`[${phase}] ${label}: Second opinion failed (${err}), keeping NEEDS_CHANGES`);
    }
  }

  ctx.reviewVerdict = verdict;

  // If reviewer record was built but no manager gate was triggered, set it now
  if (reviewerRecord && !ctx.reviewRecord?.manager) {
    ctx.reviewRecord = { ...ctx.reviewRecord, reviewer: reviewerRecord };
  }

  // Persist review_record + verdict to API
  try {
    const updatePayload: Partial<Task> & { review_record?: string } = { review_verdict: verdict };
    if (ctx.reviewRecord) {
      updatePayload.review_record = JSON.stringify(ctx.reviewRecord);
    }
    await ctx.api.updateTask(ctx.task.id, updatePayload as Partial<Task>);
  } catch { /* non-fatal — review_comment still has the data */ }

  ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: reviewComment, review_verdict: verdict });
  ctx.onReviewUpdate?.(ctx.task.id, "completed", reviewComment);
  ui.info(`[${phase}] ${label}: verdict = ${verdict}`);

  // --- Async self-contained post-review logic ---
  // Since spawn_reviewer runs fire-and-forget (after slot release),
  // retry and auto-transition must be handled here.

  if (verdict === "NEEDS_CHANGES") {
    // Classify rejection: infrastructure issue vs code quality
    // Note: Manager OVERRIDE_APPROVE is handled above (records infra event and flips to APPROVE)
    // If we reach here, Manager confirmed NEEDS_CHANGES or second opinion was skipped
    const agentStderr = (ctx.agentStderr ?? []).join("\n");
    const { classification, category, reason } = classifyRejection(reviewComment, agentStderr, false);

    // Enrich review event with classification
    ctx.eventEmitter?.reviewCompleted(ctx.task.id, ctx.agentName, {
      verdict, classification, infra_category: category, reason,
    });

    if (classification === "infra") {
      // Infrastructure issue — don't retry, create bug ticket instead
      ui.warn(`[reviewer] Infra issue detected: [${category}] ${reason}`);
      ctx.eventEmitter?.infraError(ctx.agentName, ctx.task.id, {
        category: category ?? "unknown",
        summary: reason ?? "Infrastructure error caused review failure",
      });

      await ctx.api.updateTask(ctx.task.id, {
        status: "blocked",
        review_comment: `[Infra: ${category}] ${reason}. Original review: ${reviewComment.slice(0, 500)}`,
      } as Partial<Task>);
      ctx.onDataUpdate?.("task", ctx.task.id, { status: "blocked" });

      // Auto-create bug ticket in backlog
      try {
        await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks`, {
          method: "POST",
          headers: createAuthHeaders(ctx.config.apiKey),
          body: JSON.stringify({
            title: `[Infra] ${category}: ${reason}`,
            description: `Auto-generated from review failure.\nTask: ${ctx.task.title} (${ctx.task.id})\nAgent: ${ctx.agentName}\nReview: ${reviewComment.slice(0, 1000)}`,
            type: "bug",
            priority: "p1",
            owner: "user",
            sprint: -1,
            category: "mutating",
          }),
        });
      } catch { /* best-effort */ }
    } else {
      // Code quality issue — normal retry flow
      const { trackRetry } = await import("../utils/retry-tracker.js");
      const { retryCount, maxed } = trackRetry(ctx.task.id);

      // Record failure to Failure DB (only on first attempt)
      if (retryCount === 1) {
        ctx.api.recordFailure({
          task_id: ctx.task.id,
          failure_type: "reject",
          summary: `NEEDS_CHANGES: ${ctx.task.title}`,
          agent_name: ctx.agentName,
          sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
          review_comment: reviewComment,
        }).catch(() => { /* best-effort */ });
      }

      if (maxed) {
        await ctx.api.updateTask(ctx.task.id, {
          status: "review",
          review_comment: `Blocked: task failed ${retryCount} times. Needs human intervention.`,
        } as Partial<Task>);
        ui.error(`[reviewer] Task failed ${retryCount} times — blocked for human intervention`);
      } else {
        await ctx.api.updateTask(ctx.task.id, { status: "todo" } as Partial<Task>);
        ctx.onDataUpdate?.("task", ctx.task.id, { status: "todo" });
        ui.warn(`[reviewer] NEEDS_CHANGES (attempt ${retryCount}/3) — resetting to todo`);
      }
    }
  } else if (verdict === "APPROVE") {
    // Check auto-transition: if all tasks done, move sprint to review phase
    if (ctx.config.sprintNumber != null) {
      try {
        const result = await ctx.api.checkAutoTransition(ctx.config.sprintNumber);
        if (result.transitioned) {
          ui.info(`[sprint] Auto-transition: ${result.from} → ${result.to}`);
          ctx.onDataUpdate?.("sprint", String(ctx.config.sprintNumber), { status: result.to });
        }
      } catch { /* non-fatal */ }
    }
  }
}
