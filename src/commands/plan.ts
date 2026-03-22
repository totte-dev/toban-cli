/**
 * Sprint Plan command — two modes:
 *
 * 1. `toban plan "Build approval flow"` — Goal → decompose into structured tasks → backlog
 * 2. `toban plan` (no goal) — Select from existing backlog for active sprint
 */

import { createApiClient, createAuthHeaders, type Task } from "../api-client.js";
import { resolveModelForRole } from "../agent-engine.js";
import { spawnClaudeOnce } from "../utils/spawn-claude.js";
import * as ui from "../ui.js";

interface DecomposedTask {
  title: string;
  priority: "p1" | "p2" | "p3";
  story_points: number;
  type: "feature" | "bug" | "chore" | "infra";
  description: string; // structured JSON string
}

interface DecomposeResult {
  summary: string;
  tasks: DecomposedTask[];
  total_sp: number;
}

export async function handleSprintPlan(apiUrl: string, apiKey: string, goal?: string): Promise<void> {
  if (goal) {
    await handleGoalDecompose(apiUrl, apiKey, goal);
  } else {
    await handleBacklogSelect(apiUrl, apiKey);
  }
}

/**
 * Mode 1: Decompose a goal into structured tasks
 */
async function handleGoalDecompose(apiUrl: string, apiKey: string, goal: string): Promise<void> {
  const headers = createAuthHeaders(apiKey);

  ui.info(`[plan] Decomposing goal: "${goal}"`);

  // Gather context
  const [backlogRes, knowledgeRes] = await Promise.all([
    fetch(`${apiUrl}/api/v1/tasks?sprint=-1`, { headers }).then((r) => r.json()).catch(() => []) as Promise<Task[]>,
    fetch(`${apiUrl}/api/v1/agents/memories/shared`, { headers }).then((r) => r.json()).catch(() => ({ memories: [] })) as Promise<{ memories: Array<{ key: string; content: string }> }>,
  ]);

  const backlog = (backlogRes || []).filter((t: Task) => t.status !== "done");
  const backlogSummary = backlog.map((t) => `- [${t.priority}] "${t.title}" (${t.id.slice(0, 8)})`).join("\n");

  const knowledgeSummary = (knowledgeRes.memories || [])
    .slice(0, 10)
    .map((m) => `- ${m.key}: ${m.content.slice(0, 150)}`)
    .join("\n");

  const prompt = `You are a sprint planning agent for an AI coding platform called "toban".

Goal from user: "${goal}"

## Existing backlog (check for duplicates)
${backlogSummary || "(empty)"}

## Shared knowledge (design decisions, architecture)
${knowledgeSummary || "(none)"}

## Instructions
1. Decompose the goal into 3-8 concrete tasks
2. Check existing backlog for duplicates — if a task already exists, note it instead of creating a duplicate
3. Each task must have a structured description (JSON string) with these fields:
   - category: "read_only" | "mutating" | "destructive"
   - context: brief background
   - steps: array of concrete implementation steps
   - acceptance_criteria: array of testable conditions
   - files_hint: array of files/directories likely involved (if known)
   - constraints: array of things to avoid

4. Assign priority (p1/p2/p3), story_points (1/2/3/5/8), and type (feature/bug/chore/infra)

Output ONLY valid JSON (no markdown, no explanation):
{
  "summary": "Brief rationale for this decomposition",
  "duplicates": ["existing task ID if found"],
  "tasks": [
    {
      "title": "Short task title",
      "priority": "p1",
      "story_points": 3,
      "type": "feature",
      "description": "{structured JSON as a string}"
    }
  ],
  "total_sp": 0
}`;

  ui.info("[plan] Calling LLM for decomposition...");
  const result = await spawnClaudeOnce(prompt, {
    role: "strategist",
    timeout: 180_000,
  });

  // Parse JSON from result
  const jsonMatch = result.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || result.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    ui.error("[plan] Failed to parse LLM response");
    ui.info(result.slice(0, 500));
    return;
  }

  let plan: DecomposeResult & { duplicates?: string[] };
  try {
    plan = JSON.parse(jsonMatch[1]);
  } catch (err) {
    ui.error(`[plan] JSON parse error: ${err}`);
    ui.info(jsonMatch[1].slice(0, 500));
    return;
  }

  // Display results
  ui.step(`[plan] ${plan.summary}`);
  if (plan.duplicates?.length) {
    ui.warn(`[plan] Possible duplicates in backlog: ${plan.duplicates.join(", ")}`);
  }
  ui.info(`[plan] ${plan.tasks.length} tasks, ${plan.total_sp}SP total\n`);

  for (const t of plan.tasks) {
    ui.info(`  ${t.priority} ${t.story_points}SP [${t.type}] ${t.title}`);
    // Show acceptance criteria from structured description
    try {
      const desc = JSON.parse(t.description);
      if (desc.acceptance_criteria?.length) {
        for (const ac of desc.acceptance_criteria) {
          ui.info(`    ✓ ${ac}`);
        }
      }
    } catch { /* description might not be JSON */ }
  }

  ui.info("");
  ui.info("[plan] Creating tasks in backlog...");

  // Create tasks via API
  let created = 0;
  for (const t of plan.tasks) {
    try {
      const res = await fetch(`${apiUrl}/api/v1/tasks`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t.title,
          description: t.description,
          priority: t.priority,
          story_points: t.story_points,
          type: t.type,
          owner: "user",
          sprint: -1,
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (body.id) {
        ui.info(`  Created: ${body.id.slice(0, 8)} — ${t.title}`);
        created++;
      } else {
        ui.warn(`  Failed: ${t.title} — ${body.error || "unknown error"}`);
      }
    } catch (err) {
      ui.warn(`  Failed: ${t.title} — ${err}`);
    }
  }

  ui.step(`[plan] ${created}/${plan.tasks.length} tasks created in backlog`);
}

/**
 * Mode 2: Select tasks from existing backlog for active sprint (legacy behavior)
 */
async function handleBacklogSelect(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  try { await api.updateAgent({ name: "strategist", status: "working", activity: "Selecting sprint tasks..." }); } catch { /* non-fatal */ }

  try {
    const sprintData = await api.fetchSprintData();
    const sprint = sprintData.sprint;
    if (!sprint) { ui.error("No active sprint found. Use: toban plan \"<goal>\" to decompose a goal."); return; }

    ui.info(`[plan] Selecting tasks for Sprint #${sprint.number}...`);
    const headers = createAuthHeaders(apiKey);

    const [backlogRes, analyticsRes, failuresRes] = await Promise.all([
      fetch(`${apiUrl}/api/v1/tasks?sprint=-1`, { headers }).then((r) => r.json()) as Promise<Task[]>,
      fetch(`${apiUrl}/api/v1/manager/context`, { headers }).then((r) => r.json()).catch(() => ({})) as Promise<Record<string, unknown>>,
      fetch(`${apiUrl}/api/v1/failures/analyze`, { method: "POST", headers }).then((r) => r.json()).catch(() => ({ patterns: [] })) as Promise<{ patterns: Array<{ pattern: string; occurrences: number }> }>,
    ]);

    const backlog = (backlogRes || []).filter((t: Task) => t.status !== "done");
    if (backlog.length === 0) { ui.info("[plan] Backlog is empty. Use: toban plan \"<goal>\" to create tasks."); return; }

    const analytics = (analyticsRes as Record<string, unknown>).analytics as { velocity?: Array<{ sprint: number; points: number }> } | undefined;
    const avgVelocity = analytics?.velocity?.length
      ? Math.round(analytics.velocity.reduce((s, v) => s + v.points, 0) / analytics.velocity.length)
      : 20;
    const failureLines = failuresRes.patterns?.map((p) => `${p.occurrences}x: ${p.pattern}`).join("\n") || "none";

    const backlogLines = backlog.map((t) => {
      const sp = t.story_points ?? "?";
      return `- [${t.priority}] ${sp}SP "${t.title}" (id:${t.id.slice(0, 8)})`;
    }).join("\n");

    const prompt = `You are a sprint planning agent.
Select 5-7 tasks from the backlog for Sprint #${sprint.number}.
Target ${avgVelocity}SP. Keep reasons brief (max 10 words each).
Failure patterns: ${failureLines}
${(sprint as Record<string, unknown>).goal ? `Sprint Goal: ${(sprint as Record<string, unknown>).goal}` : ""}

Backlog (${backlog.length} tasks):
${backlogLines}

Output ONLY valid JSON (no markdown):
{"summary":"brief rationale","tasks":[{"id":"8char","title":"...","reason":"brief"}],"total_sp":N}`;

    const result = await spawnClaudeOnce(prompt, { role: "strategist", timeout: 180_000 });

    const jsonMatch = result.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || result.match(/(\{[\s\S]*\})/);
    const plan = JSON.parse(jsonMatch?.[1] || result) as {
      summary: string;
      tasks: Array<{ id: string; title: string; reason: string }>;
      total_sp: number;
    };

    ui.step(`[plan] ${plan.summary}`);
    ui.info(`[plan] ${plan.tasks.length} tasks, ${plan.total_sp}SP`);
    for (const t of plan.tasks) {
      ui.info(`  - ${t.id}  ${t.title}  (${t.reason})`);
    }

    // Save to API
    const saveRes = await fetch(`${apiUrl}/api/v1/sprints/${sprint.number}/plan`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    });
    const saved = (await saveRes.json()) as { id?: string };
    if (saved.id) {
      ui.info(`[plan] Plan saved: ${saved.id}`);
    }

  } finally {
    try { await api.updateAgent({ name: "strategist", status: "idle", activity: "Planning done" }); } catch { /* non-fatal */ }
  }
}
