/**
 * Review command
 */

import { createApiClient, type Task } from "../api-client.js";
import { resolveModelForRole } from "../agent-engine.js";
import * as ui from "../ui.js";
import { parseTaskLabels } from "../utils/parse-labels.js";

export async function handleReview(apiUrl: string, apiKey: string, taskId?: string, skills?: string[]): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const { spawn } = await import("node:child_process");
  const { execSync: revExec } = await import("node:child_process");

  ui.intro();
  const s = ui.createSpinner();

  // Get task to review
  let task: Task;
  if (taskId) {
    s.start(`Fetching task ${taskId}...`);
    const tasks = await api.fetchTasks();
    const found = tasks.find((t: Task) => t.id.startsWith(taskId));
    if (!found) { s.stop("Not found"); ui.error(`Task ${taskId} not found`); process.exit(1); }
    task = found;
  } else {
    s.start("Finding latest review task...");
    const tasks = await api.fetchTasks();
    const reviewTask = tasks.find((t: Task) => t.status === "review");
    if (!reviewTask) { s.stop("None"); ui.error("No tasks in review status"); process.exit(1); }
    task = reviewTask;
  }
  s.stop(`Reviewing: ${task.title}`);

  // Get diff
  const cwd = process.cwd();
  let diffRef = "HEAD~1..HEAD";
  try {
    const parents = revExec("git cat-file -p HEAD", { cwd, stdio: "pipe" }).toString();
    const parentCount = (parents.match(/^parent /gm) || []).length;
    if (parentCount === 0) diffRef = "--root HEAD";
  } catch { /* default */ }

  // Build reviewer prompt
  const { PROMPT_TEMPLATES } = await import("../prompts/templates.js");
  const { interpolate } = await import("../agent-templates.js");
  const taskType = task.type as string || "implementation";
  const typeHints = JSON.parse(PROMPT_TEMPLATES["reviewer-type-hints"] || "{}") as Record<string, string>;

  // Fetch playbook rules including skill rules matching task labels or --skill args
  const reviewTags = skills || parseTaskLabels(task);
  let customRules = "";
  try { customRules = await api.fetchPlaybookPrompt("reviewer", reviewTags) || ""; } catch { /* non-fatal */ }
  if (reviewTags.length > 0) {
    ui.info(`[review] Tags for skill matching: ${reviewTags.join(", ")}`);
  }

  const reviewSystem = interpolate(PROMPT_TEMPLATES["reviewer-system"] || "", {
    projectName: cwd.split("/").pop() || "unknown",
    language: "English",
    taskTitle: task.title,
    taskType,
    taskDescription: task.description || "(no description)",
    taskTypeHint: typeHints[taskType] || typeHints.implementation || "",
    customReviewRules: customRules ? `\n${customRules}` : "",
  });
  const outputFormat = PROMPT_TEMPLATES["reviewer-output-format"] || '{"verdict":"APPROVE or NEEDS_CHANGES"}';

  const prompt = `${reviewSystem}\n\nRun: git diff ${diffRef}\nRun: npm test 2>&1 | tail -20\n\nThen output verdict.\n\n${outputFormat}`;

  s.start("Running Reviewer agent...");
  const result = await new Promise<string>((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn("claude", ["--print", "--model", resolveModelForRole("reviewer"), "--max-turns", "5", prompt], {
      env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
  s.stop("Review complete");

  // Parse and display
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
      try {
        await fetch(`${apiUrl}/api/v1/tasks/${task.id}/review-report`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(report),
        });
        console.log("\nReview saved to API.");
      } catch { /* non-fatal */ }
    } catch {
      console.log("\n--- Raw Review Output ---");
      console.log(result.slice(-1000));
    }
  } else {
    console.log("\n--- Raw Output (no structured review) ---");
    console.log(result.slice(-1000));
  }
}
