/**
 * Handler for the spawn_reviewer template action.
 * Spawns a Reviewer agent process to review code changes.
 */

import type { TemplateAction, ActionContext } from "../agent-templates.js";
import type { Task } from "../api-client.js";
import { fetchWithRetry } from "../api-client.js";
import { interpolate, getDefaultTemplates } from "../agent-templates.js";
import * as ui from "../ui.js";
import { resolveModelForRole } from "../agent-engine.js";
import { parseTaskLabels } from "../utils/parse-labels.js";

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
  const { execSync: revExec2 } = await import("node:child_process");
  const { existsSync: revExists2 } = await import("node:fs");
  const { spawn: reviewSpawn2 } = await import("node:child_process");

  // Resolve repo root
  const reviewRepoDir = (() => {
    if (revExists2(ctx.config.workingDir)) {
      try {
        return revExec2("git rev-parse --path-format=absolute --git-common-dir", { cwd: ctx.config.workingDir, stdio: "pipe" })
          .toString().trim().replace(/\/.git$/, "");
      } catch { /* fall through */ }
    }
    return ctx.config.workingDir;
  })();

  // Get diff ref for the reviewer prompt — use preMergeHash for accurate agent-only diff
  const diffRef = (() => {
    if (ctx.preMergeHash) return `${ctx.preMergeHash}..HEAD`;
    try {
      const parents = revExec2("git cat-file -p HEAD", { cwd: reviewRepoDir, stdio: "pipe" }).toString();
      const parentCount = (parents.match(/^parent /gm) || []).length;
      return parentCount === 0 ? "--root HEAD" : "HEAD~1..HEAD";
    } catch { return "HEAD~1..HEAD"; }
  })();

  // Get diff stat for context
  let filesChanged: string[] = [];
  try {
    const diffStat = revExec2(`git diff ${diffRef} --stat`, { cwd: reviewRepoDir, stdio: "pipe", timeout: 10_000 }).toString().trim();
    filesChanged = diffStat.split("\n").slice(0, -1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
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

  if (diffLineCount > 300) {
    ui.warn(`[${phase}] ${label}: diff too large (${diffLineCount} lines) — NEEDS_CHANGES`);
    ctx.reviewVerdict = "NEEDS_CHANGES";
    try {
      await ctx.api.updateTask(ctx.task.id, {
        review_comment: JSON.stringify({
          verdict: "NEEDS_CHANGES",
          requirement_match: "not assessed — diff too large",
          files_changed: filesChanged.join(", "),
          code_quality: "not assessed",
          test_coverage: "not assessed",
          risks: `Diff is ${diffLineCount} lines. Task should be split into smaller subtasks for reliable review.`,
        }),
      } as Partial<Task>);
    } catch { /* non-fatal */ }
    return;
  }

  // Build reviewer prompt
  const taskType = ctx.task.type as string || "implementation";
  const { PROMPT_TEMPLATES } = await import("../prompts/templates.js");
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
2. Run tests if applicable (npm test)
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
    });

    fullPrompt = `${reviewerTemplate.prompt.mode_header}\n\nTask: ${ctx.task.title}\nType: ${taskType}\nFiles changed: ${filesChanged.join(", ") || "unknown"}\n\n${reviewPrompt}`;
  }

  // Spawn reviewer as agent process
  ctx.onReviewUpdate?.(ctx.task.id, "analyzing");
  ui.info(`[${phase}] ${label}: spawning Reviewer agent (${filesChanged.length} files)`);

  const REVIEWER_TIMEOUT = 300_000; // 5 minutes
  const reviewResult = await new Promise<string>((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = reviewSpawn2("claude", [
      "--print", "--model", resolveModelForRole("reviewer"), "--max-turns", "5", fullPrompt,
    ], {
      env, cwd: reviewRepoDir, stdio: ["ignore", "pipe", "pipe"], timeout: REVIEWER_TIMEOUT,
    });
    let out = "";
    let resolved = false;
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", () => {}); // consume stderr
    child.on("close", () => { if (!resolved) { resolved = true; resolve(out); } });
    child.on("error", () => { if (!resolved) { resolved = true; resolve(out || ""); } });
    setTimeout(() => { if (!resolved) { resolved = true; try { child.kill(); } catch {} resolve(out || ""); } }, REVIEWER_TIMEOUT);
  });

  // Parse COMPLETION_JSON from reviewer output (supports COMPLETION_JSON: prefix and ```json blocks)
  let verdict: "APPROVE" | "NEEDS_CHANGES" = "NEEDS_CHANGES";
  let reviewComment = "";
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

      // Save structured review
      try {
        await fetchWithRetry(`${ctx.config.apiUrl}/api/v1/tasks/${ctx.task.id}/review-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.config.apiKey}` },
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

  ctx.reviewVerdict = verdict;
  ctx.onDataUpdate?.("task", ctx.task.id, { review_comment: reviewComment });
  ctx.onReviewUpdate?.(ctx.task.id, "completed", reviewComment);
  ui.info(`[${phase}] ${label}: verdict = ${verdict}`);
}
