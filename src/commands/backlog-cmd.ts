/**
 * toban backlog — List backlog tasks grouped by priority.
 * Designed to be called by user's AI agent via Bash.
 */

import { createApiClient } from "../services/api-client.js";

export async function handleBacklog(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  const tasks = await api.fetchTasks(-1);

  if (tasks.length === 0) {
    console.log("Backlog is empty.");
    return;
  }

  // Group by priority
  const byPrio: Record<string, typeof tasks> = {};
  for (const t of tasks) {
    const p = (t.priority as string) || "p2";
    if (!byPrio[p]) byPrio[p] = [];
    byPrio[p].push(t);
  }

  const totalSP = tasks.reduce((s, t) => s + ((t.story_points as number) || 0), 0);
  console.log(`Backlog: ${tasks.length} tasks, ${totalSP} SP total`);
  console.log("");

  for (const prio of ["p0", "p1", "p2", "p3"]) {
    const group = byPrio[prio];
    if (!group || group.length === 0) continue;

    console.log(`${prio.toUpperCase()} (${group.length}):`);
    for (const t of group) {
      const sp = (t.story_points as number) || "?";
      const type = (t.type as string) || "feature";
      console.log(`  ${t.id.slice(0, 8)} | ${sp}SP | [${type}] ${t.title}`);
    }
    console.log("");
  }
}
