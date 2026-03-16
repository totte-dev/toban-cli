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

import { spawn } from "node:child_process";
import type { ApiClient, Task } from "./api-client.js";
import type { AgentRunner } from "./runner.js";
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
  type: "spawn_agent" | "update_task" | "create_task" | "transition_sprint" | "send_message";
  params: Record<string, unknown>;
}

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
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class Manager {
  private apiUrl: string;
  private apiKey: string;
  private llmBaseUrl?: string;
  private llmApiKey?: string;
  private model: string;
  private pollIntervalMs: number;
  private runner: AgentRunner | null;
  private api: ApiClient | null;
  private lastSeenId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private useClaudeCli: boolean;

  /** Callbacks for actions the Manager can't execute directly */
  onSpawnAgent?: (role: string, taskIds: string[]) => Promise<void>;
  /** Callback to broadcast reply via WebSocket (for poll-path messages) */
  onReply?: (reply: string) => void;

  constructor(options: ManagerOptions) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.llmBaseUrl = options.llmBaseUrl;
    this.llmApiKey = options.llmApiKey;
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.runner = options.runner ?? null;
    this.api = options.api ?? null;
    this.useClaudeCli = !options.llmBaseUrl || !options.llmApiKey;
  }

  // ── Lifecycle ────────────────────────────────────────────

  start(): void {
    ui.info(`[manager] Started (poll every ${this.pollIntervalMs / 1000}s, model: ${this.model})`);
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    ui.debug("manager", "Manager stopped");
  }

  /** Pause polling when WS clients are connected (messages come via WS) */
  pausePolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      ui.info("[manager] Polling paused (WS connected)");
    }
  }

  /** Resume polling when all WS clients disconnected */
  resumePolling(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
      ui.info("[manager] Polling resumed (no WS clients)");
    }
  }

  // ── WebSocket entry point ────────────────────────────────

  /**
   * Handle a message received via WebSocket.
   * Fetches context, calls LLM, executes actions, returns reply.
   */
  async handleWsMessage(content: string): Promise<string> {
    const context = await this.fetchContext();
    const { reply, actions } = await this.think(content, context);
    await this.executeActions(actions, context);
    ui.chatExchange("user", content, reply, actions.length, "ws");
    // Advance lastSeenId so poll doesn't reprocess this message
    await this.advanceLastSeen();
    return reply;
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
    if (this.processing) return;
    this.processing = true;

    try {
      await this.heartbeat();

      const messages = await this.fetchMessages();
      if (!messages || messages.length === 0) return;

      const newMessages = this.findNewInboundMessages(messages);
      if (newMessages.length > 0) {
        ui.debug("manager", `${newMessages.length} new message(s) to process`);
      }

      for (const msg of newMessages) {
        const isFromUser = msg.from === "user" || msg.from.startsWith("user:");

        try {
          const senderContext = isFromUser
            ? `[Message from user: ${msg.from}]`
            : `[Message from agent: ${msg.from}]`;
          const enrichedContent = `${senderContext}\n${msg.content}`;

          const context = await this.fetchContext();
          const { reply, actions } = await this.think(enrichedContent, context);
          await this.executeActions(actions, context);
          await this.postReplyTo(msg.from, reply);
          if (isFromUser) {
            this.onReply?.(reply);
          }
          // Compact log: inbound + reply on two lines
          ui.chatExchange(msg.from, msg.content, reply, actions.length);
        } catch (err) {
          ui.chatExchange(msg.from, msg.content, `Error: ${err}`, 0);
          await this.postReplyTo(msg.from, "Sorry, an error occurred while processing your message. Please try again.").catch(() => {});
        }

        this.lastSeenId = msg.id;
      }
    } catch (err) {
      ui.debug("manager", `Poll error: ${err}`);
    } finally {
      this.processing = false;
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
  ): Promise<{ reply: string; actions: ManagerAction[] }> {
    const systemPrompt = this.buildSystemPrompt(context);
    const conversationHistory = this.buildConversationHistory(context);

    let llmResponse: string;
    if (this.useClaudeCli) {
      llmResponse = await this.callClaudeCli(systemPrompt, conversationHistory, userMessage);
    } else {
      llmResponse = await this.callLlmApi(systemPrompt, conversationHistory, userMessage);
    }

    const { reply, actions } = this.parseResponse(llmResponse);
    return { reply, actions };
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
          return `  - ${a.name}: ${a.status}${act}`;
        }).join("\n")
      : "  (no agents)";

    const phaseInstructions = this.getPhaseInstructions(ctx.sprint?.status ?? "unknown");

    return `You are the Sprint Manager for project "${ctx.workspace.name}".
Respond in ${lang}.

## Current State
${sprintInfo}

### Tasks
${taskLines}

### Agents
${agentLines}

${phaseInstructions}

## Available Actions
You can take actions by including ACTION blocks in your response.
Format: ACTION: <type> <json_params>

Available action types:
- spawn_agent: Start an agent to work on tasks. Params: {"role": "builder", "task_ids": ["id1"]}
- update_task: Update a task. Params: {"id": "task_id", "status": "in_progress", "owner": "builder"}
- create_task: Create a new task. Params: {"title": "...", "description": "...", "priority": "p1", "owner": "builder"}
- transition_sprint: Change sprint phase. Params: {"status": "review"}
- send_message: Send a message to an agent. Params: {"to": "builder", "content": "..."}

## Rules
- Lead with action proposals, not status reports.
- Keep responses concise (3-5 sentences).
- Include ACTION blocks ONLY when you are confident the user wants that action taken.
- When proposing actions, describe what you'll do and include the ACTION block.
- Task IDs in your actions should use the short 8-char prefix shown above.
- Messages may come from users (user:xxx) or agents (builder, strategist, etc.).
- When an agent reports a blocker or asks for help, take action to unblock them.
- Reply in the same language the sender used.
${ctx.playbook_rules ? `\n## Playbook Rules\n${ctx.playbook_rules}` : ""}`;
  }

  private getPhaseInstructions(phase: string): string {
    switch (phase) {
      case "planning":
        return `## Phase: Planning
Help the user plan the sprint. Suggest task priorities and agent assignments.
If ready, propose transitioning to "active".`;
      case "active":
        return `## Phase: Active
Manage sprint execution. Propose spawning agents for TODO tasks.
Report on in-progress work. Suggest moving to "review" when done.`;
      case "review":
        return `## Phase: Review
Help review completed work. Summarize tasks and ask for approval.
Suggest moving to "retrospective" when all reviewed.`;
      case "retrospective":
        return `## Phase: Retrospective
Facilitate retrospective. Summarize results, ask for feedback.
Suggest closing the sprint when done.`;
      default:
        return `## Phase: ${phase}
Help the user with sprint management.`;
    }
  }

  // ── Conversation history ─────────────────────────────────

  private buildConversationHistory(
    ctx: ManagerContext
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const msg of ctx.recent_messages) {
      const role: "user" | "assistant" = (msg.from === "user" || msg.from.startsWith("user:")) ? "user" : "assistant";
      if (history.length > 0 && history[history.length - 1].role === role) {
        history[history.length - 1].content += "\n" + msg.content;
      } else {
        history.push({ role, content: msg.content });
      }
    }

    // OpenAI APIs require starting with "user"
    while (history.length > 0 && history[0].role !== "user") {
      history.shift();
    }

    // Keep last 10 turns
    return history.slice(-10);
  }

  // ── Response parsing ─────────────────────────────────────

  private parseResponse(response: string): { reply: string; actions: ManagerAction[] } {
    const actions: ManagerAction[] = [];
    const replyLines: string[] = [];

    for (const line of response.split("\n")) {
      const actionMatch = line.match(/^ACTION:\s*(\w+)\s+(.+)$/);
      if (actionMatch) {
        try {
          const type = actionMatch[1] as ManagerAction["type"];
          const params = JSON.parse(actionMatch[2]) as Record<string, unknown>;
          actions.push({ type, params });
        } catch {
          // Invalid JSON, treat as normal text
          replyLines.push(line);
        }
      } else {
        replyLines.push(line);
      }
    }

    const reply = replyLines.join("\n").trim() || "(no response)";
    return { reply, actions };
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
            const { id, ...updates } = action.params as { id: string; [k: string]: unknown };
            if (id && this.api) {
              // Resolve short ID to full ID from context
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
              await this.createTask(title, description, priority, owner, _context);
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
            if (role && this.onSpawnAgent) {
              const fullIds = (task_ids ?? []).map((id) => this.resolveTaskId(id, _context));
              await this.onSpawnAgent(role, fullIds);
              ui.info(`[manager] Spawning ${role} agent`);
            }
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
    ctx?: ManagerContext
  ): Promise<void> {
    const body: Record<string, unknown> = { title };
    if (description) body.description = description;
    if (priority) body.priority = priority;
    if (owner) body.owner = owner;
    if (ctx?.sprint) body.sprint = ctx.sprint.number;

    await fetch(`${this.apiUrl}/api/v1/tasks`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
  }

  // ── LLM backends ────────────────────────────────────────

  private async callClaudeCli(
    systemPrompt: string,
    history: Array<{ role: string; content: string }>,
    userMessage: string
  ): Promise<string> {
    const contextLines = history.slice(-6).map((m) => {
      const label = m.role === "user" ? "User" : "Manager";
      return `${label}: ${m.content}`;
    });

    const fullPrompt = contextLines.length > 0
      ? `Recent conversation:\n${contextLines.join("\n")}\n\nUser: ${userMessage}`
      : userMessage;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    return new Promise<string>((resolve, reject) => {
      const child = spawn("claude", [
        "--print",
        "--system-prompt", systemPrompt,
        "--model", this.model,
        fullPrompt,
      ], {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude CLI timed out after 180s"));
      }, 180_000);

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new Error("Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
        } else {
          reject(new Error(`Claude CLI error: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim() || "(no response)");
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });
    });
  }

  private async callLlmApi(
    systemPrompt: string,
    history: Array<{ role: string; content: string }>,
    userMessage: string
  ): Promise<string> {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history,
      { role: "user" as const, content: userMessage },
    ];

    const baseUrl = this.llmBaseUrl!.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.llmApiKey!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "(no response)";
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
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
