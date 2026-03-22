/**
 * `toban memory` — Search and save shared knowledge.
 *
 * Usage:
 *   toban memory search "query"           # Search shared memories
 *   toban memory set key "value"          # Save a memory
 *   toban memory list                     # List own memories
 *
 * Uses TOBAN_API_KEY, TOBAN_API_URL, TOBAN_AGENT_NAME from env.
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

async function apiFetch(url: string, apiKey: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function handleMemory(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "help") {
    console.log(`Usage:
  toban memory search "query"     Search shared knowledge
  toban memory set key "value"    Save a memory (shared with team)
  toban memory list               List your memories`);
    return;
  }

  const { apiUrl, apiKey, agentName } = getEnv();

  switch (sub) {
    case "search": {
      const query = args.slice(1).join(" ").trim();
      if (!query) { console.error("Usage: toban memory search \"query\""); return; }
      const data = (await apiFetch(
        `${apiUrl}/api/v1/agents/memories/search?q=${encodeURIComponent(query)}`,
        apiKey
      )) as { memories: Array<Record<string, unknown>> };
      const memories = data.memories || [];
      if (memories.length === 0) {
        console.log(`No memories found for: "${query}"`);
        return;
      }
      console.log(`# Search Results for "${query}"\n`);
      for (const m of memories) {
        console.log(`## [${m.type}] ${m.key} (by @${m.agent_name})`);
        console.log(m.content);
        console.log("");
      }
      break;
    }

    case "set": {
      const key = args[1];
      const value = args.slice(2).join(" ").trim();
      if (!key || !value) { console.error("Usage: toban memory set key \"value\""); return; }
      await apiFetch(`${apiUrl}/api/v1/agents/${encodeURIComponent(agentName)}/memories/${encodeURIComponent(key)}`, apiKey, {
        method: "PUT",
        body: JSON.stringify({ type: "project", content: value, shared: true }),
      });
      console.log(`Memory saved: ${key} (shared with team)`);
      break;
    }

    case "list": {
      const data = (await apiFetch(
        `${apiUrl}/api/v1/agents/${encodeURIComponent(agentName)}/memories`,
        apiKey
      )) as { memories: Array<Record<string, unknown>> };
      const memories = data.memories || [];
      if (memories.length === 0) {
        console.log("No memories stored.");
        return;
      }
      console.log(`# Memories for ${agentName}\n`);
      for (const m of memories) {
        console.log(`- [${m.type}] ${m.key}: ${(m.content as string || "").slice(0, 100)}`);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${sub}. Run 'toban memory help' for usage.`);
  }
}
