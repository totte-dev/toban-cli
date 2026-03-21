/**
 * Manager action execution — extracted from manager.ts.
 *
 * Handles parsing LLM responses into actions and executing them
 * (update_task, create_task, spawn_agent, transition_sprint, etc.)
 */

import { createAuthHeaders, type ApiClient, type Task } from "./api-client.js";
import * as ui from "./ui.js";
import type { PendingApproval } from "./manager.js";

// ---------------------------------------------------------------------------
// Types (shared with manager.ts)
// ---------------------------------------------------------------------------

export interface ManagerContext {
  workspace: {
    name: string;
    language: string;
    description: string | null;
    spec: string | null;
  };
  sprint: {
    number: number;
    status: string;
    goal?: string | null;
    deadline?: string | null;
  } | null;
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    owner: string | null;
    type: string | null;
    target_repo: string | null;
  }>;
  backlog_tasks?: Array<{
    id: string;
    title: string;
    description: string | null;
    priority: string;
    owner: string | null;
    type: string | null;
  }>;
  recently_done?: Array<{ title: string; sprint: number }>;
  retro_comments?: string[];
  adr_summary?: string;
  agents: Array<{
    name: string;
    status: string;
    activity: string | null;
    engine: string | null;
    last_seen: string | null;
  }>;
  recent_messages: Array<{
    id: string;
    from: string;
    to: string;
    content: string;
    created_at: string;
  }>;
  playbook_rules: string;
  analytics?: {
    velocity: Array<{ sprint: number; points: number }>;
    quality: Array<{ sprint: number; avg_score: number }>;
  };
}

/** Parsed action from LLM response */
export interface ManagerAction {
  type: "spawn_agent" | "update_task" | "create_task" | "transition_sprint" | "send_message" | "propose_tasks" | "plan_sprint";
  params: Record<string, unknown>;
}

// Validation constants
const VALID_OWNERS = ["builder", "cloud-engineer", "strategist", "marketer", "operator", "user"];
const VALID_STATUS = ["todo", "in_progress", "review", "done"];
const VALID_PRIORITY = ["p0", "p1", "p2", "p3"];
const VALID_TYPE = ["feature", "bug", "chore", "research", "docs", "infra", "content", "strategy", "task"];
const VALID_SP = [1, 2, 3, 5, 8];
const ALLOWED_TASK_FIELDS = ["title", "description", "owner", "priority", "status", "type", "sprint", "branch", "labels", "blocks", "blocked_by", "context_notes", "target_repo", "parent_task", "review_comment", "commits", "story_points"];

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseResponse(response: string): { reply: string; actions: ManagerAction[]; proposals?: Array<Record<string, string>> } {
  const actions: ManagerAction[] = [];
  const replyLines: string[] = [];
  let proposals: Array<Record<string, string>> | undefined;

  // Extract ACTION blocks — handles both single-line and multi-line JSON
  // Strategy: find "ACTION: type" markers, then bracket-match the JSON that follows
  const remaining = response;
  const actionPattern = /ACTION:\s*(\w+)\s*/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = actionPattern.exec(remaining)) !== null) {
    // Add text before this ACTION to reply
    const before = remaining.slice(lastEnd, match.index);
    if (before.trim()) replyLines.push(before.trim());

    const type = match[1] as ManagerAction["type"];
    const jsonStart = match.index + match[0].length;

    // Find the JSON by bracket matching from jsonStart
    const rest = remaining.slice(jsonStart);
    const firstChar = rest.trimStart()[0];
    const trimOffset = rest.length - rest.trimStart().length;

    if (firstChar === "[" || firstChar === "{") {
      const endChar = firstChar === "[" ? "]" : "}";
      let depth = 0;
      let end = -1;
      const searchFrom = jsonStart + trimOffset;
      for (let i = searchFrom; i < remaining.length; i++) {
        if (remaining[i] === firstChar) depth++;
        if (remaining[i] === endChar) depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      if (end > 0) {
        const jsonStr = remaining.slice(searchFrom, end);
        try {
          const raw = JSON.parse(jsonStr);
          if (type === "propose_tasks" && Array.isArray(raw)) {
            proposals = raw as Array<Record<string, string>>;
            actions.push({ type, params: { tasks: raw } });
          } else {
            actions.push({ type, params: raw as Record<string, unknown> });
          }
          lastEnd = end;
          actionPattern.lastIndex = end;
          continue;
        } catch { /* fall through to line-based */ }
      }
    }

    // Fallback: try single-line JSON on the same line
    const lineEnd = remaining.indexOf("\n", jsonStart);
    const lineJson = remaining.slice(jsonStart, lineEnd === -1 ? undefined : lineEnd).trim();
    try {
      const raw = JSON.parse(lineJson);
      if (type === "propose_tasks" && Array.isArray(raw)) {
        proposals = raw as Array<Record<string, string>>;
        actions.push({ type, params: { tasks: raw } });
      } else {
        actions.push({ type, params: raw as Record<string, unknown> });
      }
      lastEnd = lineEnd === -1 ? remaining.length : lineEnd;
      actionPattern.lastIndex = lastEnd;
    } catch {
      // Could not parse — keep as reply text
      lastEnd = match.index + match[0].length;
    }
  }

  // Add any remaining text after the last ACTION
  const tail = remaining.slice(lastEnd).trim();
  if (tail) replyLines.push(tail);

  // Sanitize owner fields in proposals — ensure every proposal has a valid owner
  if (proposals) {
    for (const p of proposals) {
      if (!p.owner) {
        // Default to "builder" so CLI auto-starts the task
        p.owner = "builder";
      } else if (!VALID_OWNERS.includes(p.owner)) {
        const base = p.owner.split("-")[0];
        p.owner = VALID_OWNERS.includes(base) ? base : "builder";
      }
    }
  }

  let reply = replyLines.join("\n").trim();
  if (!reply && actions.length > 0) {
    // LLM returned only ACTION lines — summarize what was done
    const summaries = actions.map((a) => `${a.type}`);
    reply = `(${summaries.join(", ")})`;
  } else if (!reply) {
    reply = "(no response)";
  }
  return { reply, actions, proposals };
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

export interface ActionExecutionDeps {
  apiUrl: string;
  apiKey: string;
  api: ApiClient | null;
  lastUserMessage: string | undefined;
  pendingApprovals: Map<string, PendingApproval>;
  onSpawnAgent?: (role: string, taskIds: string[]) => Promise<void>;
  onDataUpdate?: (entity: string, id: string, changes: Record<string, unknown>) => void;
  onApprovalRequest?: (approval: PendingApproval) => void;
}

/** Resolve a short 8-char task ID prefix to full ID */
function resolveTaskId(shortId: string, ctx: ManagerContext): string {
  const match = ctx.tasks.find((t) => t.id.startsWith(shortId));
  return match?.id ?? shortId;
}

export async function executeActions(
  actions: ManagerAction[],
  context: ManagerContext,
  deps: ActionExecutionDeps,
): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "update_task": {
          const { id, ...rawUpdates } = action.params as { id: string; [k: string]: unknown };
          if (id && deps.api) {
            const updates: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(rawUpdates)) {
              if (!ALLOWED_TASK_FIELDS.includes(k)) continue;
              if (k === "status" && !VALID_STATUS.includes(v as string)) { ui.warn(`[manager] update_task: invalid status "${v}"`); continue; }
              if (k === "priority" && !VALID_PRIORITY.includes(v as string)) { ui.warn(`[manager] update_task: invalid priority "${v}"`); continue; }
              if (k === "type" && v != null && !VALID_TYPE.includes(v as string)) { ui.warn(`[manager] update_task: invalid type "${v}"`); continue; }
              if (k === "story_points" && v != null && !VALID_SP.includes(v as number)) { ui.warn(`[manager] update_task: invalid story_points "${v}"`); continue; }
              updates[k] = v;
            }
            if (Object.keys(updates).length === 0) {
              ui.warn(`[manager] update_task ${id}: no valid fields`);
              break;
            }
            const fullId = resolveTaskId(id, context);
            await deps.api.updateTask(fullId, updates as Partial<Task>);
            deps.onDataUpdate?.("task", fullId, updates);
            ui.info(`[manager] Updated task ${id}`);
          }
          break;
        }
        case "create_task": {
          const { title, description, priority, owner, story_points } = action.params as {
            title: string; description?: string; priority?: string; owner?: string; story_points?: number;
          };
          const safeOwner = owner && VALID_OWNERS.includes(owner) ? owner : (owner?.split("-")[0] && VALID_OWNERS.includes(owner?.split("-")[0]) ? owner.split("-")[0] : "builder");
          const safePriority = priority && VALID_PRIORITY.includes(priority) ? priority : "p1";
          if (safePriority !== priority) ui.warn(`[manager] create_task: invalid priority "${priority}" → defaulted to "${safePriority}"`);
          const safeSp = story_points && VALID_SP.includes(story_points) ? story_points : undefined;
          if (story_points && !safeSp) ui.warn(`[manager] create_task: invalid story_points "${story_points}"`);
          if (title) {
            await createTask(deps.apiUrl, deps.apiKey, title, description, safePriority, safeOwner, context, deps.lastUserMessage);
            ui.info(`[manager] Created task: ${title}`);
          }
          break;
        }
        case "transition_sprint": {
          const { status } = action.params as { status: string };
          if (status && context.sprint && deps.api) {
            // Validate transition: planning->active->review->retrospective->completed
            const validTransitions: Record<string, string[]> = {
              planning: ["active"],
              active: ["review"],
              review: ["retrospective", "active"],
              retrospective: ["completed"],
            };
            const current = context.sprint.status;
            const allowed = validTransitions[current] ?? [];
            if (!allowed.includes(status)) {
              ui.warn(`[manager] transition_sprint blocked: ${current} → ${status} is not allowed`);
              break;
            }
            if (status === "completed") {
              await deps.api.completeSprint(context.sprint.number);
            } else {
              await fetch(`${deps.apiUrl}/api/v1/sprints/${context.sprint.number}`, {
                method: "PATCH",
                headers: createAuthHeaders(deps.apiKey),
                body: JSON.stringify({ status }),
              });
            }
            deps.onDataUpdate?.("sprint", String(context.sprint.number), { status });
            ui.info(`[manager] Sprint transitioned to ${status}`);
          }
          break;
        }
        case "send_message": {
          const { to, content } = action.params as { to: string; content: string };
          if (to && content && deps.api) {
            await deps.api.sendMessage("manager", to, content);
            ui.info(`[manager] Sent message to ${to}`);
          }
          break;
        }
        case "spawn_agent": {
          const { role, task_ids } = action.params as { role: string; task_ids: string[] };
          if (role) {
            const fullIds = (task_ids ?? []).map((id) => resolveTaskId(id, context));
            const approval: PendingApproval = {
              id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role,
              taskIds: fullIds,
              createdAt: Date.now(),
            };
            deps.pendingApprovals.set(approval.id, approval);
            ui.info(`[manager] spawn_agent awaiting approval: ${role} (${approval.id})`);
            deps.onApprovalRequest?.(approval);
          }
          break;
        }
        case "propose_tasks": {
          // Already handled via proposals return from parseResponse
          break;
        }
        case "plan_sprint": {
          // Move backlog tasks to current sprint
          const taskIds = (action.params as Record<string, unknown>).task_ids as string[] | undefined;
          if (!taskIds?.length || !context?.sprint) {
            ui.warn("[manager] plan_sprint: missing task_ids or no active sprint");
            break;
          }
          let moved = 0;
          for (const shortId of taskIds) {
            const fullId = resolveTaskId(shortId, context);
            try {
              await deps.api?.updateTask(fullId, { sprint: context.sprint.number } as Partial<Task>);
              moved++;
              deps.onDataUpdate?.("task", fullId, { sprint: context.sprint.number });
            } catch (err) {
              ui.warn(`[manager] plan_sprint: failed to move ${shortId}: ${err}`);
            }
          }
          if (moved > 0) ui.info(`[manager] Moved ${moved} tasks from backlog to Sprint #${context.sprint.number}`);
          break;
        }
        default:
          ui.warn(`[manager] Unknown action type: ${action.type}`);
      }
    } catch (err) {
      ui.error(`[manager] Failed to execute action ${action.type}: ${err}`);
    }
  }
}

async function createTask(
  apiUrl: string,
  apiKey: string,
  title: string,
  description?: string,
  priority?: string,
  owner?: string,
  ctx?: ManagerContext,
  userMessage?: string
): Promise<void> {
  const body: Record<string, unknown> = { title };
  if (description) body.description = description;
  if (priority) body.priority = priority;
  if (owner) body.owner = owner;
  if (ctx?.sprint) body.sprint = ctx.sprint.number;
  body.labels = ["ai-generated"];
  if (userMessage) body.context_notes = `User request: ${userMessage}`;

  await fetch(`${apiUrl}/api/v1/tasks`, {
    method: "POST",
    headers: createAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });
}
