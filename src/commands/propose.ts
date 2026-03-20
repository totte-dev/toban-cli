/**
 * Propose command (Strategist agent — analyze data sources and suggest improvement tasks)
 */

import { createApiClient, type Task } from "../api-client.js";
import { resolveModelForRole } from "../agent-engine.js";
import * as ui from "../ui.js";

export async function handlePropose(apiUrl: string, apiKey: string): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  try { await api.updateAgent({ name: "strategist", status: "working", activity: "Analyzing data for improvement proposals..." }); } catch { /* non-fatal */ }

  try {
    ui.info("[strategist] Analyzing data sources for improvement proposals...");
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

    // Gather data sources
    const [failuresRes, backlogRes, analyticsRes] = await Promise.all([
      fetch(`${apiUrl}/api/v1/failures/analyze`, { method: "POST", headers }).then((r) => r.json()).catch(() => ({ patterns: [] })) as Promise<{ patterns: Array<{ pattern: string; occurrences: number; suggested_rule: { title: string; content: string } }> }>,
      fetch(`${apiUrl}/api/v1/tasks?sprint=-1`, { headers }).then((r) => r.json()).catch(() => []) as Promise<Task[]>,
      fetch(`${apiUrl}/api/v1/manager/context`, { headers }).then((r) => r.json()).catch(() => ({})) as Promise<Record<string, unknown>>,
    ]);

    const failureLines = failuresRes.patterns?.map((p) => `${p.occurrences}x: ${p.pattern}`).join("\n") || "none";
    const backlogTitles = (backlogRes || []).filter((t: Task) => t.status !== "done").map((t) => `- ${t.title}`).join("\n");
    const analytics = (analyticsRes as Record<string, unknown>).analytics as { quality?: Array<{ sprint: number; avg_score: number }> } | undefined;
    const qualityLines = analytics?.quality?.map((q) => `Sprint #${q.sprint}: ${q.avg_score}/100`).join(", ") || "no data";

    const prompt = `You are Strategist. Analyze the data below and propose 3-5 improvement tasks.
Each proposal should fix a recurring problem or improve quality/efficiency.
Do NOT propose tasks that already exist in the backlog.

Failure patterns:
${failureLines}

Quality trend: ${qualityLines}

Existing backlog (do NOT duplicate):
${backlogTitles}

Output ONLY valid JSON (no markdown):
[{"title":"...","description":"brief","priority":"p1/p2/p3","type":"bug/chore/feature","story_points":N,"source":"failure_db/review/analytics","reasoning":"why this matters"}]`;

    const { execSync } = await import("node:child_process");
    const result = execSync(
      `claude --print --model ${resolveModelForRole("strategist")} -p ${JSON.stringify(prompt)}`,
      { stdio: "pipe", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
    ).toString().trim();

    // Parse JSON
    const jsonMatch = result.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || result.match(/(\[[\s\S]*\])/);
    const proposalList = JSON.parse(jsonMatch?.[1] || result) as Array<Record<string, string>>;

    ui.info(`[strategist] Generated ${proposalList.length} proposals:`);
    for (const p of proposalList) {
      ui.info(`  - [${p.priority}] ${p.title} (${p.source})`);
      ui.info(`    ${p.reasoning}`);
    }

    // Save to API
    try {
      const saveRes = await fetch(`${apiUrl}/api/v1/proposals/batch`, {
        method: "POST", headers,
        body: JSON.stringify(proposalList),
      });
      if (saveRes.ok) {
        const saved = (await saveRes.json()) as { created: number };
        ui.info(`[strategist] ${saved.created} proposals saved. Approve in dashboard > Backlog > Proposals.`);
      } else {
        ui.warn(`[strategist] Failed to save proposals: ${saveRes.status} ${saveRes.statusText}`);
      }
    } catch (saveErr) {
      ui.warn(`[strategist] Failed to save proposals: ${saveErr}`);
    }

  } finally {
    try { await api.updateAgent({ name: "strategist", status: "idle", activity: `Proposals generated` }); } catch { /* non-fatal */ }
  }
}
