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
 *
 * Action execution logic: see manager-actions.ts
 * Prompt building logic: see manager-prompt.ts
 */

import { execSync } from "node:child_process";
import { createAuthHeaders, type ApiClient } from "../services/api-client.js";
import type { AgentRunner } from "../agents/runner.js";
import { createLlmProvider, type LlmProvider } from "../services/llm-provider.js";
import { PollLoop } from "../poll-loop.js";
import * as ui from "../ui.js";
import {
  parseResponse,
  executeActions as executeManagerActions,
  type ManagerContext,
  type ManagerAction,
  type ActionExecutionDeps,
} from "./manager-actions.js";
import {
  buildCodebaseSummary,
  buildSystemPrompt,
  buildManagerConversationHistory,
} from "./manager-prompt.js";

// ---------------------------------------------------------------------------
// Types (re-export for external consumers)
// ---------------------------------------------------------------------------

export type { ManagerContext, ManagerAction } from "./manager-actions.js";

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
  private codebaseSummary: string;

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
  /** Callback when Manager executes a tool (Read, Grep, etc.) */
  onToolUse?: (tool: string, summary: string) => void;
  /** Callback when a spawn_agent needs user approval */
  onApprovalRequest?: (approval: PendingApproval) => void;
  /** Callback when Manager activity changes (for WS broadcast) */
  onActivityChange?: (activity: string) => void;
  /** Callback for real-time data updates (sprint, task, etc.) */
  onDataUpdate?: (entity: string, id: string, changes: Record<string, unknown>) => void;

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
    this.codebaseSummary = buildCodebaseSummary(this.reposDir, this.repositories);
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
      await this.runActions(actions, context);
      ui.chatMessage("manager", "user", reply, "ws");
      await this.advanceLastSeen();
      return { reply, proposals };
    } finally {
      await this.updateActivity("listening");
    }
  }

  private async updateActivity(activity: string): Promise<void> {
    this.onActivityChange?.(activity);
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
        await this.runActions(actions, context);
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
    const systemPrompt = buildSystemPrompt(context, {
      reposDir: this.reposDir,
      repositories: this.repositories,
      codebaseSummary: this.codebaseSummary,
    });
    const conversationHistory = buildManagerConversationHistory(context);

    // Only enable tools when the user asks about code/implementation details.
    // For sprint management (proposals, status, phase changes), use context data only — much faster.
    const needsCodeAccess = /code|implement|file|bug|fix|debug|look at|read|check the|investigate|調査|確認|コード|ファイル|実装/i.test(userMessage);
    const useTools = !!this.reposDir && needsCodeAccess;

    if (useTools) {
      ui.debug("manager", "Tools enabled (code-related request)");
    }

    const llmResponse = await this.llmProvider.call({
      systemPrompt,
      history: conversationHistory,
      userMessage,
      model: this.model,
      onChunk: this.onStreamChunk,
      onToolUse: useTools ? this.onToolUse : undefined,
      cwd: useTools ? this.reposDir : undefined,
      enableTools: useTools,
      allowedTools: useTools ? ["Read", "Grep", "Glob", "Bash", "Agent"] : undefined,
    });

    const { reply, actions, proposals } = parseResponse(llmResponse);
    return { reply, actions, proposals };
  }

  // ── Action execution (delegates to manager-actions.ts) ──

  private async runActions(actions: ManagerAction[], context: ManagerContext): Promise<void> {
    const deps: ActionExecutionDeps = {
      apiUrl: this.apiUrl,
      apiKey: this.apiKey,
      api: this.api,
      lastUserMessage: this.lastUserMessage,
      pendingApprovals: this.pendingApprovals,
      onSpawnAgent: this.onSpawnAgent,
      onDataUpdate: this.onDataUpdate,
      onApprovalRequest: this.onApprovalRequest,
    };
    await executeManagerActions(actions, context, deps);
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
        workspace: { name: "Unknown", language: "en", description: null, spec: null },
        sprint: null,
        tasks: [],
        agents: [],
        recent_messages: [],
        playbook_rules: "",
      };
    }
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
