/**
 * toban status — Show current sprint state + progress summary.
 * Designed to be called by user's AI agent via Bash.
 */

import { createApiClient } from "../api-client.js";
import { getRunnerPid } from "./daemon.js";

export async function handleStatus(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);

  // Fetch workspace info
  const ws = await api.fetchWorkspace();
  console.log(`Workspace: ${ws.name}`);

  // Runner status
  const pid = getRunnerPid();
  console.log(`Runner: ${pid ? `active (PID ${pid})` : "not running"}`);
  console.log("");

  // Fetch sprints — find the latest active or most recent
  const res = await fetch(`${apiUrl}/api/v1/sprints`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const sprints = (await res.json()) as Array<{
    number: number; status: string; goal: string | null;
    created_at: string; completed_at: string | null;
  }>;

  const active = sprints.filter((s) => s.status === "active");
  const latest = active.length > 0 ? active[active.length - 1] : sprints[sprints.length - 1];

  if (!latest) {
    console.log("No sprints found. Run `toban start` to begin.");
    return;
  }

  console.log(`Sprint #${latest.number} [${latest.status}]`);
  if (latest.goal) console.log(`Goal: ${latest.goal}`);
  console.log("");

  // Fetch tasks for this sprint
  const tasks = await api.fetchTasks(latest.number);
  const done = tasks.filter((t) => t.status === "done");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const review = tasks.filter((t) => t.status === "review");
  const todo = tasks.filter((t) => t.status === "todo");

  const totalSP = tasks.reduce((s, t) => s + ((t.story_points as number) || 0), 0);
  const doneSP = done.reduce((s, t) => s + ((t.story_points as number) || 0), 0);

  console.log(`Progress: ${doneSP}/${totalSP} SP (${done.length}/${tasks.length} tasks)`);
  console.log("");

  if (inProgress.length > 0) {
    console.log(`In Progress (${inProgress.length}):`);
    for (const t of inProgress) {
      console.log(`  - ${t.title} [@${t.owner || "unassigned"}]`);
    }
    console.log("");
  }

  if (review.length > 0) {
    console.log(`Review (${review.length}):`);
    for (const t of review) {
      console.log(`  - ${t.title}`);
    }
    console.log("");
  }

  if (todo.length > 0) {
    console.log(`Todo (${todo.length}):`);
    for (const t of todo) {
      console.log(`  - [${t.priority}] ${t.title} (${(t.story_points as number) || "?"}SP)`);
    }
    console.log("");
  }

  if (done.length > 0) {
    console.log(`Done (${done.length}):`);
    for (const t of done) {
      console.log(`  - ${t.title}`);
    }
  }
}
