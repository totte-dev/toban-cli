/**
 * `toban context` — Get project context on demand.
 *
 * Usage:
 *   toban context              # Full project context (spec + rules + failures)
 *   toban context spec         # Project spec only
 *   toban context rules        # Playbook rules only
 *   toban context failures     # Past failures only
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
}
