/**
 * Sprint Plan command — two modes:
 *
 * 1. `toban plan "Build approval flow"` — Goal → decompose into structured tasks → backlog
 * 2. `toban plan` (no goal) — Select from existing backlog for active sprint
 */

import { createApiClient, createAuthHeaders, type Task } from "../services/api-client.js";
import * as ui from "../ui.js";
import { spawn } from "node:child_process";

interface StructuredDesc {
  category: string;
  context: string;
  steps: string[];
  acceptance_criteria: string[];
  files_hint?: string[];
  constraints?: string[];
}

interface DecomposedTask {
  title: string;
  priority: "p1" | "p2" | "p3";
  story_points: number;
  type: "feature" | "bug" | "chore" | "infra";
  desc: StructuredDesc;
}

interface DecomposeResult {
  summary: string;
  duplicates: string[];
  tasks: DecomposedTask[];
  total_sp: number;
}

const MAX_RETRIES = 1;

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

  // Gather context — backlog with descriptions + shared knowledge
  const [backlogRes, knowledgeRes] = await Promise.all([
    fetch(`${apiUrl}/api/v1/tasks?sprint=-1`, { headers }).then((r) => r.json()).catch(() => []) as Promise<Task[]>,
    fetch(`${apiUrl}/api/v1/agents/memories/shared`, { headers }).then((r) => r.json()).catch(() => ({ memories: [] })) as Promise<{ memories: Array<{ key: string; content: string }> }>,
  ]);

  const backlog = (backlogRes || []).filter((t: Task) => t.status !== "done");

  // Include description snippet for better duplicate detection
  const backlogSummary = backlog.map((t) => {
    const desc = typeof t.description === "string" ? t.description.slice(0, 100) : "";
    const descSnippet = desc ? ` — ${desc}` : "";
    return `- [${t.priority}] ${t.story_points ?? "?"}SP "${t.title}" (${t.id.slice(0, 8)})${descSnippet}`;
  }).join("\n");

  // Relevant knowledge only (design decisions, architecture)
  const knowledgeSummary = (knowledgeRes.memories || [])
    .filter((m) => m.key.startsWith("design-") || m.key.startsWith("arch-") || m.key.startsWith("policy-"))
    .slice(0, 8)
    .map((m) => `### ${m.key}\n${m.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = buildDecomposePrompt(goal, backlogSummary, knowledgeSummary, backlog.length);

  // Call LLM with retry
  let plan: DecomposeResult | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) ui.info(`[plan] Retrying (attempt ${attempt + 1})...`);

    ui.info("[plan] Calling LLM (opus)...");
    const result = await callClaudeForPlan(prompt);

    plan = parseDecomposeResult(result);
    if (plan) break;

    if (attempt === MAX_RETRIES) {
      ui.error("[plan] Failed to parse LLM response after retries");
      return;
    }
  }

  if (!plan) return;

  // Display results
  ui.step(`[plan] ${plan.summary}`);
  if (plan.duplicates?.length) {
    ui.warn(`[plan] Duplicates found in backlog: ${plan.duplicates.join(", ")}`);
  }
  ui.info(`[plan] ${plan.tasks.length} tasks, ${plan.total_sp}SP total\n`);

  for (const t of plan.tasks) {
    ui.info(`  ${t.priority} ${t.story_points}SP [${t.type}] ${t.title}`);
    if (t.desc.steps?.length) {
      for (const s of t.desc.steps) {
        ui.info(`    → ${s}`);
      }
    }
    if (t.desc.acceptance_criteria?.length) {
      for (const ac of t.desc.acceptance_criteria) {
        ui.info(`    ✓ ${ac}`);
      }
    }
    if (t.desc.files_hint?.length) {
      ui.info(`    files: ${t.desc.files_hint.join(", ")}`);
    }
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
          description: t.desc.context || "",
          category: t.desc.category || "mutating",
          steps: t.desc.steps || null,
          acceptance_criteria: t.desc.acceptance_criteria || null,
          files_hint: t.desc.files_hint || null,
          constraints_list: t.desc.constraints || null,
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

function buildDecomposePrompt(goal: string, backlogSummary: string, knowledgeSummary: string, backlogCount: number): string {
  return `You are a senior engineering lead decomposing a goal into implementable tasks for an AI coding platform "toban".

## Goal
${goal}

## Existing backlog (${backlogCount} tasks — check for duplicates!)
${backlogSummary || "(empty)"}

## Shared knowledge
${knowledgeSummary || "(none)"}

## Output requirements

Decompose the goal into 3-8 tasks. For each task:

- title: concise, starts with verb (Add, Fix, Refactor, etc.)
- priority: p1 (must-have), p2 (should-have), p3 (nice-to-have)
- story_points: 1 (trivial), 2 (small), 3 (medium), 5 (large), 8 (very large)
- type: feature | bug | chore | infra
- desc: structured object (NOT a string) with:
  - category: "read_only" | "mutating" | "destructive"
  - context: 1-2 sentences of background
  - steps: concrete implementation steps (what files to edit, what to add/change)
  - acceptance_criteria: testable conditions (specific, not vague)
  - files_hint: files/directories likely involved (optional, include if you can infer)
  - constraints: things to avoid (optional)

## Duplicate handling
If a backlog task already covers part of the goal, list its ID in "duplicates" and do NOT create a duplicate. Only create tasks for genuinely new work.

## Quality rules
- steps must reference actual code changes, not abstract descriptions
- acceptance_criteria must be verifiable (build passes, test exists, behavior changes)
- Each task should be completable independently by one agent
- Order tasks by dependency (foundational first)

Output ONLY valid JSON:
{
  "summary": "1-2 sentence rationale",
  "duplicates": ["8char-id"],
  "tasks": [
    {
      "title": "...",
      "priority": "p1",
      "story_points": 3,
      "type": "feature",
      "desc": {
        "category": "mutating",
        "context": "...",
        "steps": ["..."],
        "acceptance_criteria": ["..."],
        "files_hint": ["..."],
        "constraints": ["..."]
      }
    }
  ],
  "total_sp": 0
}`;
}

/**
 * Spawn claude --print with -p flag (stdin prompt) to avoid tool usage.
 * This is much faster than letting Claude Code try to use tools.
 */
function callClaudeForPlan(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  return new Promise<string>((resolve) => {
    const child = spawn("claude", [
      "--print", "--model", "claude-opus-4-6", "-p", "-",
    ], {
      env, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000,
    });

    let out = "";
    let resolved = false;

    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", () => {});

    child.on("close", () => {
      if (!resolved) { resolved = true; resolve(out); }
    });
    child.on("error", () => {
      if (!resolved) { resolved = true; resolve(out || ""); }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch {}
        resolve(out || "");
      }
    }, 300_000);
  });
}

function parseDecomposeResult(result: string): DecomposeResult | null {
  // Try to extract JSON from response
  const jsonMatch = result.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || result.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    ui.warn("[plan] No JSON found in LLM response");
    ui.info(result.slice(0, 300));
    return null;
  }

  try {
    const raw = JSON.parse(jsonMatch[1]);

    // Validate structure
    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
      ui.warn("[plan] No tasks in response");
      return null;
    }

    // Normalize tasks — desc might be string (from weaker models) or object
    const tasks: DecomposedTask[] = raw.tasks.map((t: Record<string, unknown>) => {
      let desc: StructuredDesc;
      if (typeof t.desc === "string") {
        try { desc = JSON.parse(t.desc); } catch { desc = { category: "mutating", context: String(t.desc), steps: [], acceptance_criteria: [] }; }
      } else if (t.desc && typeof t.desc === "object") {
        desc = t.desc as StructuredDesc;
      } else if (typeof t.description === "string") {
        // Fallback: legacy format where description is a JSON string
        try { desc = JSON.parse(t.description); } catch { desc = { category: "mutating", context: String(t.description), steps: [], acceptance_criteria: [] }; }
      } else {
        desc = { category: "mutating", context: "", steps: [], acceptance_criteria: [] };
      }

      return {
        title: String(t.title || "Untitled"),
        priority: (["p1", "p2", "p3"].includes(String(t.priority)) ? t.priority : "p2") as "p1" | "p2" | "p3",
        story_points: typeof t.story_points === "number" ? t.story_points : 3,
        type: (["feature", "bug", "chore", "infra"].includes(String(t.type)) ? t.type : "feature") as DecomposedTask["type"],
        desc,
      };
    });

    return {
      summary: String(raw.summary || ""),
      duplicates: Array.isArray(raw.duplicates) ? raw.duplicates.map(String) : [],
      tasks,
      total_sp: typeof raw.total_sp === "number" ? raw.total_sp : tasks.reduce((s, t) => s + t.story_points, 0),
    };
  } catch (err) {
    ui.warn(`[plan] JSON parse error: ${err}`);
    ui.info(jsonMatch[1].slice(0, 300));
    return null;
  }
}

/**
 * Mode 2: Select tasks from existing backlog for active sprint (legacy behavior)
 */
async function handleBacklogSelect(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  try { await api.updateAgent({ name: "manager", status: "working", activity: "Selecting sprint tasks..." }); } catch { /* non-fatal */ }

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

    const result = await callClaudeForPlan(prompt);

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
    try { await api.updateAgent({ name: "manager", status: "idle", activity: "Planning done" }); } catch { /* non-fatal */ }
  }
}
