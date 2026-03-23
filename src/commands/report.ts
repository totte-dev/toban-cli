/**
 * Report command — investigate an issue, match to existing tasks, or create new ones.
 *
 * Usage:
 *   toban report "push が 403 で失敗してる"
 *
 * Flow:
 *   1. Search shared knowledge, error logs, and backlog for related info
 *   2. Use LLM to analyze findings and match to existing tasks
 *   3. Present findings to user (existing task match or new task suggestion)
 *   4. On user confirmation, create the task in backlog
 */

import { createApiClient, createAuthHeaders, type Task } from "../services/api-client.js";
import * as ui from "../ui.js";

export async function handleReport(
  apiUrl: string,
  apiKey: string,
  issue: string,
): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const headers = createAuthHeaders(apiKey);

  ui.intro();
  const s = ui.createSpinner();

  // Step 1: Gather context
  s.start("Searching knowledge base and backlog...");

  let sharedMemories: Array<{ key: string; content: string }> = [];
  try {
    const res = await fetch(`${apiUrl}/api/v1/agents/memories/shared`, { headers });
    if (res.ok) {
      const data = await res.json() as { memories?: Array<{ key: string; content: string }> };
      sharedMemories = data.memories || [];
    }
  } catch { /* non-fatal */ }

  let backlogTasks: Task[] = [];
  try {
    backlogTasks = await api.fetchTasks(-1);
  } catch { /* non-fatal */ }

  // Fetch current sprint tasks (not all tasks)
  let sprintTasks: Task[] = [];
  try {
    const sprints = await fetch(`${apiUrl}/api/v1/sprints`, { headers });
    if (sprints.ok) {
      const list = await sprints.json() as Array<{ number: number; status: string }>;
      const active = list.find((sp) => sp.status === "active");
      if (active) {
        sprintTasks = await api.fetchTasks(active.number);
      }
    }
  } catch { /* non-fatal */ }

  // Check error logs
  let errorLogs = "";
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const logPath = join(homedir(), ".toban", "logs", "error.log");
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      errorLogs = lines.slice(-50).join("\n");
    }
  } catch { /* non-fatal */ }

  s.stop(`Found: ${sharedMemories.length} knowledge entries, ${backlogTasks.length + sprintTasks.length} tasks, ${errorLogs ? "error logs" : "no error logs"}`);

  // Step 2: LLM analysis
  s.start("Analyzing issue...");

  const knowledgeSummary = sharedMemories
    .slice(0, 20)
    .map((m) => `[${m.key}] ${m.content.slice(0, 200)}`)
    .join("\n");

  const allTasks = [...sprintTasks, ...backlogTasks];
  const taskSummary = allTasks
    .slice(0, 30)
    .map((t) => `[${t.id.slice(0, 8)}] [${t.status}] ${t.title}${t.description ? " — " + t.description.slice(0, 100) : ""}`)
    .join("\n");

  const { spawnClaudeOnce } = await import("../utils/spawn-claude.js");
  const prompt = `You are a triage agent. A user reports an issue. Search the provided context and determine:
1. Is this a known issue? Match to an existing task if possible.
2. If not, suggest a new backlog task.

## User Report
${issue}

## Shared Knowledge
${knowledgeSummary || "(none)"}

## Recent Error Logs
${errorLogs.slice(-2000) || "(none)"}

## Existing Tasks (sprint + backlog)
${taskSummary || "(none)"}

Output ONLY a JSON object (no markdown, no explanation):
{
  "analysis": "Brief analysis of what the issue is and what you found",
  "matched_task_id": "8-char prefix if an existing task matches, or null",
  "new_task": {
    "title": "Suggested task title (if no match)",
    "description": "Task description",
    "priority": "p0|p1|p2|p3",
    "type": "bug|feature|chore|infra"
  } or null
}

Rules:
- If an existing task clearly covers this issue, set matched_task_id and new_task=null
- If no match, set matched_task_id=null and suggest a new_task
- analysis should be 1-3 sentences explaining your reasoning`;

  const result = await spawnClaudeOnce(prompt, { role: "strategist", maxTurns: 1, timeout: 60_000 });
  s.stop("Analysis complete");

  // Parse result
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    ui.error("Failed to parse analysis result");
    console.log(result.slice(-1000));
    return;
  }

  try {
    const finding = JSON.parse(jsonMatch[0]) as {
      analysis: string;
      matched_task_id: string | null;
      new_task: { title: string; description: string; priority: string; type: string } | null;
    };

    console.log(`\n--- Report Analysis ---`);
    console.log(`Issue: ${issue}`);
    console.log(`Analysis: ${finding.analysis}`);

    if (finding.matched_task_id) {
      const matched = allTasks.find((t) => t.id.startsWith(finding.matched_task_id!));
      if (matched) {
        console.log(`\nMatched existing task:`);
        console.log(`  [${matched.id.slice(0, 8)}] ${matched.title}`);
        console.log(`  Status: ${matched.status} | Priority: ${matched.priority}`);
        if (matched.description) console.log(`  ${matched.description.slice(0, 200)}`);
        console.log(`\nNo new task needed — existing task covers this issue.`);
      } else {
        console.log(`\nMatched task ID ${finding.matched_task_id} but not found in current tasks.`);
      }
    } else if (finding.new_task) {
      console.log(`\nSuggested new task:`);
      console.log(`  Title: ${finding.new_task.title}`);
      console.log(`  Priority: ${finding.new_task.priority}`);
      console.log(`  Type: ${finding.new_task.type}`);
      console.log(`  Description: ${finding.new_task.description.slice(0, 300)}`);

      // Confirm before creating
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("\nCreate this task in backlog? (Y/n) ", (a) => { rl.close(); resolve(a.trim()); });
      });

      if (answer === "" || answer.toLowerCase() === "y") {
        try {
          const res = await fetch(`${apiUrl}/api/v1/tasks`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              title: finding.new_task.title,
              description: finding.new_task.description,
              priority: finding.new_task.priority,
              type: finding.new_task.type,
              owner: "user",
              sprint: -1,
            }),
          });
          if (res.ok) {
            console.log(`Task created in backlog.`);
          } else {
            ui.error(`Failed to create task: ${res.status}`);
          }
        } catch (err) {
          ui.error(`Failed to create task: ${err}`);
        }
      } else {
        console.log("Skipped task creation.");
      }
    } else {
      console.log(`\nNo matching task found and no new task suggested.`);
    }
  } catch (e) {
    ui.error(`Failed to parse analysis: ${e}`);
    console.log(result.slice(-500));
  }
}
