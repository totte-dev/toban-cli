/**
 * `toban context` — Get project context on demand.
 *
 * Usage:
 *   toban context              # Full context (spec + rules + failures + sprint + knowledge)
 *   toban context spec         # Project spec only
 *   toban context rules        # Playbook rules only
 *   toban context failures     # Past failures only
 *   toban context sprint       # Current sprint tasks
 *   toban context knowledge    # Shared team knowledge
 *
 * Uses TOBAN_API_KEY, TOBAN_API_URL from env.
 */

function getEnv(): { apiUrl: string; apiKey: string; agentName: string } {
  const apiUrl = process.env.TOBAN_API_URL;
  const apiKey = process.env.TOBAN_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("Error: TOBAN_API_URL and TOBAN_API_KEY env vars required.");
    process.exit(1);
  }
  return { apiUrl, apiKey, agentName: process.env.TOBAN_AGENT_NAME || "builder" };
}

async function apiFetch(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function handleContext(args: string[]): Promise<void> {
  const sub = args[0] || "all";
  const { apiUrl, apiKey, agentName } = getEnv();

  if (sub === "all" || sub === "spec") {
    const data = (await apiFetch(`${apiUrl}/api/v1/workspace`, apiKey)) as Record<string, unknown> | null;
    if (data) {
      console.log("# Project Spec\n");
      const spec = data.project_spec as Record<string, unknown> | undefined;
      if (spec) {
        if (spec.vision) console.log(`## Vision\n${spec.vision}\n`);
        if (spec.target_users) console.log(`## Target Users\n${spec.target_users}\n`);
        if (spec.tech_stack) console.log(`## Tech Stack\n${spec.tech_stack}\n`);
        if (spec.features) console.log(`## Features\n${spec.features}\n`);
        if (spec.requirements) console.log(`## Requirements\n${spec.requirements}\n`);
      }
    }
  }

  if (sub === "all" || sub === "rules") {
    const agentRole = agentName.replace(/-\d+$/, ""); // builder-1 → builder
    const data = (await apiFetch(`${apiUrl}/api/v1/playbook/prompt?agent=${agentRole}`, apiKey)) as Record<string, unknown> | null;
    if (data && (data as { prompt?: string }).prompt) {
      console.log("# Playbook Rules\n");
      console.log((data as { prompt: string }).prompt);
      console.log("");
    }
  }

  if (sub === "all" || sub === "failures") {
    const data = (await apiFetch(`${apiUrl}/api/v1/failures?limit=10`, apiKey)) as Array<Record<string, unknown>> | null;
    if (data && Array.isArray(data) && data.length > 0) {
      console.log("# Past Failures (avoid repeating)\n");
      for (const f of data) {
        console.log(`- [${f.failure_type}] ${(f.summary as string || "").slice(0, 200)}`);
      }
      console.log("");
    }
  }

  if (sub === "all" || sub === "sprint") {
    const sprints = (await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey)) as Array<Record<string, unknown>> | null;
    const active = sprints?.find((s) => s.status === "active");
    if (active) {
      const sprintNum = active.number as number;
      console.log(`# Current Sprint (#${sprintNum})\n`);
      const tasks = (await apiFetch(`${apiUrl}/api/v1/tasks?sprint=${sprintNum}`, apiKey)) as Array<Record<string, unknown>> | null;
      if (tasks && tasks.length > 0) {
        for (const t of tasks) {
          console.log(`- [${t.status}] ${t.title} (${t.priority}, ${t.owner || "unassigned"})`);
        }
      } else {
        console.log("No tasks in this sprint.");
      }
      console.log("");
    }
  }

  if (sub === "all" || sub === "knowledge") {
    const data = (await apiFetch(`${apiUrl}/api/v1/agents/memories/shared`, apiKey)) as { memories?: Array<{ key: string; content: string }> } | null;
    const memories = data?.memories || [];
    if (memories.length > 0) {
      console.log("# Shared Knowledge\n");
      for (const m of memories.slice(0, 20)) {
        if (m.key.startsWith("agent-change-")) continue; // skip change logs
        console.log(`## ${m.key}`);
        console.log(`${m.content.slice(0, 300)}\n`);
      }
    }
  }
}
