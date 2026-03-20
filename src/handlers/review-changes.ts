/**
 * Handler for the review_changes template action.
 * Reviews code changes using LLM (legacy single-turn review).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { TemplateAction, ActionContext } from "../agent-templates.js";
import { interpolate } from "../agent-templates.js";
import type { Task } from "../api-client.js";
import { createAuthHeaders, fetchWithRetry } from "../api-client.js";
import * as ui from "../ui.js";
import { logError, CLI_ERR } from "../error-logger.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { spawnClaudeOnce } from "../utils/spawn-claude.js";
import { resolveRepoRoot } from "../git-ops.js";
import { TIMEOUTS } from "../constants.js";

export async function handleReviewChanges(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "review_changes";
  ctx.onReviewUpdate?.(ctx.task.id, "started");
  const revExec = execSync;
  const revExists = existsSync;
  // workingDir may be a deleted worktree after git_merge — resolve repo root
  const revRepoDir = (() => {
    const resolved = resolveRepoRoot(ctx.config.workingDir);
    if (resolved !== ctx.config.workingDir) return resolved;
    // Worktree deleted — walk up to find the repo root
    // dirname imported at module top
    let dir = ctx.config.workingDir;
    for (let i = 0; i < 5; i++) {
      dir = dirname(dir);
      if (revExists(dir + "/.git")) return dir;
    }
    return ctx.config.workingDir;
  })();
  try {
    ui.debug("review", `repo dir: ${revRepoDir}`);
    // Get the merge commit and its details
    const lastCommit = revExec("git log --oneline -1", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();
    const commitBody = revExec("git log -1 --format=%b", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();
    // Use merge commit diff (HEAD^..HEAD for merge, HEAD~1 for regular, --root for initial)
    const parentCount = (revExec("git cat-file -p HEAD", { cwd: revRepoDir, stdio: "pipe" }).toString().match(/^parent /gm) || []).length;
    const diffRef = parentCount >= 2 ? "HEAD^..HEAD" : parentCount === 1 ? "HEAD~1" : "--root HEAD";
    const diffStat = revExec(`git diff ${diffRef} --stat`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
    const diffContent = revExec(`git diff ${diffRef} --no-color`, { cwd: revRepoDir, stdio: "pipe", timeout: 10_000 }).toString();

    // Build review summary with commit description + file stats
    const lines = diffContent.split("\n").length;
    const filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

    // Run tests before review to include results in the prompt
    let testResult = "";
    try {
      ctx.onReviewUpdate?.(ctx.task.id, "testing");
      const testOutput = revExec("npm test 2>&1 || true", {
        cwd: revRepoDir, stdio: "pipe", timeout: 60_000,
      }).toString().trim();
      const lastLines = testOutput.split("\n").slice(-10).join("\n");
      const passed = testOutput.includes("passed") && !testOutput.includes("failed");
      testResult = passed
        ? "Tests: ALL PASSED"
        : `Tests: SOME FAILED\n${lastLines}`;
    } catch {
      testResult = "Tests: could not run (no test script or timeout)";
    }

    // LLM review: ask Claude to review the diff against the task requirements
    ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
    let llmReview = "";
    try {
      // Keep full diff context but filter out test files for size reduction
      const diffLines = diffContent.split("\n");
      const filteredDiff: string[] = [];
      let inTestFile = false;
      for (const line of diffLines) {
        if (line.startsWith("diff --git")) {
          inTestFile = /test|spec|__tests__/i.test(line);
        }
        if (!inTestFile) filteredDiff.push(line);
      }
      const diffForReview = (filteredDiff.join("\n") || diffContent).slice(0, 6000);
      const lang = ctx.config.language === "ja" ? "Japanese" : "English";
      const taskType = ctx.task.type as string || "implementation";

      // Build review prompt from templates (customizable via prompts/templates.ts)
      const { PROMPT_TEMPLATES } = await import("../prompts/templates.js");
      const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;
      const reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
        projectName: ctx.config.workingDir.split("/").pop() || "unknown",
        language: lang,
        taskTitle: ctx.task.title,
        taskType,
        taskDescription: ctx.task.description || "(no description)",
        taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
        customReviewRules: await (async () => {
          const labels = parseTaskLabels(ctx.task);
          let rules = "";
          try { rules = await ctx.api.fetchPlaybookPrompt("reviewer", labels) || ""; } catch { /* */ }
          return rules ? `\n## Project-Specific Review Rules\n${rules}` : "";
        })()
      });
      const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';

      const reviewPrompt = `${reviewSystem}

${testResult}

Diff (${filesChanged.length} files, ${lines} lines):
${diffForReview}

If tests failed, verdict MUST be NEEDS_CHANGES.

${outputFormat}`;

      llmReview = await spawnClaudeOnce(reviewPrompt, {
        role: "reviewer", maxTurns: 1, timeout: TIMEOUTS.REVIEW_LLM,
      });
      llmReview = llmReview.trim();
    } catch (llmErr) {
      logError(CLI_ERR.REVIEW_LLM_FAILED, `LLM review failed`, { taskId: ctx.task.id }, llmErr);
      ui.warn(`[review] LLM review failed: ${llmErr instanceof Error ? llmErr.message : llmErr}`);
    }

    // Get commit hash for the merge
    const commitHash = revExec("git rev-parse HEAD", { cwd: revRepoDir, stdio: "pipe" }).toString().trim();

    // If LLM timed out or failed, generate a stat-based review
    if (!llmReview) {
      llmReview = JSON.stringify({
        requirement_match: "LLM review timed out — manual review recommended",
        files_changed: filesChanged.map((f) => f).join(", ") || "See diff stat",
        code_quality: "Unable to assess (LLM timeout)",
        test_coverage: "Unable to assess (LLM timeout)",
        risks: "Manual review required — automated review was not completed",
        verdict: "NEEDS_CHANGES",
      });
      ctx.reviewVerdict = "NEEDS_CHANGES";
      ui.info("[review] Generated fallback review (LLM timeout)");
    }

    // Try structured review-report API first
    let reviewSaved = false;
    if (llmReview) {
      try {
        // Parse LLM output as JSON (strip markdown code blocks if present)
        const cleanJson = llmReview.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
        const report = JSON.parse(cleanJson);
        report.commits = commitHash;
        // Append diff stat to files_changed for context
        if (diffStat) {
          report.files_changed = (report.files_changed || "") + "\n\n" + diffStat;
        }
        // Normalize verdict to match API enum
        if (report.verdict) {
          const v = String(report.verdict).toUpperCase().trim();
          if (v.includes("NEEDS") || v.includes("CHANGE") || v.includes("REJECT")) {
            report.verdict = "NEEDS_CHANGES";
          } else {
            report.verdict = "APPROVE";
          }
        }
        const res = await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}/review-report`, {
          method: "POST",
          headers: createAuthHeaders(ctx.config.apiKey),
          body: JSON.stringify(report),
        });
        if (res.ok) {
          reviewSaved = true;
          ctx.reviewVerdict = report.verdict as "APPROVE" | "NEEDS_CHANGES";
          const reviewJson = JSON.stringify(report);
          ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: reviewJson, commits: commitHash });
          ctx.onReviewUpdate?.(ctx.task.id, "completed", reviewJson);
        } else {
          const errBody = await res.text().catch(() => "");
          ui.warn(`[review] review-report API ${res.status}: ${errBody.slice(0, 200)}`);
        }
      } catch (parseErr) {
        ui.warn(`[review] Structured review failed: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }
    }

    // Fallback: save as plain text review
    if (!reviewSaved) {
      const review = [
        `Agent: ${ctx.agentName}`,
        `Commit: ${lastCommit}`,
        commitBody ? `\n${commitBody}` : "",
        `\nFiles changed: ${filesChanged.length}`,
        diffStat,
        lines > 200 ? `(${lines} lines of diff)` : "",
        llmReview ? `\n--- Code Review ---\n${llmReview}` : "",
      ].filter(Boolean).join("\n").slice(0, 4000);
      await ctx.api.updateTask(ctx.task.id, { review_comment: review, commits: commitHash } as Partial<Task>);
      ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: review, commits: commitHash });
      ctx.onReviewUpdate?.(ctx.task.id, "completed", review);
    }
    ui.info( `[${phase}] ${label}: ${filesChanged.length} files${llmReview ? " + LLM review" : ""}`);
  } catch (revErr) {
    const msg = revErr instanceof Error ? revErr.message : String(revErr);
    logError(CLI_ERR.ACTION_FAILED, `review_changes failed at ${revRepoDir}: ${msg}`, { taskId: ctx.task.id, repoDir: revRepoDir }, revErr);
    ui.warn(`[review] review_changes failed at ${revRepoDir}: ${msg}`);
    ctx.onReviewUpdate?.(ctx.task.id, "failed");
    // Still set a basic comment
    try {
      await ctx.api.updateTask(ctx.task.id, { review_comment: "Auto-review failed. Please review manually." } as Partial<Task>);
    } catch { /* non-fatal */ }
  }
}
