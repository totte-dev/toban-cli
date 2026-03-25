/**
 * Review command — spawn an interactive Reviewer agent.
 *
 * Usage:
 *   toban review                          # review latest done/review task
 *   toban review --task <id>              # review a specific task
 *   toban review --diff <range>           # custom diff range (e.g. HEAD~5..HEAD)
 *   toban review --repo ../other-repo     # review diff in a different repo
 *
 * Engine-agnostic: uses AgentConfig.readOnly to restrict tools per engine.
 */

import { createApiClient, createAuthHeaders, type Task } from "../services/api-client.js";
import { spawnAgent } from "../agents/spawner.js";
import { getEngine, extractTextFromStreamJson } from "../agents/agent-engine.js";
import { resolveModelForRole } from "../agents/agent-engine.js";
import * as ui from "../ui.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { TIMEOUTS } from "../constants.js";
import type { AgentType } from "../types.js";

export async function handleReview(
  apiUrl: string,
  apiKey: string,
  taskId?: string,
  diffRange?: string,
  engine: AgentType = "claude",
  usePr = false,
  repoDir?: string,
): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const { execSync: revExec } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const cwd = repoDir ? resolve(repoDir) : process.cwd();

  ui.intro();
  const s = ui.createSpinner();

  // Get task to review (optional — can review without a task)
  let task: Task | null = null;
  if (taskId) {
    s.start(`Fetching task ${taskId}...`);
    const tasks = await api.fetchTasks();
    const found = tasks.find((t: Task) => t.id.startsWith(taskId));
    if (!found) { s.stop("Not found"); ui.error(`Task ${taskId} not found`); process.exit(1); }
    task = found;
    s.stop(`Reviewing: ${task.title}`);
  } else if (diffRange) {
    // When --diff is provided without --task, try to match task from commit messages
    s.start("Matching task from commit messages...");
    try {
      const commitLog = revExec(`git log --format=%s ${diffRange}`, { cwd, stdio: "pipe" }).toString().trim();
      const tasks = await api.fetchTasks();
      // Look for task ID patterns in commit messages (8-char hex prefix or full UUID)
      const idPattern = /\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
      const matches = commitLog.match(idPattern) || [];
      for (const candidate of matches) {
        const prefix = candidate.slice(0, 8).toLowerCase();
        const found = tasks.find((t: Task) => t.id.toLowerCase().startsWith(prefix));
        if (found) {
          task = found;
          break;
        }
      }
      if (task) {
        s.stop(`Matched task from commits: ${task.title}`);
      } else {
        s.stop("No task matched — will do pure code quality review");
      }
    } catch {
      s.stop("Could not parse commits — will do pure code quality review");
    }
  } else {
    s.start("Finding latest review task...");
    const tasks = await api.fetchTasks();
    const reviewTask = tasks.find((t: Task) => t.status === "review" || t.status === "done");
    if (reviewTask) {
      task = reviewTask;
      s.stop(`Reviewing: ${task.title}`);
    } else {
      s.stop("No task found — reviewing working tree diff");
    }
  }

  // Determine diff range
  let diffRef = diffRange || "HEAD~1..HEAD";
  if (!diffRange) {
    try {
      const parents = revExec("git cat-file -p HEAD", { cwd, stdio: "pipe" }).toString();
      const parentCount = (parents.match(/^parent /gm) || []).length;
      if (parentCount === 0) diffRef = "--root HEAD";
    } catch { /* default */ }
  }
  ui.info(`[review] Diff range: ${diffRef}`);

  // PR mode: create a branch + PR before reviewing
  let prNumber: number | null = null;
  let prBranch: string | null = null;
  if (usePr) {
    s.start("Creating review PR...");
    try {
      const currentBranch = revExec("git branch --show-current", { cwd, stdio: "pipe" }).toString().trim();
      const baseBranch = revExec("git rev-parse --abbrev-ref HEAD@{upstream} 2>/dev/null || echo main", { cwd, stdio: "pipe" }).toString().trim().replace(/^origin\//, "") || "main";

      if (currentBranch === "main" || currentBranch === baseBranch) {
        // On main — create a review branch from the diff range, move commits there
        const diffBase = diffRef.split("..")[0] || "HEAD~1";
        prBranch = `review/${Date.now().toString(36)}`;
        // Create branch at HEAD, then reset main to the base
        revExec(`git branch ${prBranch}`, { cwd, stdio: "pipe" });
        revExec(`git reset --hard ${diffBase}`, { cwd, stdio: "pipe" });
        revExec(`git push origin ${prBranch}`, { cwd, stdio: "pipe", timeout: 30_000 });
        revExec(`git push origin ${currentBranch} --force-with-lease`, { cwd, stdio: "pipe", timeout: 30_000 });
        // Update diffRef to PR branch vs main
        diffRef = `${currentBranch}..${prBranch}`;
      } else {
        // Already on a feature branch — just push and create PR
        prBranch = currentBranch;
        revExec(`git push -u origin ${prBranch}`, { cwd, stdio: "pipe", timeout: 30_000 });
      }

      // Create PR via gh CLI
      const prTitle = task ? `Review: ${task.title}` : `Review: ${prBranch}`;
      const prBody = task ? `Automated review for task ${task.id.slice(0, 8)}: ${task.title}` : "Automated review PR";
      const prOutput = revExec(
        `gh pr create --base ${baseBranch} --head ${prBranch} --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
        { cwd, stdio: "pipe", timeout: 30_000 },
      ).toString().trim();

      // Extract PR number from URL
      const prMatch = prOutput.match(/\/pull\/(\d+)/);
      prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
      s.stop(`PR created: ${prOutput}`);
    } catch (prErr) {
      s.stop("PR creation failed");
      ui.error(`[review] Failed to create PR: ${prErr instanceof Error ? prErr.message : prErr}`);
      ui.info("[review] Falling back to local review");
    }
  }

  // Build reviewer prompt
  const { PROMPT_TEMPLATES } = await import("../manager/prompts/templates.js");
  const { interpolate } = await import("../agents/agent-templates.js");
  const taskType = (task?.type as string) || "implementation";
  const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

  const reviewTags = task ? parseTaskLabels(task) : [];
  const customRules = "";

  let reviewSystem: string;
  if (task) {
    // Task matched — use the full reviewer-system template with task context
    reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
      projectName: cwd.split("/").pop() || "unknown",
      language: "English",
      taskTitle: task.title,
      taskType,
      taskDescription: task.description || "(no description)",
      taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
      customReviewRules: customRules ? `\n${customRules}` : "",
    });
  } else {
    // No task matched — pure code quality review (no requirement matching)
    reviewSystem = [
      `You are a strict code reviewer for project "${cwd.split("/").pop() || "unknown"}".`,
      `Reply in English. Output JSON only, no markdown.`,
      ``,
      `## Review Mode: Pure Code Quality (no task context)`,
      `No specific task was matched to this diff. Do NOT judge requirement fulfillment.`,
      `Instead, focus exclusively on:`,
      `1. CODE QUALITY: Readability, naming, structure, error handling`,
      `2. SECURITY: Injection risks, credential leaks, unsafe operations`,
      `3. CORRECTNESS: Logic errors, edge cases, null/undefined handling`,
      `4. TEST COVERAGE: Are changes tested? Do existing tests still pass?`,
      `5. STYLE: Consistency with surrounding code, no dead code or debug leftovers`,
      ``,
      `For requirement_match in your output, write "N/A — no task context, pure code quality review".`,
      customRules ? `\n${customRules}` : "",
    ].join("\n");
  }
  const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';

  const prompt = [
    reviewSystem,
    "",
    `## Your task`,
    `Review the code changes in diff range: ${diffRef}`,
    `Run: git diff ${diffRef} --stat`,
    `Then read the changed files and run tests.`,
    `When done, output your verdict.`,
    "",
    outputFormat,
  ].join("\n");

  // Spawn Reviewer via AgentConfig (engine-agnostic, readOnly enforced)
  s.start("Spawning Reviewer agent...");
  const reviewTaskId = task?.id || crypto.randomUUID();
  const model = resolveModelForRole("reviewer");

  const { process: child, agent } = spawnAgent({
    name: "reviewer",
    type: engine,
    taskId: reviewTaskId,
    workingDir: cwd,
    apiKey,
    apiUrl,
    prompt,
    readOnly: true,
    model,
  }, cwd); // cwd directly — no worktree needed

  // Collect output with timeout
  let output = "";
  const agentEngine = getEngine(engine);

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    // Parse structured output for progress display
    if (agentEngine.supportsStructuredOutput && agentEngine.parseOutputLine) {
      for (const line of text.split("\n").filter(Boolean)) {
        const activities = agentEngine.parseOutputLine(line);
        for (const a of activities) {
          if (a.kind === "tool" && a.tool) {
            ui.info(`  [reviewer] ${a.tool}: ${a.summary?.slice(0, 80) || ""}`);
          }
        }
      }
    }
  });
  child.stderr?.on("data", () => {}); // consume

  // Wait for completion or timeout
  const result = await new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(output || "Error: Review timed out");
    }, TIMEOUTS.REVIEWER);

    child.on("close", () => {
      clearTimeout(timeout);
      // For structured output engines, extract text from JSON lines
      let text = output;
      if (agentEngine.supportsStructuredOutput) {
        const parts: string[] = [];
        for (const line of output.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const extracted = extractTextFromStreamJson(event);
            if (extracted) parts.push(extracted);
          } catch { /* not JSON, keep raw */ }
        }
        text = parts.length > 0 ? parts.join("\n") : output;
      }
      resolve(text);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(output || "Error: Failed to spawn reviewer");
    });
  });

  s.stop("Review complete");

  // Parse COMPLETION_JSON
  const match = result
    ? (result.match(/COMPLETION_JSON:(\{[\s\S]*?\})\s*$/m)
      || result.match(/```json\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/m)
      || result.match(/(\{[\s\S]*?"verdict"\s*:\s*"(?:APPROVE|NEEDS_CHANGES)"[\s\S]*?\})\s*$/m))
    : null;

  if (match) {
    try {
      const report = JSON.parse(match[1]);
      console.log("\n--- Review Report ---");
      console.log(`Verdict: ${report.verdict}`);
      console.log(`Requirement: ${report.requirement_match}`);
      console.log(`Quality: ${report.code_quality}`);
      console.log(`Tests: ${report.test_coverage}`);
      console.log(`Risks: ${report.risks}`);

      // Save to API
      if (task) {
        try {
          await fetch(`${apiUrl}/api/v1/tasks/${task.id}/review-report`, {
            method: "POST",
            headers: createAuthHeaders(apiKey),
            body: JSON.stringify(report),
          });
          console.log(`\nReview saved to task #${task.id.slice(0, 8)}.`);
        } catch { /* non-fatal */ }
      }

      // Feed into rule-evaluation pipeline for learning
      try {
        await fetch(`${apiUrl}/api/v1/rule-evaluations/evaluate`, {
          method: "POST",
          headers: createAuthHeaders(apiKey),
          body: JSON.stringify({
            text: `${report.verdict}: ${report.code_quality || ""} ${report.risks || ""}`,
            source: "review",
          }),
        });
      } catch { /* non-fatal */ }

      // PR mode: post review as PR comment and handle merge
      if (prNumber && prBranch) {
        // Always save to DB (PR comment may fail due to permissions)
        if (!task) {
          try {
            // No task matched — store as a standalone review via a temp task-like record
            await fetch(`${apiUrl}/api/v1/messages`, {
              method: "POST",
              headers: createAuthHeaders(apiKey),
              body: JSON.stringify({
                from: "reviewer",
                to: "user",
                content: `PR #${prNumber} review: ${report.verdict}\n${report.code_quality || ""}\n${report.risks || ""}`.slice(0, 4000),
              }),
            });
          } catch { /* non-fatal */ }
        }

        // Try posting to PR (may fail if GitHub App lacks permission)
        try {
          const commentBody = [
            `## Review: ${report.verdict}`,
            "",
            `**Requirement:** ${report.requirement_match || "N/A"}`,
            `**Quality:** ${report.code_quality || "N/A"}`,
            `**Tests:** ${report.test_coverage || "N/A"}`,
            `**Risks:** ${report.risks || "N/A"}`,
          ].join("\n");

          revExec(`gh pr comment ${prNumber} --body "${commentBody.replace(/"/g, '\\"')}"`, { cwd, stdio: "pipe", timeout: 15_000 });
        } catch (ghErr) {
          ui.warn(`[review] PR comment failed (permissions?): ${ghErr instanceof Error ? ghErr.message : ghErr}`);
        }

        // Merge or leave open based on verdict
        try {
          if (report.verdict === "APPROVE") {
            revExec(`gh pr merge ${prNumber} --squash --delete-branch`, { cwd, stdio: "pipe", timeout: 30_000 });
            console.log(`\nPR #${prNumber} merged and branch deleted.`);
          } else {
            console.log(`\nPR #${prNumber} left open — verdict: NEEDS_CHANGES`);
          }
        } catch (ghErr) {
          ui.warn(`[review] PR merge failed: ${ghErr instanceof Error ? ghErr.message : ghErr}`);
        }
      }
    } catch {
      console.log("\n--- Raw Review Output ---");
      console.log(result.slice(-2000));
    }
  } else {
    console.log("\n--- Raw Output (no structured review found) ---");
    console.log(result.slice(-2000));
  }
}
