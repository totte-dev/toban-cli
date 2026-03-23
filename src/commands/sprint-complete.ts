/**
 * Sprint complete command
 */

import { createApiClient, createAuthHeaders } from "../services/api-client.js";
import { logError, CLI_ERR } from "../services/error-logger.js";
import * as ui from "../ui.js";
import { execSync } from "node:child_process";
import { spawnClaudeOnce } from "../utils/spawn-claude.js";

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

export async function handleSprintComplete(apiUrl: string, apiKey: string, push: boolean): Promise<void> {
  const api = createApiClient(apiUrl, apiKey);
  ui.intro();
  const s = ui.createSpinner();

  s.start("Fetching current sprint...");
  const sprint = await api.fetchCurrentSprint();
  if (!sprint) { s.stop("No active sprint found"); ui.error("No active sprint."); process.exit(1); }
  s.stop(`Sprint #${sprint.number} (${sprint.status})`);

  if (sprint.status !== "completed") {
    s.start(`Completing sprint #${sprint.number}...`);
    try { await api.completeSprint(sprint.number); s.stop(`Sprint #${sprint.number} completed`); }
    catch (err) {
      s.stop("Failed");
      logError(CLI_ERR.ACTION_FAILED, `Sprint completion failed`, { sprintNumber: sprint.number }, err);
      ui.error(`Sprint completion failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else { ui.info(`Sprint #${sprint.number} already completed`); }

  // Generate Sprint Report via LLM
  s.start("Generating Sprint Report...");
  try {
    const reviewData = await fetch(`${apiUrl}/api/v1/sprints/${sprint.number}/review`, {
      headers: createAuthHeaders(apiKey),
    }).then((r) => r.json()) as {
      sprint: { goal?: string; number: number };
      summary: { total: number; done: number; completion_rate: number };
      retro_comments: Array<{ agent_name: string; went_well?: string; to_improve?: string }>;
      tasks: Array<{ title: string; status: string; owner?: string; type?: string; story_points?: number }>;
    };

    const retros = reviewData.retro_comments
      .map((r) => [r.went_well ? `[${r.agent_name}] Went well: ${r.went_well}` : "", r.to_improve ? `[${r.agent_name}] To improve: ${r.to_improve}` : ""].filter(Boolean).join("\n"))
      .filter(Boolean).join("\n");

    const taskList = reviewData.tasks
      .map((t) => `- [${t.status}] ${t.title} (${t.type || "task"}, ${t.story_points || "?"}SP, @${t.owner || "unassigned"})`)
      .join("\n");

    const prompt = `You are a Sprint Retrospective analyst. Generate a concise Sprint Report for Sprint #${sprint.number}.

Goal: ${reviewData.sprint.goal || "(no goal)"}
Completion: ${reviewData.summary.done}/${reviewData.summary.total} tasks (${reviewData.summary.completion_rate}%)

Tasks:
${taskList}

Retro Comments:
${retros || "(none)"}

Generate a report with these 4 sections (keep each section 2-4 bullet points, plain text, no markdown headers):

1. SUMMARY: What was accomplished, key outcomes, any notable issues
2. NEXT SPRINT RECOMMENDATIONS: What should be prioritized next based on results
3. BACKLOG HEALTH: Any concerns about task quality, stale items, or prioritization
4. PROJECT HEALTH: Quality trends, velocity, areas of improvement or concern

Output the report as plain text, concise and actionable. No JSON wrapping.`;

    const report = await spawnClaudeOnce(prompt, { role: "strategist", maxTurns: 1, timeout: 120_000 });
    if (report.trim()) {
      await fetch(`${apiUrl}/api/v1/sprints/${sprint.number}`, {
        method: "PATCH",
        headers: createAuthHeaders(apiKey),
        body: JSON.stringify({ retro_summary: report.trim() }),
      });
      s.stop("Sprint Report generated and saved");
    } else {
      s.stop("Sprint Report: empty response from LLM");
    }
  } catch (err) {
    s.stop(`Sprint Report generation failed: ${err instanceof Error ? err.message : err}`);
    // Non-fatal — continue with tag + cleanup
  }

  const tagName = `sprint-${sprint.number}`;
  try {
    const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
    if (existing) { ui.warn(`Tag ${tagName} already exists`); }
    else {
      execSync(`git tag "${tagName}"`, { stdio: "pipe" });
      const hash = execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
      ui.step(`Tagged ${tagName} at ${hash}`);
    }
  } catch (err) { ui.warn(`Failed to create tag: ${err}`); }

  if (push) {
    try { execSync(`git push origin "${tagName}"`, { stdio: "inherit" }); ui.step(`Pushed ${tagName}`); }
    catch (err) {
      logError(CLI_ERR.ACTION_FAILED, `Failed to push tag ${tagName}`, { tagName }, err);
      ui.error(`Failed to push tag: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  // Clean up orphaned worktrees
  try {
    const worktreeOutput = execSync("git worktree list --porcelain", { stdio: "pipe" }).toString();
    const worktrees = parseWorktreeList(worktreeOutput);
    let cleaned = 0;
    for (const wt of worktrees) {
      if (wt.branch?.startsWith("refs/heads/agent/")) {
        try {
          execSync(`git worktree remove "${wt.path}" --force`, { stdio: "pipe" });
          cleaned++;
        } catch { /* non-fatal — worktree may be in use */ }
        try {
          const branchName = wt.branch.replace("refs/heads/", "");
          execSync(`git branch -D "${branchName}"`, { stdio: "pipe" });
        } catch { /* non-fatal */ }
      }
    }
    execSync("git worktree prune", { stdio: "pipe" });
    if (cleaned > 0) ui.step(`Cleaned up ${cleaned} orphaned worktree(s)`);
  } catch (err) {
    ui.warn(`Failed to clean up worktrees: ${err instanceof Error ? err.message : err}`);
  }

  // Rule scoring: apply decay and report stale/remove rules
  try {
    const decayRes = await fetch(`${apiUrl}/api/v1/rule-evaluations/decay`, {
      method: "POST",
      headers: createAuthHeaders(apiKey),
      body: JSON.stringify({ sprint_number: sprint.number }),
    });
    if (decayRes.ok) {
      const decay = await decayRes.json() as { rules_decayed: number; decayed: Array<{ rule_id: string; score: number; status: string }> };
      if (decay.rules_decayed > 0) {
        ui.info(`[rule-eval] Decayed ${decay.rules_decayed} rule(s)`);
        const stale = decay.decayed.filter((r) => r.status === "stale");
        const remove = decay.decayed.filter((r) => r.status === "remove");
        if (stale.length > 0) ui.warn(`[rule-eval] ${stale.length} rule(s) stale — consider reviewing`);
        if (remove.length > 0) ui.warn(`[rule-eval] ${remove.length} rule(s) below threshold — candidates for removal`);
      }
    }
  } catch { /* non-fatal */ }

  ui.outro(`Sprint #${sprint.number} complete`);
}
