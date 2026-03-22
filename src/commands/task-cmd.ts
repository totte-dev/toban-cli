/**
 * `toban task` — Task management commands for agents.
 *
 * Usage:
 *   toban task info                    # Get current task details
 *   toban task list                    # List all sprint tasks
 *   toban task complete "summary"      # Report task completion
 *   toban task blocker "reason"        # Report blocker
 *
 * Uses TOBAN_API_KEY, TOBAN_API_URL, TOBAN_TASK_ID from env.
 */

function getEnv(): { apiUrl: string; apiKey: string; taskId: string | null } {
  const apiUrl = process.env.TOBAN_API_URL;
  const apiKey = process.env.TOBAN_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("Error: TOBAN_API_URL and TOBAN_API_KEY env vars required.");
    process.exit(1);
  }
  return { apiUrl, apiKey, taskId: process.env.TOBAN_TASK_ID || null };
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

export async function handleTaskCmd(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "help") {
    console.log(`Usage:
  toban task info              Get current task details
  toban task list              List all sprint tasks
  toban task create "title"    Create a new task (--desc, --priority, --type, --sprint)
  toban task done <id>         Mark a task as done
  toban task complete "msg"    Report task completion (agent use)
  toban task blocker "reason"  Report blocker (agent use)`);
    return;
  }

  const { apiUrl, apiKey, taskId } = getEnv();

  switch (sub) {
    case "info": {
      if (!taskId) { console.error("Error: TOBAN_TASK_ID not set."); return; }
      const tasks = (await apiFetch(`${apiUrl}/api/v1/tasks`, apiKey)) as Array<Record<string, unknown>>;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) { console.error(`Task ${taskId} not found.`); return; }
      console.log(`# Task: ${task.title}`);
      console.log(`ID: ${(task.id as string).slice(0, 8)}`);
      console.log(`Status: ${task.status}`);
      console.log(`Priority: ${task.priority}`);
      console.log(`Type: ${task.type || "feature"}`);
      console.log(`Owner: ${task.owner || "builder"}`);
      if (task.description) console.log(`\n## Description\n${task.description}`);
      if (task.review_comment) console.log(`\n## Review Comment\n${task.review_comment}`);
      break;
    }

    case "list": {
      const tasks = (await apiFetch(`${apiUrl}/api/v1/tasks`, apiKey)) as Array<Record<string, unknown>>;
      console.log("# Sprint Tasks\n");
      for (const t of tasks) {
        const marker = t.id === taskId ? " ← (you)" : "";
        console.log(`[${(t.status as string).padEnd(12)}] ${t.priority} | ${t.title}${marker}`);
      }
      console.log(`\nTotal: ${tasks.length} tasks`);
      break;
    }

    case "complete": {
      if (!taskId) { console.error("Error: TOBAN_TASK_ID not set."); return; }
      const summary = args.slice(1).join(" ").trim();
      if (!summary) { console.error("Usage: toban task complete \"summary of what was done\""); return; }
      await apiFetch(`${apiUrl}/api/v1/tasks/${taskId}`, apiKey, {
        method: "PATCH",
        body: JSON.stringify({ status: "review", review_comment: JSON.stringify({ summary }) }),
      });
      console.log(`Task ${taskId.slice(0, 8)} marked as review with summary.`);
      break;
    }

    case "blocker": {
      if (!taskId) { console.error("Error: TOBAN_TASK_ID not set."); return; }
      const reason = args.slice(1).join(" ").trim();
      if (!reason) { console.error("Usage: toban task blocker \"reason for being blocked\""); return; }
      await apiFetch(`${apiUrl}/api/v1/tasks/${taskId}`, apiKey, {
        method: "PATCH",
        body: JSON.stringify({ status: "blocked", context_notes: `Blocked: ${reason}` }),
      });
      console.log(`Task ${taskId.slice(0, 8)} marked as blocked: ${reason}`);
      break;
    }

    case "create": {
      const title = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!title) { console.error("Usage: toban task create \"title\" [--desc \"...\"] [--priority p1] [--type feature] [--sprint N]"); return; }
      const desc = getArg(args, "--desc");
      const priority = getArg(args, "--priority") || "p2";
      const type = getArg(args, "--type") || "feature";
      const sprint = getArg(args, "--sprint") ? parseInt(getArg(args, "--sprint")!, 10) : -1;
      const sp = getArg(args, "--sp") ? parseInt(getArg(args, "--sp")!, 10) : undefined;
      const result = (await apiFetch(`${apiUrl}/api/v1/tasks`, apiKey, {
        method: "POST",
        body: JSON.stringify({ title, description: desc, priority, type, sprint, owner: "user", story_points: sp }),
      })) as { id: string };
      console.log(`Created: ${result.id?.slice(0, 8)} | ${title}`);
      break;
    }

    case "done": {
      const id = args[1];
      if (!id) { console.error("Usage: toban task done <task-id>"); return; }
      await apiFetch(`${apiUrl}/api/v1/tasks/${id}`, apiKey, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      });
      console.log(`Task ${id.slice(0, 8)} marked as done.`);
      break;
    }

    default:
      console.error(`Unknown subcommand: ${sub}. Run 'toban task help' for usage.`);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
