/**
 * Handlers for fetch_recent_changes and record_changes template actions.
 *
 * Enables inter-agent context sharing:
 * - record_changes: After a builder completes a task, writes a change summary
 *   to shared memory so other agents can see what was modified.
 * - fetch_recent_changes: Before a builder starts a task, fetches recent change
 *   summaries from other agents and injects them into the prompt via CLAUDE.md.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { TemplateAction, ActionContext } from "../agent-templates.js";
import { createAuthHeaders, type AgentMemory } from "../api-client.js";
import * as ui from "../ui.js";

/**
 * Pre-action: Fetch recent change summaries from other agents
 * and append them to CLAUDE.md so the current agent has context.
 */
export async function handleFetchRecentChanges(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  try {
    const res = await fetch(
      `${ctx.config.apiUrl}/api/v1/agents/memories/shared?tags=agent-change&limit=10`,
      { headers: createAuthHeaders(ctx.config.apiKey) }
    );
    if (!res.ok) return;

    const data = (await res.json()) as { memories: AgentMemory[] };
    const changes = data.memories ?? [];
    if (changes.length === 0) return;

    // Build a context block for CLAUDE.md
    const lines = changes.map((m) => {
      const from = m.agent_name ?? "unknown";
      return `- [${from}] ${m.key}: ${m.content.slice(0, 300)}`;
    });

    const block = [
      "<!-- TOBAN_RECENT_CHANGES_START -->",
      "# Recent Changes by Other Agents",
      "",
      "The following changes were made recently by other agents. Be aware of potential conflicts.",
      "",
      ...lines,
      "<!-- TOBAN_RECENT_CHANGES_END -->",
    ].join("\n");

    const claudeMdPath = path.join(ctx.config.workingDir, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      let existing = fs.readFileSync(claudeMdPath, "utf-8");
      // Remove previous block to avoid duplicates
      existing = existing.replace(/<!-- TOBAN_RECENT_CHANGES_START -->[\s\S]*?<!-- TOBAN_RECENT_CHANGES_END -->\n?/g, "").trimEnd();
      fs.writeFileSync(claudeMdPath, existing + "\n\n" + block + "\n");
    }

    ui.info(`[${phase}] Injected ${changes.length} recent agent changes into context`);
  } catch (err) {
    // Non-fatal: agent can work without this context
    ui.warn(`[${phase}] fetch_recent_changes failed: ${err}`);
  }
}

/**
 * Post-action: Record a summary of changes made by this agent
 * so other agents can pick it up via fetch_recent_changes.
 */
export async function handleRecordChanges(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  try {
    // Get the list of changed files and commit message
    let changedFiles = "";
    let commitMsg = "";
    try {
      changedFiles = execSync("git diff --name-only HEAD~1..HEAD 2>/dev/null || echo '(no changes)'", {
        cwd: ctx.config.workingDir,
        stdio: "pipe",
        timeout: 5_000,
      }).toString().trim();
    } catch {
      changedFiles = "(unable to determine)";
    }
    try {
      commitMsg = execSync("git log -1 --format=%s 2>/dev/null || echo '(no commit)'", {
        cwd: ctx.config.workingDir,
        stdio: "pipe",
        timeout: 5_000,
      }).toString().trim();
    } catch {
      commitMsg = "(unable to determine)";
    }

    // Build a concise summary
    const fileList = changedFiles.split("\n").slice(0, 10).join(", ");
    const content = `${commitMsg}\nFiles: ${fileList}`.slice(0, 2000);

    // Use short task ID as key suffix
    const shortId = ctx.task.id.slice(0, 8);
    const key = `agent-change-${shortId}`;

    await ctx.api.putAgentMemory(ctx.agentName, key, {
      type: "project",
      content,
      shared: true,
      tags: "agent-change",
    });

    ui.info(`[${phase}] Recorded change summary: ${key}`);
  } catch (err) {
    // Non-fatal: other agents just won't see this change
    ui.warn(`[${phase}] record_changes failed: ${err}`);
  }
}
