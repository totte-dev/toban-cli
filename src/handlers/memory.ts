/**
 * Handlers for inject_memory and collect_memory template actions.
 * Manages agent memory injection into CLAUDE.md and collection from .claude/ directory.
 */

import fs from "node:fs";
import path from "node:path";
import type { TemplateAction, ActionContext } from "../agent-templates.js";
import type { AgentMemory } from "../api-client.js";
import * as ui from "../ui.js";
import { parseTaskLabels } from "../utils/parse-labels.js";

export async function handleInjectMemory(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "inject_memory";
  // Claude-specific: write agent memories + directory hints into CLAUDE.md
  if (ctx.config.engine !== "claude") {
    ui.debug("template", `inject_memory skipped (engine: ${ctx.config.engine})`);
    return;
  }

  const claudeMdPath = path.join(ctx.config.workingDir, "CLAUDE.md");
  const hasClaudeMd = fs.existsSync(claudeMdPath);
  let injected = 0;

  // If no CLAUDE.md exists, generate directory structure hint
  if (!hasClaudeMd) {
    try {
      const { execSync: lsExec } = await import("node:child_process");
      const tree = lsExec("find . -maxdepth 2 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.wrangler/*' | head -40", {
        cwd: ctx.config.workingDir, stdio: "pipe", timeout: 5000,
      }).toString().trim();
      const hint = `# Repository Structure (auto-generated)\n\n\`\`\`\n${tree}\n\`\`\`\n\nNote: This file was auto-generated because no CLAUDE.md was found.\n`;
      fs.writeFileSync(claudeMdPath, hint);
      ui.info(`[${phase}] Generated CLAUDE.md with directory structure`);
    } catch { /* non-fatal */ }
  }

  // Inject agent memories + shared memories
  const memories = await ctx.api.fetchAgentMemories(ctx.agentName);
  // Fetch shared memories matching task labels
  const taskLabels = parseTaskLabels(ctx.task);
  let sharedMemories: AgentMemory[] = [];
  try {
    const res = await fetch(`${ctx.config.apiUrl}/api/v1/agents/memories/shared${taskLabels.length ? `?tags=${taskLabels.join(",")}` : ""}`, {
      headers: { Authorization: `Bearer ${ctx.config.apiKey}`, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as { memories: AgentMemory[] };
      // Exclude own memories (already in `memories`)
      const ownKeys = new Set(memories.map((m) => m.key));
      sharedMemories = data.memories.filter((m) => !ownKeys.has(m.key));
    }
  } catch { /* non-fatal */ }

  const allMemories = [...memories, ...sharedMemories];
  if (allMemories.length > 0) {
    const ownBlock = memories.length > 0
      ? memories.map((m) => `## ${m.type}: ${m.key}\n${m.content}`).join("\n\n")
      : "";
    const sharedBlock = sharedMemories.length > 0
      ? `\n# Shared Team Knowledge\n\n${sharedMemories.map((m) => `## ${m.type}: ${m.key} (from @${m.agent_name})\n${m.content}`).join("\n\n")}`
      : "";
    const memoryBlock = [
      "<!-- TOBAN_MEMORY_START -->",
      "# Agent Memory (auto-injected by Toban)",
      "",
      ownBlock,
      sharedBlock,
      "<!-- TOBAN_MEMORY_END -->",
    ].filter(Boolean).join("\n");

    let existing = fs.existsSync(claudeMdPath)
      ? fs.readFileSync(claudeMdPath, "utf-8")
      : "";
    // Remove existing memory block to prevent duplicates
    existing = existing.replace(/<!-- TOBAN_MEMORY_START -->[\s\S]*?<!-- TOBAN_MEMORY_END -->\n?/g, "").trimEnd();
    fs.writeFileSync(claudeMdPath, existing + "\n\n" + memoryBlock + "\n");
    injected = allMemories.length;
  }

  // Mark CLAUDE.md as assume-unchanged so inject_memory additions don't get committed
  // Agent can still read the file, but git won't track the memory block changes
  if (injected > 0 && hasClaudeMd) {
    try {
      const { execSync: gitExec2 } = await import("node:child_process");
      gitExec2("git update-index --assume-unchanged CLAUDE.md", { cwd: ctx.config.workingDir, stdio: "pipe" });
    } catch { /* non-fatal — worktree may not support this */ }
  }

  if (injected > 0 || !hasClaudeMd) {
    ui.info(`[${phase}] ${label}: ${injected} memories${!hasClaudeMd ? " + dir structure" : ""}`);
  }
}

export async function handleCollectMemory(
  action: TemplateAction,
  ctx: ActionContext,
  phase: "pre" | "post"
): Promise<void> {
  const label = action.label ?? "collect_memory";
  // Claude-specific: read .claude/projects/*/memory/*.md and save to API
  if (ctx.config.engine !== "claude") {
    ui.debug("template", `collect_memory skipped (engine: ${ctx.config.engine})`);
    return;
  }
  const claudeDir = path.join(ctx.config.workingDir, ".claude");
  if (!fs.existsSync(claudeDir)) return;

  // Find memory files under .claude/projects/*/memory/
  const memFiles: string[] = [];
  const projectsDir = path.join(claudeDir, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const proj of fs.readdirSync(projectsDir)) {
      const memDir = path.join(projectsDir, proj, "memory");
      if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
        for (const f of fs.readdirSync(memDir)) {
          if (f.endsWith(".md") && f !== "MEMORY.md") {
            memFiles.push(path.join("projects", proj, "memory", f));
          }
        }
      }
    }
  }
  if (memFiles.length === 0) return;

  let saved = 0;
  for (const relFile of memFiles) {
    try {
      const content = fs.readFileSync(path.join(claudeDir, relFile), "utf-8");
      // Parse frontmatter: ---\nname: ...\ntype: ...\n---\nbody
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) continue;

      const frontmatter = fmMatch[1];
      const body = fmMatch[2].trim();
      const getName = frontmatter.match(/^name:\s*(.+)$/m);
      const getType = frontmatter.match(/^type:\s*(.+)$/m);
      if (!getName || !getType || !body) continue;

      const key = getName[1].trim();
      const memType = getType[1].trim();
      if (!["identity", "feedback", "project", "reference"].includes(memType)) continue;

      // Parse optional shared and tags from frontmatter
      const getShared = frontmatter.match(/^shared:\s*(true|false)$/m);
      const getTags = frontmatter.match(/^tags:\s*(.+)$/m);
      const shared = getShared?.[1] === "true";
      const tags = getTags?.[1]?.trim() || undefined;

      await ctx.api.putAgentMemory(ctx.agentName, key, { type: memType, content: body, shared, tags });
      saved++;
    } catch {
      // Skip unparseable files
    }
  }
  if (saved > 0) ui.info(`[${phase}] ${label}: ${saved} memory entries saved`);
}
