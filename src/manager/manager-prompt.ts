/**
 * Manager prompt building — extracted from manager.ts.
 *
 * Handles system prompt construction and conversation history building.
 */

import { execSync } from "node:child_process";
import { buildConversationHistory } from "./llm-client.js";
import { renderPrompt, loadPromptTemplate, renderTemplate, loadPhaseInstructions } from "./prompt-loader.js";
import { buildSprintStats, formatSprintStats, type TaskInput } from "./sprint-stats.js";
import type { ManagerContext } from "./manager-actions.js";

// ---------------------------------------------------------------------------
// Codebase summary (built once at startup)
// ---------------------------------------------------------------------------

export function buildCodebaseSummary(
  reposDir: string | undefined,
  repositories: Array<{ name: string; path: string; description?: string }>,
): string {
  if (!reposDir || repositories.length === 0) return "";

  const parts: string[] = [];
  for (const repo of repositories) {
    try {
      // Directory tree (top 2 levels)
      const tree = execSync("find . -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -50", {
        cwd: repo.path, stdio: "pipe", timeout: 5000,
      }).toString().trim();

      // CLAUDE.md content (if exists)
      let claudeMd = "";
      try {
        claudeMd = execSync("cat CLAUDE.md 2>/dev/null | head -80", {
          cwd: repo.path, stdio: "pipe", timeout: 3000, shell: "/bin/sh",
        }).toString().trim();
      } catch { /* no CLAUDE.md */ }

      // Recent commits
      let recentCommits = "";
      try {
        recentCommits = execSync("git log --oneline -10 2>/dev/null", {
          cwd: repo.path, stdio: "pipe", timeout: 3000, shell: "/bin/sh",
        }).toString().trim();
      } catch { /* no git history */ }

      parts.push(`### ${repo.name}`);
      if (claudeMd) parts.push(`CLAUDE.md:\n${claudeMd}`);
      parts.push(`Files:\n${tree}`);
      if (recentCommits) parts.push(`Recent commits:\n${recentCommits}`);
    } catch {
      parts.push(`### ${repo.name}\n(failed to read)`);
    }
  }

  return parts.length > 0 ? `\n## Codebase Summary (cached at startup)\n${parts.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  ctx: ManagerContext,
  opts: {
    reposDir?: string;
    repositories: Array<{ name: string; path: string; description?: string }>;
    codebaseSummary: string;
  },
): string {
  const lang = ctx.workspace.language === "ja" ? "Japanese" : "English";

  // Parse project spec if available
  let specBlock = "";
  if (ctx.workspace.spec) {
    try {
      const spec = JSON.parse(ctx.workspace.spec) as Record<string, string>;
      const labels: Record<string, string> = { vision: "Vision", target_users: "Target Users", tech_stack: "Tech Stack", mvp_requirements: "MVP Requirements", roadmap: "Roadmap", business_model: "Business Model", constraints: "Constraints" };
      const sections = Object.entries(spec)
        .filter(([, v]) => v?.trim())
        .map(([k, v]) => `**${labels[k] ?? k}:** ${v.trim()}`)
        .join("\n");
      if (sections) specBlock = `\n## Project Spec\n${sections}\n`;
    } catch { /* invalid JSON */ }
  }

  const sprintGoal = ctx.sprint?.goal;
  const sprintDeadline = ctx.sprint?.deadline;
  const sprintInfo = ctx.sprint
    ? `Sprint #${ctx.sprint.number} (${ctx.sprint.status})${sprintGoal ? `\nGoal: ${sprintGoal}` : ""}${sprintDeadline ? `\nDeadline: ${sprintDeadline}` : ""}`
    : "No active sprint";

  const taskLines = ctx.tasks.length > 0
    ? ctx.tasks.map((t) => {
        const owner = t.owner ? ` @${t.owner}` : "";
        return `  - [${t.status}] ${t.priority} ${t.title}${owner} (id: ${t.id.slice(0, 8)})`;
      }).join("\n")
    : "  (no tasks)";

  const agentLines = ctx.agents.length > 0
    ? ctx.agents.map((a) => {
        const act = a.activity ? ` — ${a.activity}` : "";
        let health = "";
        if (a.last_seen) {
          const seenAgo = Date.now() - new Date(a.last_seen).getTime();
          if (a.status === "running" && seenAgo > 5 * 60 * 1000) {
            health = " [UNRESPONSIVE — no heartbeat for " + Math.round(seenAgo / 60000) + "min]";
          }
        } else if (a.status === "running" || a.status === "starting") {
          health = " [UNRESPONSIVE — never seen]";
        }
        return `  - ${a.name}: ${a.status}${act}${health}`;
      }).join("\n")
    : "  (no agents)";

  const backlogLines = ctx.backlog_tasks?.length
    ? ctx.backlog_tasks.map((t) => {
        const owner = t.owner ? ` @${t.owner}` : "";
        return `  - ${t.priority} ${t.title}${owner} (id: ${t.id.slice(0, 8)})`;
      }).join("\n")
    : "";

  const recentlyDoneLines = ctx.recently_done?.length
    ? ctx.recently_done.map((t) => `  - ${t.title} (Sprint #${t.sprint})`).join("\n")
    : "";

  const retroLines = ctx.retro_comments?.length
    ? ctx.retro_comments.map((c) => `  - ${c}`).join("\n")
    : "";

  const rawPhaseInstructions = loadPhaseInstructions(ctx.sprint?.status ?? "unknown");
  // Inject sprint stats into retrospective/completed phase instructions
  const sprintStatsText = (ctx.sprint?.status === "retrospective" || ctx.sprint?.status === "completed")
    ? formatSprintStats(buildSprintStats(ctx.tasks as TaskInput[]))
    : "";
  const phaseInstructions = renderTemplate(rawPhaseInstructions, { sprintStats: sprintStatsText });

  // Build repo access section (only if repos are configured)
  let repoAccess = "";
  if (opts.reposDir) {
    const repoLines = opts.repositories.length > 0
      ? opts.repositories.map((r) => {
          const desc = r.description ? ` — ${r.description}` : "";
          return `  - ${r.name}: ${r.path}${desc}`;
        }).join("\n")
      : "  (no repositories configured)";
    repoAccess = renderPrompt("manager-repo-access", {
      reposDir: opts.reposDir,
      repoLines,
    });
  }

  // Assemble from templates
  const system = renderPrompt("manager-system", {
    projectName: ctx.workspace.name,
    language: lang,
    spec: specBlock,
    sprintInfo,
    repoAccess,
    tasks: taskLines,
    backlog: backlogLines ? `\n### Backlog (not in sprint)\n${backlogLines}` : "",
    recentlyDone: recentlyDoneLines ? `\n### Recently Completed (do NOT re-propose these)\n${recentlyDoneLines}` : "",
    retro: retroLines ? `\n### Previous Sprint Retro\n${retroLines}` : "",
    agents: agentLines,
    phaseInstructions,
  });

  const actions = loadPromptTemplate("manager-actions");
  const rules = loadPromptTemplate("manager-rules");
  const adr = ctx.adr_summary ? `\n## Architecture Decision Records\n${ctx.adr_summary}\nYou MUST follow all ACCEPTED ADRs when making decisions.` : "";

  let analyticsBlock = "";
  if (ctx.analytics) {
    const velLines = ctx.analytics.velocity.map((v) => `  Sprint #${v.sprint}: ${v.points}SP`).join("\n");
    const qualLines = ctx.analytics.quality.map((q) => `  Sprint #${q.sprint}: ${q.avg_score}/100`).join("\n");
    analyticsBlock = `\n## Sprint Analytics (recent trends)
### Velocity (completed SP per sprint)
${velLines || "  (no data)"}
### Quality Score (avg review score)
${qualLines || "  (no data)"}
Use these trends to inform sprint planning — if velocity is declining, reduce scope. If quality is dropping, prioritize test/review improvements.\n`;
  }

  return `${system}\n${opts.codebaseSummary}\n${actions}\n${rules}${adr}${analyticsBlock}`;
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

export function buildManagerConversationHistory(
  ctx: ManagerContext,
): Array<{ role: "user" | "assistant"; content: string }> {
  return buildConversationHistory(ctx.recent_messages, { maxTurns: 10 });
}
