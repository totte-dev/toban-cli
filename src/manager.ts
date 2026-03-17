/**
 * Manager — Event-driven sprint manager powered by LLM.
 *
 * Replaces ChatPoller with an action-capable manager that can:
 * - Respond to user messages via WS or API polling
 * - Spawn agents for tasks
 * - Update task status/priority/owner
 * - Create new tasks
 * - Transition sprint phases
 *
 * The Manager is idle until an event arrives (WS message, poll tick).
 * On event: fetch enriched context → build prompt → call LLM → parse actions → execute.
 */

import { execSync } from "node:child_process";
import type { ApiClient, Task } from "./api-client.js";
import type { AgentRunner } from "./runner.js";
import { createAuthHeaders, buildConversationHistory } from "./llm-client.js";
import { createLlmProvider, type LlmProvider } from "./llm-provider.js";
import { renderPrompt, loadPromptTemplate, renderTemplate, loadPhaseInstructions } from "./prompt-loader.js";
import { PollLoop } from "./poll-loop.js";
import * as ui from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManagerContext {
  workspace: {
    name: string;
    language: string;
    description: string | null;
  };
  sprint: {
    number: number;
    status: string;
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
}

/** Parsed action from LLM response */
interface ManagerAction {
  type: "spawn_agent" | "update_task" | "create_task" | "transition_sprint" | "send_message" | "propose_tasks";
  params: Record<string, unknown>;
}

/** Pending spawn_agent approval */
export interface PendingApproval {
  id: string;
  role: string;
  taskIds: string[];
  createdAt: number;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ManagerOptions {
  apiUrl: string;
  apiKey: string;
  /** OpenAI-compatible base URL */
  llmBaseUrl?: string;
  /** API key for the LLM provider */
  llmApiKey?: string;
  model?: string;
  /** Polling interval for API messages (ms) */
  pollIntervalMs?: number;
  /** Reference to the agent runner for spawning */
  runner?: AgentRunner;
  /** Reference to the API client */
  api?: ApiClient;
  /** Working directory containing all cloned repos for read access */
  reposDir?: string;
  /** Repository info for system prompt injection */
  repositories?: Array<{ name: string; path: string; description?: string }>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class Manager {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private pollIntervalMs: number;
  private runner: AgentRunner | null;
  private api: ApiClient | null;
  private lastSeenId: string | null = null;
  private lastUserMessage: string | undefined;
  private poller: PollLoop;
  private llmProvider: LlmProvider;
  private reposDir?: string;
  private repositories: Array<{ name: string; path: string; description?: string }>;

  /** Pending spawn_agent approvals waiting for user confirmation */
  private pendingApprovals = new Map<string, PendingApproval>();

  /** Callbacks for actions the Manager can't execute directly */
  onSpawnAgent?: (role: string, taskIds: string[]) => Promise<void>;
  /** Callback to broadcast reply via WebSocket (for poll-path messages) */
  onReply?: (reply: string) => void;
  /** Callback to broadcast proposals via WebSocket */
  onProposals?: (proposals: Array<Record<string, string>>) => void;
  /** Callback to stream text chunks via WebSocket */
  onStreamChunk?: (chunk: string) => void;
  /** Callback when a spawn_agent needs user approval */
  onApprovalRequest?: (approval: PendingApproval) => void;

  constructor(options: ManagerOptions) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.runner = options.runner ?? null;
    this.api = options.api ?? null;
    this.llmProvider = createLlmProvider({
      llmBaseUrl: options.llmBaseUrl,
      llmApiKey: options.llmApiKey,
    });
    this.reposDir = options.reposDir;
    this.repositories = options.repositories ?? [];
    ui.debug("manager", `LLM provider: ${this.llmProvider.id}`);
    this.poller = new PollLoop({
      name: "manager",
      intervalMs: this.pollIntervalMs,
      onTick: () => this.poll(),
    });
  }

  // ── Lifecycle ────────────────────────────────────────────

  start(): void {
    ui.info(`[manager] Started (poll every ${this.pollIntervalMs / 1000}s, model: ${this.model})`);
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
    ui.debug("manager", "Manager stopped");
  }

  /** Resolve a pending approval (approve or reject) */
  async resolveApproval(approvalId: string, approved: boolean): Promise<void> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      ui.warn(`[manager] Approval ${approvalId} not found (expired or already resolved)`);
      return;
    }
    this.pendingApprovals.delete(approvalId);

    if (approved && this.onSpawnAgent) {
      ui.info(`[manager] Approval granted — spawning ${approval.role} agent`);
      await this.onSpawnAgent(approval.role, approval.taskIds);
    } else {
      ui.info(`[manager] Approval rejected — ${approval.role} agent not spawned`);
    }
  }

  /** Get all pending approvals (for re-sending on WS reconnect) */
  getPendingApprovals(): PendingApproval[] {
    this.cleanExpiredApprovals();
    return Array.from(this.pendingApprovals.values());
  }

  /** Remove approvals older than 5 minutes */
  private cleanExpiredApprovals(): void {
    const now = Date.now();
    for (const [id, approval] of this.pendingApprovals) {
      if (now - approval.createdAt > APPROVAL_TIMEOUT_MS) {
        this.pendingApprovals.delete(id);
        ui.info(`[manager] Approval ${id} expired (${approval.role})`);
      }
    }
  }

  /** Pull latest changes in Manager's repo clones (runs on poll tick) */
  private pullRepos(): void {
    for (const repo of this.repositories) {
      try {
        execSync("git pull --ff-only 2>/dev/null", {
          cwd: repo.path,
          stdio: "pipe",
          timeout: 10_000,
          shell: "/bin/sh",
        });
      } catch {
        // Non-fatal — repo may not have a remote or network may be down
      }
    }
  }

  /** Pause polling when WS clients are connected (messages come via WS) */
  pausePolling(): void {
    ui.info("[manager] Polling paused (WS connected)");
    this.poller.pause();
  }

  /** Resume polling when all WS clients disconnected */
  resumePolling(): void {
    ui.info("[manager] Polling resumed (no WS clients)");
    this.poller.resume();
  }

  // ── WebSocket entry point ────────────────────────────────

  /**
   * Handle a message received via WebSocket.
   * Streams response chunks via onStreamChunk, then executes actions.
   */
  async handleWsMessage(content: string): Promise<{ reply: string; proposals?: Array<Record<string, string>> }> {
    this.lastUserMessage = content;
    ui.chatMessage("user", "manager", content, "ws");
    // Update activity immediately so UI shows "thinking"
    await this.updateActivity("thinking...");
    try {
      const context = await this.fetchContext();
      const { reply, actions, proposals } = await this.think(content, context);
      await this.executeActions(actions, context);
      ui.chatMessage("manager", "user", reply, "ws");
      await this.advanceLastSeen();
      return { reply, proposals };
    } finally {
      await this.updateActivity("listening");
    }
  }

  private async updateActivity(activity: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify({ name: "manager", status: "active", activity }),
      });
    } catch { /* non-fatal */ }
  }

  /** Sync lastSeenId with API to skip messages already handled via WS */
  private async advanceLastSeen(): Promise<void> {
    try {
      const messages = await this.fetchMessages();
      if (messages.length > 0) {
        const sorted = [...messages].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        this.lastSeenId = sorted[sorted.length - 1].id;
      }
    } catch {
      // Non-fatal
    }
  }

  // ── Polling ──────────────────────────────────────────────

  private async poll(): Promise<void> {
    this.cleanExpiredApprovals();
    this.pullRepos();
    await this.heartbeat();

    const messages = await this.fetchMessages();
    if (!messages || messages.length === 0) return;

    const newMessages = this.findNewInboundMessages(messages);
    if (newMessages.length > 0) {
      ui.debug("manager", `${newMessages.length} new message(s) to process`);
    }

    for (const msg of newMessages) {
      const isFromUser = msg.from === "user" || msg.from.startsWith("user:");

      // Show inbound message immediately before processing
      ui.chatMessage(msg.from, "manager", msg.content, "api");

      try {
        const senderContext = isFromUser
          ? `[Message from user: ${msg.from}]`
          : `[Message from agent: ${msg.from}]`;
        const enrichedContent = `${senderContext}\n${msg.content}`;

        const context = await this.fetchContext();
        const { reply, actions, proposals } = await this.think(enrichedContent, context);
        await this.executeActions(actions, context);
        await this.postReplyTo(msg.from, reply);
        if (isFromUser) {
          this.onReply?.(reply);
          if (proposals && proposals.length > 0) {
            this.onProposals?.(proposals);
          }
        }
        ui.chatMessage("manager", msg.from, reply, "api");
      } catch (err) {
        ui.chatMessage("manager", msg.from, `Error: ${err}`, "api");
        await this.postReplyTo(msg.from, "Sorry, an error occurred while processing your message. Please try again.").catch(() => {});
      }

      this.lastSeenId = msg.id;
    }
  }

  // ── Core: Think ──────────────────────────────────────────

  /**
   * Given user input and enriched context, call LLM and parse response
   * into a reply + list of actions.
   */
  private async think(
    userMessage: string,
    context: ManagerContext
  ): Promise<{ reply: string; actions: ManagerAction[]; proposals?: Array<Record<string, string>> }> {
    const systemPrompt = this.buildSystemPrompt(context);
    const conversationHistory = this.buildManagerConversationHistory(context);

    const llmResponse = await this.llmProvider.call({
      systemPrompt,
      history: conversationHistory,
      userMessage,
      model: this.model,
      onChunk: this.onStreamChunk,
      cwd: this.reposDir,
      enableTools: !!this.reposDir,
      allowedTools: this.reposDir ? ["Read", "Grep", "Glob", "Bash", "Agent"] : undefined,
    });

    const { reply, actions, proposals } = this.parseResponse(llmResponse);
    return { reply, actions, proposals };
  }

  // ── Context fetching ─────────────────────────────────────

  private async fetchContext(): Promise<ManagerContext> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v1/manager/context`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as ManagerContext;
    } catch (err) {
      ui.debug("manager", `Failed to fetch context: ${err}`);
      // Return minimal context
      return {
        workspace: { name: "Unknown", language: "ja", description: null },
        sprint: null,
        tasks: [],
        agents: [],
        recent_messages: [],
        playbook_rules: "",
      };
    }
  }

  // ── System prompt ────────────────────────────────────────

  private buildSystemPrompt(ctx: ManagerContext): string {
    const lang = ctx.workspace.language === "ja" ? "Japanese" : "English";

    const sprintInfo = ctx.sprint
      ? `Sprint #${ctx.sprint.number} (${ctx.sprint.status})`
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

    const phaseInstructions = loadPhaseInstructions(ctx.sprint?.status ?? "unknown");

    // Build repo access section (only if repos are configured)
    let repoAccess = "";
    if (this.reposDir) {
      const repoLines = this.repositories.length > 0
        ? this.repositories.map((r) => {
            const desc = r.description ? ` — ${r.description}` : "";
            return `  - ${r.name}: ${r.path}${desc}`;
          }).join("\n")
        : "  (no repositories configured)";
      repoAccess = renderPrompt("manager-repo-access", {
        reposDir: this.reposDir,
        repoLines,
      });
    }

    // Assemble from templates
    const system = renderPrompt("manager-system", {
      projectName: ctx.workspace.name,
      language: lang,
      sprintInfo,
      repoAccess,
      tasks: taskLines,
      agents: agentLines,
      phaseInstructions,
    });

    const actions = loadPromptTemplate("manager-actions");
    const rules = loadPromptTemplate("manager-rules");
    const playbook = ctx.playbook_rules ? `\n## Playbook Rules\n${ctx.playbook_rules}` : "";

    return `${system}\n${actions}\n${rules}${playbook}`;
  }

  // ── Conversation history ─────────────────────────────────

  private buildManagerConversationHistory(
    ctx: ManagerContext
  ): Array<{ role: "user" | "assistant"; content: string }> {
    return buildConversationHistory(ctx.recent_messages, { maxTurns: 10 });
  }

  // ── Response parsing ─────────────────────────────────────

  private parseResponse(response: string): { reply: string; actions: ManagerAction[]; proposals?: Array<Record<string, string>> } {
    const actions: ManagerAction[] = [];
    const replyLines: string[] = [];
    let proposals: Array<Record<string, string>> | undefined;

    for (const line of response.split("\n")) {
      const actionMatch = line.match(/^ACTION:\s*(\w+)\s+(.+)$/);
      if (actionMatch) {
        try {
          const type = actionMatch[1] as ManagerAction["type"];
          const raw = JSON.parse(actionMatch[2]);
          if (type === "propose_tasks" && Array.isArray(raw)) {
            proposals = raw as Array<Record<string, string>>;
            actions.push({ type, params: { tasks: raw } });
          } else {
            actions.push({ type, params: raw as Record<string, unknown> });
          }
        } catch {
          replyLines.push(line);
        }
      } else {
        replyLines.push(line);
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

  // ── Action execution ─────────────────────────────────────

  private async executeActions(
    actions: ManagerAction[],
    _context: ManagerContext
  ): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.type) {
          case "update_task": {
            const { id, ...rawUpdates } = action.params as { id: string; [k: string]: unknown };
            if (id && this.api) {
              // Only send fields the API accepts
              const allowedFields = ["title", "description", "owner", "priority", "status", "type", "sprint", "branch", "labels", "blocks", "blocked_by", "context_notes", "target_repo", "parent_task", "review_comment", "commits"];
              const updates: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(rawUpdates)) {
                if (allowedFields.includes(k)) updates[k] = v;
              }
              if (Object.keys(updates).length === 0) {
                ui.warn(`[manager] update_task ${id}: no valid fields`);
                break;
              }
              const fullId = this.resolveTaskId(id, _context);
              await this.api.updateTask(fullId, updates as Partial<Task>);
              ui.info(`[manager] Updated task ${id}`);
            }
            break;
          }
          case "create_task": {
            const { title, description, priority, owner } = action.params as {
              title: string; description?: string; priority?: string; owner?: string;
            };
            if (title) {
              await this.createTask(title, description, priority, owner, _context, this.lastUserMessage);
              ui.info(`[manager] Created task: ${title}`);
            }
            break;
          }
          case "transition_sprint": {
            const { status } = action.params as { status: string };
            if (status && _context.sprint && this.api) {
              if (status === "completed") {
                await this.api.completeSprint(_context.sprint.number);
              } else {
                // Use PATCH endpoint
                await fetch(`${this.apiUrl}/api/v1/sprints/${_context.sprint.number}`, {
                  method: "PATCH",
                  headers: this.authHeaders(),
                  body: JSON.stringify({ status }),
                });
              }
              ui.info(`[manager] Sprint transitioned to ${status}`);
            }
            break;
          }
          case "send_message": {
            const { to, content } = action.params as { to: string; content: string };
            if (to && content && this.api) {
              await this.api.sendMessage("manager", to, content);
              ui.info(`[manager] Sent message to ${to}`);
            }
            break;
          }
          case "spawn_agent": {
            const { role, task_ids } = action.params as { role: string; task_ids: string[] };
            if (role) {
              const fullIds = (task_ids ?? []).map((id) => this.resolveTaskId(id, _context));
              const approval: PendingApproval = {
                id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role,
                taskIds: fullIds,
                createdAt: Date.now(),
              };
              this.pendingApprovals.set(approval.id, approval);
              ui.info(`[manager] spawn_agent awaiting approval: ${role} (${approval.id})`);
              this.onApprovalRequest?.(approval);
            }
            break;
          }
          case "propose_tasks": {
            // propose_tasks params is an array directly (not wrapped in object)
            // Already handled via proposals return from parseResponse
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

  /** Resolve a short 8-char task ID prefix to full ID */
  private resolveTaskId(shortId: string, ctx: ManagerContext): string {
    const match = ctx.tasks.find((t) => t.id.startsWith(shortId));
    return match?.id ?? shortId;
  }

  private async createTask(
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

    await fetch(`${this.apiUrl}/api/v1/tasks`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
  }

  // ── Message handling (polling fallback) ──────────────────

  private async fetchMessages(): Promise<Array<{ id: string; from: string; to: string; content: string; created_at: string }>> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v1/messages?channel=manager`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { messages?: any[] } | any[];
      return Array.isArray(data) ? data : data.messages ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Find new inbound messages to manager (from users AND agents).
   * Excludes manager's own messages to avoid self-reply loops.
   */
  private findNewInboundMessages(
    messages: Array<{ id: string; from: string; to: string; content: string; created_at: string }>
  ): typeof messages {
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // Only consider messages TO manager, NOT from manager
    const isInbound = (m: { from: string; to: string }) =>
      m.to === "manager" && m.from !== "manager";

    if (!this.lastSeenId) {
      // First poll: only respond to last unread inbound message
      const lastInbound = sorted.filter(isInbound).pop();
      if (lastInbound) {
        const lastMsg = sorted[sorted.length - 1];
        if (lastMsg && isInbound(lastMsg) && lastMsg.id === lastInbound.id) {
          this.lastSeenId = lastInbound.id;
          return [lastInbound];
        }
      }
      if (sorted.length > 0) this.lastSeenId = sorted[sorted.length - 1].id;
      return [];
    }

    const lastSeenIdx = sorted.findIndex((m) => m.id === this.lastSeenId);
    const newMessages = lastSeenIdx === -1 ? sorted : sorted.slice(lastSeenIdx + 1);
    return newMessages.filter(isInbound);
  }

  private async postReplyTo(to: string, content: string): Promise<void> {
    await fetch(`${this.apiUrl}/api/v1/messages`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ from: "manager", to, content }),
    });
  }

  private async heartbeat(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify({ name: "manager", status: "active", activity: "listening" }),
      });
    } catch {
      // Non-fatal
    }
  }

  private authHeaders(): Record<string, string> {
    return createAuthHeaders(this.apiKey);
  }
}
