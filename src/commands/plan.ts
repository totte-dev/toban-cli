/**
 * Sprint Plan command (Strategist agent)
 */

import { createApiClient, createAuthHeaders, type Task } from "../api-client.js";
import { resolveModelForRole } from "../agent-engine.js";
import * as ui from "../ui.js";

export async function handleSprintPlan(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);

  // Update strategist status
  try { await api.updateAgent({ name: "strategist", status: "working", activity: "Generating sprint plan..." }); } catch { /* non-fatal */ }

  try {
    // Gather context from API
    const sprintData = await api.fetchSprintData();
    const sprint = sprintData.sprint;
    if (!sprint) { ui.error("No active sprint found"); return; }

    ui.info(`[strategist] Planning Sprint #${sprint.number}...`);

    const headers = createAuthHeaders(apiKey);

    // Fetch backlog, analytics, failures, retro
    const [backlogRes, analyticsRes, failuresRes] = await Promise.all([
      fetch(`${apiUrl}/api/v1/tasks?sprint=-1`, { headers }).then((r) => r.json()) as Promise<Task[]>,
      fetch(`${apiUrl}/api/v1/manager/context`, { headers }).then((r) => r.json()).catch(() => ({})) as Promise<Record<string, unknown>>,
      fetch(`${apiUrl}/api/v1/failures/analyze`, { method: "POST", headers }).then((r) => r.json()).catch(() => ({ patterns: [] })) as Promise<{ patterns: Array<{ pattern: string; occurrences: number }> }>,
    ]);

    const backlog = (backlogRes || []).filter((t: Task) => t.status !== "done");
    const analytics = (analyticsRes as Record<string, unknown>).analytics as { velocity?: Array<{ sprint: number; points: number }>; quality?: Array<{ sprint: number; avg_score: number }> } | undefined;

    const velocityLines = analytics?.velocity?.map((v) => `Sprint #${v.sprint}: ${v.points}SP`).join(", ") || "no data";
    const avgVelocity = analytics?.velocity?.length
      ? Math.round(analytics.velocity.reduce((s, v) => s + v.points, 0) / analytics.velocity.length)
      : 20;
    const qualityLines = analytics?.quality?.map((q) => `Sprint #${q.sprint}: ${q.avg_score}/100`).join(", ") || "no data";
    const failureLines = failuresRes.patterns?.map((p) => `${p.occurrences}x: ${p.pattern}`).join("\n") || "none";

    const backlogLines = backlog.map((t) => {
      const sp = t.story_points ?? "?";
      return `- [${t.priority}] ${sp}SP "${t.title}" (id:${t.id.slice(0, 8)})`;
    }).join("\n");

    // Build prompt for Claude CLI
    const systemPrompt = `You are Strategist, a sprint planning agent.
Select 5-7 tasks from the backlog for Sprint #${sprint.number}.
Target ${avgVelocity}SP. Keep reasons brief (max 10 words each).

Velocity: ${velocityLines}
Quality: ${qualityLines}
Failure patterns: ${failureLines}
${(sprint as Record<string, unknown>).goal ? `Sprint Goal: ${(sprint as Record<string, unknown>).goal}` : ""}

Output ONLY valid JSON (no markdown):
{"summary":"brief rationale","tasks":[{"id":"8char","title":"...","reason":"brief"}],"total_sp":N}`;

    const userMessage = `Backlog (${backlog.length} tasks):\n${backlogLines}\n\nSelect tasks. JSON only.`;

    // Call Claude CLI as Strategist
    const { execSync } = await import("node:child_process");
    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;
    const result = execSync(
      `claude --print --model ${resolveModelForRole("strategist")} -p ${JSON.stringify(fullPrompt)}`,
      { stdio: "pipe", timeout: 180_000, maxBuffer: 50 * 1024 * 1024 }
    ).toString().trim();

    // Parse JSON from result
    const jsonMatch = result.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || result.match(/(\{[\s\S]*\})/);
    const plan = JSON.parse(jsonMatch?.[1] || result) as {
      summary: string;
      tasks: Array<{ id: string; title: string; reason: string }>;
      total_sp: number;
    };

    ui.info(`[strategist] Plan: ${plan.summary}`);
    ui.info(`[strategist] ${plan.tasks.length} tasks, ${plan.total_sp}SP`);
    for (const t of plan.tasks) {
      ui.info(`  - ${t.id}  ${t.title}  (${t.reason})`);
    }

    // Save to API
    const saveRes = await fetch(`${apiUrl}/api/v1/sprints/${sprint.number}/plan`, {
      method: "POST", headers,
      body: JSON.stringify(plan),
    });
    const saved = (await saveRes.json()) as { id: string };
    ui.info(`[strategist] Plan saved: ${saved.id}`);
    ui.info(`[strategist] Approve with: curl -X POST ${apiUrl}/api/v1/sprints/${sprint.number}/plan/${saved.id}/approve`);

  } finally {
    try { await api.updateAgent({ name: "strategist", status: "idle", activity: "Sprint plan generated" }); } catch { /* non-fatal */ }
  }
}
