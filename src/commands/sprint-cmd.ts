/**
 * `toban sprint create/add/remove` — Sprint management commands.
 */

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
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function handleSprintCmd(apiUrl: string, apiKey: string, args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "create") {
    const goalIdx = args.indexOf("--goal");
    const goal = goalIdx !== -1 && args[goalIdx + 1] ? args[goalIdx + 1] : undefined;

    // Find the next sprint number
    const sprints = (await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey)) as Array<{ number: number; status: string }>;
    const maxNumber = sprints.reduce((max, s) => Math.max(max, s.number), 0);
    const nextNumber = maxNumber + 1;

    // Check if there's already an active sprint
    const active = sprints.filter((s) => s.status === "active");
    if (active.length > 0) {
      console.log(`Warning: Sprint #${active[0].number} is still active.`);
    }

    await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey, {
      method: "POST",
      body: JSON.stringify({ number: nextNumber, status: "active", goal }),
    });

    console.log(`Sprint #${nextNumber} created${goal ? ` — Goal: ${goal}` : ""}`);
    return;
  }

  if (sub === "add") {
    const taskId = args[1];
    if (!taskId) { console.error("Usage: toban sprint add <task-id>"); return; }

    // Find current active sprint
    const sprints = (await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey)) as Array<{ number: number; status: string }>;
    const active = sprints.filter((s) => s.status === "active");
    if (active.length === 0) { console.error("No active sprint. Run `toban sprint create` first."); return; }
    const sprintNumber = active[active.length - 1].number;

    await apiFetch(`${apiUrl}/api/v1/tasks/${taskId}`, apiKey, {
      method: "PATCH",
      body: JSON.stringify({ sprint: sprintNumber }),
    });

    console.log(`Task ${taskId.slice(0, 8)} added to Sprint #${sprintNumber}`);
    return;
  }

  if (sub === "remove") {
    const taskId = args[1];
    if (!taskId) { console.error("Usage: toban sprint remove <task-id>"); return; }

    await apiFetch(`${apiUrl}/api/v1/tasks/${taskId}`, apiKey, {
      method: "PATCH",
      body: JSON.stringify({ sprint: -1 }),
    });

    console.log(`Task ${taskId.slice(0, 8)} moved to backlog`);
    return;
  }

  console.error(`Unknown sprint subcommand: ${sub}`);
  console.log(`Usage:
  toban sprint create [--goal "..."]   Create a new sprint
  toban sprint add <task-id>           Add task to current sprint
  toban sprint remove <task-id>        Move task back to backlog
  toban sprint complete [--push]       Complete the current sprint`);
}
