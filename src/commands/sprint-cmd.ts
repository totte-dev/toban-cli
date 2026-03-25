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

  if (sub === "retro") {
    const comment = args.slice(1).join(" ").trim();
    if (!comment) { console.error("Usage: toban sprint retro \"your retro comment\""); return; }

    // Find current sprint (active or retrospective)
    const sprints = (await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey)) as Array<{ number: number; status: string }>;
    const current = sprints.filter((s) => s.status === "active" || s.status === "retrospective" || s.status === "review");
    if (current.length === 0) { console.error("No active sprint."); return; }
    const sprintNumber = current[current.length - 1].number;

    await apiFetch(`${apiUrl}/api/v1/sprints/${sprintNumber}/retro`, apiKey, {
      method: "POST",
      body: JSON.stringify({ agent_name: "user", to_improve: comment }),
    });

    console.log(`Retro comment saved for Sprint #${sprintNumber}`);
    return;
  }

  if (sub === "summary") {
    // Find the most recent completed sprint, or current if specified
    const sprints = (await apiFetch(`${apiUrl}/api/v1/sprints`, apiKey)) as Array<{
      number: number; status: string; goal: string | null;
      completed_at: string | null; retro_summary: string | null;
    }>;

    const targetNum = args[1] ? parseInt(args[1], 10) : undefined;
    const target = targetNum
      ? sprints.find((s) => s.number === targetNum)
      : [...sprints].reverse().find((s) => s.status === "completed") || sprints[sprints.length - 1];

    if (!target) { console.log("No sprints found."); return; }

    console.log(`Sprint #${target.number} [${target.status}]`);
    if (target.goal) console.log(`Goal: ${target.goal}`);
    console.log("");

    // Tasks
    const tasks = (await apiFetch(`${apiUrl}/api/v1/tasks?sprint=${target.number}`, apiKey)) as Array<{
      title: string; status: string; story_points: number | null;
      review_verdict: string | null; type: string | null;
    }>;

    const done = tasks.filter((t) => t.status === "done");
    const totalSP = tasks.reduce((s, t) => s + (t.story_points || 0), 0);
    const doneSP = done.reduce((s, t) => s + (t.story_points || 0), 0);
    const rejected = tasks.filter((t) => t.review_verdict === "NEEDS_CHANGES").length;

    console.log(`Results: ${doneSP}/${totalSP} SP completed (${done.length}/${tasks.length} tasks)`);
    if (rejected > 0) console.log(`Rejected: ${rejected} task(s) received NEEDS_CHANGES`);
    console.log("");

    // Completed tasks
    if (done.length > 0) {
      console.log("Completed:");
      for (const t of done) console.log(`  - ${t.title}`);
      console.log("");
    }

    // Retro comments
    try {
      const retros = (await apiFetch(`${apiUrl}/api/v1/sprints/${target.number}/retro`, apiKey)) as Array<{
        agent_name: string; went_well: string | null; to_improve: string | null;
      }>;
      if (retros.length > 0) {
        console.log("Retro:");
        for (const r of retros) {
          if (r.went_well) console.log(`  [${r.agent_name}] Went well: ${r.went_well}`);
          if (r.to_improve) console.log(`  [${r.agent_name}] To improve: ${r.to_improve}`);
        }
        console.log("");
      }
    } catch { /* retro may not exist */ }

    // Saved summary
    if (target.retro_summary) {
      console.log("Summary:");
      console.log(target.retro_summary);
    }

    return;
  }

  console.error(`Unknown sprint subcommand: ${sub}`);
  console.log(`Usage:
  toban sprint create [--goal "..."]   Create a new sprint
  toban sprint add <task-id>           Add task to current sprint
  toban sprint remove <task-id>        Move task back to backlog
  toban sprint retro "comment"         Submit a retro comment
  toban sprint summary [N]             Show sprint results + learnings
  toban sprint complete [--push]       Complete the current sprint`);
}
