/**
 * Review command — spawn an interactive Reviewer agent.
 *
 * Usage:
 *   toban review                          # review latest done/review task
 *   toban review --task <id>              # review a specific task
 *   toban review --diff <range>           # custom diff range (e.g. HEAD~5..HEAD)
 *   toban review --skill react,security   # match playbook rules by skill tags
 *
 * Engine-agnostic: uses AgentConfig.readOnly to restrict tools per engine.
 */

import { createApiClient, createAuthHeaders, type Task } from "../api-client.js";
import { spawnAgent } from "../spawner.js";
import { getEngine, extractTextFromStreamJson } from "../agent-engine.js";
import { resolveModelForRole } from "../agent-engine.js";
import * as ui from "../ui.js";
import { parseTaskLabels } from "../utils/parse-labels.js";
import { TIMEOUTS } from "../constants.js";
import type { AgentType } from "../types.js";

export async function handleReview(
  apiUrl: string,
  apiKey: string,
  taskId?: string,
  skills?: string[],
  diffRange?: string,
  engine: AgentType = "claude",
): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const { execSync: revExec } = await import("node:child_process");

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
  const cwd = process.cwd();
  let diffRef = diffRange || "HEAD~1..HEAD";
  if (!diffRange) {
    try {
      const parents = revExec("git cat-file -p HEAD", { cwd, stdio: "pipe" }).toString();
      const parentCount = (parents.match(/^parent /gm) || []).length;
      if (parentCount === 0) diffRef = "--root HEAD";
    } catch { /* default */ }
  }
  ui.info(`[review] Diff range: ${diffRef}`);

  // Build reviewer prompt
  const { PROMPT_TEMPLATES } = await import("../prompts/templates.js");
  const { interpolate } = await import("../agent-templates.js");
  const taskType = (task?.type as string) || "implementation";
  const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

  // Fetch playbook rules
  const reviewTags = skills || (task ? parseTaskLabels(task) : []);
  let customRules = "";
  try { customRules = await api.fetchPlaybookPrompt("reviewer", reviewTags) || ""; } catch { /* non-fatal */ }
  if (reviewTags.length > 0) {
    ui.info(`[review] Tags for skill matching: ${reviewTags.join(", ")}`);
  }

  const reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
    projectName: cwd.split("/").pop() || "unknown",
    language: "English",
    taskTitle: task?.title || "Manual review request",
    taskType,
    taskDescription: task?.description || "(manual review — no task description)",
    taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
    customReviewRules: customRules ? `\n${customRules}` : "",
  });
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
      // For structured output engines, extract text content
      const text = agentEngine.supportsStructuredOutput
        ? extractTextFromStreamJson(output)
        : output;
      resolve(text);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(output || "Error: Failed to spawn reviewer");
    });
  });

  s.stop("Review complete");

  // Parse COMPLETION_JSON
  const match = result.match(/COMPLETION_JSON:(\{[\s\S]*?\})\s*$/m)
    || result.match(/```json\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/m)
    || result.match(/(\{[\s\S]*?"verdict"\s*:\s*"(?:APPROVE|NEEDS_CHANGES)"[\s\S]*?\})\s*$/m);

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
    } catch {
      console.log("\n--- Raw Review Output ---");
      console.log(result.slice(-2000));
    }
  } else {
    console.log("\n--- Raw Output (no structured review found) ---");
    console.log(result.slice(-2000));
  }
}
