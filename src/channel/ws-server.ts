/**
 * WebSocket server for direct browser-to-CLI chat communication.
 *
 * Flow:
 * 1. CLI starts a WS server on a local port
 * 2. CLI registers the WS port with the Toban API
 * 3. Dashboard connects directly via WebSocket
 * 4. Chat messages flow through WS (instant), history saved to API in background
 *
 * Falls back to API polling if WS connection is not established.
 */

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createAuthHeaders } from "../services/api-client.js";
import { WS_MSG, type WsMsgType, wrapLegacyMessage, type WsTobanEvent } from "./ws-types.js";
import type { JobQueue } from "../services/job-queue.js";
import * as ui from "../ui.js";

/** Message format over WebSocket */
interface WsMessage {
  type: WsMsgType;
  from?: string;
  to?: string;
  content?: string;
  timestamp?: string;
  /** Agent name for stdout/stderr messages */
  agent_name?: string;
  /** Revert-specific fields */
  task_id?: string;
  repo?: string;
  commits?: string[];
  /** Proposal-specific fields */
  tasks?: Array<Record<string, string>>;
  /** Approval-specific fields */
  approval_id?: string;
  approved?: boolean;
  role?: string;
  task_ids?: string[];
  /** Activity-specific fields */
  kind?: string;
  tool?: string;
  /** Data update fields */
  entity?: string;
  changes?: Record<string, unknown>;
  /** Review update fields */
  phase?: string;
  review_comment?: string;
  /** Channel message fields */
  messages?: Array<Record<string, unknown>>;
  /** Enrich result fields */
  ok?: boolean;
  status?: string;
}

export interface WsChatServerOptions {
  /** Port to listen on (0 = auto-assign) */
  port?: number;
  /** API key for authentication on WS handshake */
  apiKey: string;
  /** Toban API URL for registering the WS port and saving history */
  apiUrl: string;
  /** Callback when a user message is received. Returns reply + optional proposals. */
  onMessage: (message: string) => Promise<string | { reply: string; proposals?: Array<Record<string, string>> }>;
  /** Callback when a revert is requested from the UI */
  onRevert?: (taskId: string, repo: string, commits: string[]) => Promise<{ ok: boolean; error?: string }>;
}

/** Tracked review state for a task */
interface ReviewState {
  task_id: string;
  agent_name?: string;
  phase: string;
  review_comment?: string;
  timestamp: string;
}

/** Terminal review phases that expire after a timeout */
const TERMINAL_PHASES = new Set(["completed", "failed"]);
/** How long to keep terminal review states for re-send (5 minutes) */
const REVIEW_STATE_TTL_MS = 5 * 60 * 1000;

export class WsChatServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private port: number;
  private apiKey: string;
  private apiUrl: string;
  private onMessage: (message: string) => Promise<string | { reply: string; proposals?: Array<Record<string, string>> }>;
  private onRevert?: (taskId: string, repo: string, commits: string[]) => Promise<{ ok: boolean; error?: string }>;
  private clients = new Set<WebSocket>();
  /** Lock to prevent concurrent message processing */
  private chatProcessing = false;
  /** Latest review state per task for re-sending on reconnect */
  private reviewStates = new Map<string, ReviewState>();
  /** Current sprint number for event context */
  currentSprint?: number;
  /** Job queue for enrich/review jobs */
  jobQueue?: JobQueue;

  /** Whether any browser clients are connected */
  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  constructor(options: WsChatServerOptions) {
    this.port = options.port ?? 0;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.onMessage = options.onMessage;
    this.onRevert = options.onRevert;
  }

  /**
   * Start the WebSocket server.
   * Returns the actual port (useful when port=0 for auto-assign).
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.wss = new WebSocketServer({
        server: this.httpServer,
        verifyClient: (info, done) => {
          // Authenticate via query param or header
          const url = new URL(info.req.url ?? "/", `http://localhost`);
          const token = url.searchParams.get("token") ??
            this.extractBearerToken(info.req);

          if (token === this.apiKey) {
            done(true);
          } else {
            done(false, 401, "Unauthorized");
          }
        },
      });

      this.wss.on("connection", (ws) => {
        const wasEmpty = this.clients.size === 0;
        this.clients.add(ws);
        ui.info(`[ws] Client connected (${this.clients.size} total)`);
        // Client connected

        ws.on("message", async (data) => {
          try {
            const msg: WsMessage = JSON.parse(data.toString());
            await this.handleMessage(ws, msg);
          } catch (err) {
            ui.warn(`[ws] Invalid message: ${err}`);
            ws.send(JSON.stringify({
              type: WS_MSG.STATUS,
              content: "Invalid message format",
            }));
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          ui.info(`[ws] Client disconnected (${this.clients.size} remaining)`);
          // All clients disconnected
        });

        ws.on("error", (err) => {
          ui.warn(`[ws] Client error: ${err.message}`);
          this.clients.delete(ws);
        });

        // Send welcome
        ws.send(JSON.stringify({
          type: WS_MSG.STATUS,
          content: "connected",
          timestamp: new Date().toISOString(),
        }));

        // Re-send latest review states to newly connected client
        this.sendPendingReviewStates(ws);

        // Approval flow removed — task dispatch is automatic
      });

      this.httpServer.on("error", (err) => {
        reject(err);
      });

      this.httpServer.listen(this.port, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.port = actualPort;
        ui.step(`[ws] WebSocket server listening on ws://127.0.0.1:${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  /**
   * Register the WS port with the Toban API so the dashboard can discover it.
   */
  async registerPort(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: createAuthHeaders(this.apiKey),
        body: JSON.stringify({
          name: "manager",
          status: "active",
          activity: "listening",
          ws_port: this.port,
        }),
      });
      ui.step(`[ws] Registered WS port ${this.port} with API`);
    } catch (err) {
      ui.warn(`[ws] Failed to register WS port: ${err}`);
    }
  }

  /**
   * Send a message to all connected clients.
   * Tracks REVIEW_UPDATE messages for re-sending on reconnect.
   */
  broadcast(message: WsMessage): void {
    // Track review state for re-sending to new clients
    if (message.type === WS_MSG.REVIEW_UPDATE && message.task_id) {
      this.reviewStates.set(message.task_id, {
        task_id: message.task_id,
        agent_name: message.agent_name,
        phase: message.phase ?? "unknown",
        review_comment: message.review_comment,
        timestamp: message.timestamp ?? new Date().toISOString(),
      });
    }

    // Wrap legacy message in TobanEvent envelope
    const { type: legacyType, ...fields } = message;
    const envelope = wrapLegacyMessage(legacyType, fields, { sprint: this.currentSprint });
    const data = JSON.stringify(envelope);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Broadcast a TobanEvent directly (new format, no wrapping needed).
   */
  broadcastEvent(event: WsTobanEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Broadcast agent stdout/stderr lines to all connected clients.
   */
  broadcastStdout(agentName: string, lines: string[], stream: "stdout" | "stderr" = "stdout"): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify({
      type: stream,
      agent_name: agentName,
      content: lines.join("\n"),
      timestamp: new Date().toISOString(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Send latest review states to a newly connected client.
   * Prunes expired terminal states (completed/failed older than TTL).
   */
  private sendPendingReviewStates(ws: WebSocket): void {
    const now = Date.now();
    let sent = 0;

    for (const [taskId, state] of this.reviewStates) {
      // Prune old terminal states
      const stateAge = now - new Date(state.timestamp).getTime();
      if (TERMINAL_PHASES.has(state.phase) && stateAge > REVIEW_STATE_TTL_MS) {
        this.reviewStates.delete(taskId);
        continue;
      }

      const envelope = wrapLegacyMessage(WS_MSG.REVIEW_UPDATE, {
        task_id: state.task_id,
        agent_name: state.agent_name,
        phase: state.phase,
        review_comment: state.review_comment,
        timestamp: state.timestamp,
      }, { sprint: this.currentSprint });
      ws.send(JSON.stringify(envelope));
      sent++;
    }

    if (sent > 0) {
      ui.info(`[ws] Re-sent ${sent} review state(s) to new client`);
    }
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    // Unregister WS port
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: createAuthHeaders(this.apiKey),
        body: JSON.stringify({
          name: "manager",
          status: "active",
          activity: "listening",
          ws_port: null,
        }),
      });
    } catch {
      // Best effort
    }

    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    this.wss?.close();
    this.httpServer?.close();
    ui.info("[ws] WebSocket server stopped");
  }

  /** Number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }

  /** The port this server is listening on */
  get listeningPort(): number {
    return this.port;
  }

  private handleHttpRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    // Health check
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: this.clients.size }));
      return;
    }

    // Agent message endpoint
    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { from, to, content } = JSON.parse(body);
          if (!from || !to || !content) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "from, to, content required" }));
            return;
          }
          this.handleAgentMessage(from, to, content);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleAgentMessage(from: string, to: string, content: string): void {
    ui.info(`[ws] Agent message: ${from} → ${to}`);
    this.saveMessageToApi(from, to, content).catch(() => {});
    this.broadcast({
      type: WS_MSG.CHAT,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleMessage(ws: WebSocket, msg: WsMessage): Promise<void> {
    switch (msg.type) {
      case WS_MSG.PING:
        ws.send(JSON.stringify({ type: WS_MSG.PONG, timestamp: new Date().toISOString() }));
        break;

      case WS_MSG.CHAT: {
        if (!msg.content) return;

        // Prevent concurrent LLM calls from multiple tabs
        if (this.chatProcessing) {
          ws.send(JSON.stringify({
            type: WS_MSG.STATUS,
            content: "busy",
            timestamp: new Date().toISOString(),
          }));
          return;
        }
        this.chatProcessing = true;

        // Save incoming message to API in background
        this.saveMessageToApi(msg.from ?? "user", "manager", msg.content).catch(() => {});

        // Send streaming start indicator (creates the streaming bubble in UI)
        this.broadcast({
          type: WS_MSG.CHAT_STREAM,
          from: "manager",
          content: "",
          timestamp: new Date().toISOString(),
        });

        try {
          // Generate reply (may include proposals)
          const result = await this.onMessage(msg.content);
          const reply = typeof result === "string" ? result : result.reply;
          const proposals = typeof result === "object" ? result.proposals : undefined;

          // Send final complete reply (signals stream end)
          const replyMsg: WsMessage = {
            type: WS_MSG.CHAT,
            from: "manager",
            to: "user",
            content: reply,
            timestamp: new Date().toISOString(),
          };
          this.broadcast(replyMsg);

          // Broadcast proposals as separate message if present
          if (proposals && proposals.length > 0) {
            this.broadcast({
              type: WS_MSG.PROPOSALS,
              tasks: proposals,
              timestamp: new Date().toISOString(),
            });
            ui.info(`[ws] Sent ${proposals.length} task proposal(s) to UI`);
          }

          // Save reply to API in background
          this.saveMessageToApi("manager", "user", reply).catch(() => {});
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          ws.send(JSON.stringify({
            type: WS_MSG.CHAT,
            from: "manager",
            to: "user",
            content: `Error: ${errMsg}`,
            timestamp: new Date().toISOString(),
          }));
        } finally {
          this.chatProcessing = false;
        }
        break;
      }

      case WS_MSG.REVERT: {
        if (!msg.task_id || !msg.commits?.length) {
          ws.send(JSON.stringify({ type: WS_MSG.REVERT_RESULT, task_id: msg.task_id, content: "Missing task_id or commits", timestamp: new Date().toISOString() }));
          return;
        }
        ui.info(`[ws] Revert requested for task ${msg.task_id}: ${msg.commits.length} commit(s)`);
        if (this.onRevert) {
          const result = await this.onRevert(msg.task_id, msg.repo ?? "default", msg.commits);
          this.broadcast({
            type: WS_MSG.REVERT_RESULT,
            task_id: msg.task_id,
            content: result.ok ? "Revert completed successfully" : `Revert failed: ${result.error}`,
            timestamp: new Date().toISOString(),
          });
        } else {
          ws.send(JSON.stringify({ type: WS_MSG.REVERT_RESULT, task_id: msg.task_id, content: "Revert not supported", timestamp: new Date().toISOString() }));
        }
        break;
      }

      case WS_MSG.ENRICH_TASK: {
        if (!msg.task_id) {
          ws.send(JSON.stringify({ type: WS_MSG.ENRICH_RESULT, task_id: null, content: "Missing task_id", ok: false, timestamp: new Date().toISOString() }));
          return;
        }
        ui.info(`[ws] Enrich requested for task ${msg.task_id}`);
        if (this.jobQueue) {
          const { createJobId } = await import("../services/job-queue.js");
          this.jobQueue.enqueue({
            id: createJobId(),
            type: "enrich",
            status: "pending",
            taskId: msg.task_id,
            createdAt: new Date().toISOString(),
          });
        } else {
          // Fallback: direct handling if no queue configured
          this.handleEnrichTask(msg.task_id).catch((err) => {
            ui.warn(`[ws] Enrich failed: ${err}`);
          });
        }
        break;
      }

      default:
        // Ignore unknown message types
        break;
    }
  }

  async handleEnrichTask(taskId: string): Promise<void> {
    // Broadcast enriching status
    this.broadcast({
      type: WS_MSG.ENRICH_RESULT,
      task_id: taskId,
      content: "Enriching...",
      ok: true,
      status: "started",
      timestamp: new Date().toISOString(),
    });

    try {
      // Fetch task details
      const res = await fetch(`${this.apiUrl}/api/v1/tasks?sprint=-1`, {
        headers: createAuthHeaders(this.apiKey),
      });
      // Also check active sprints
      const allTasksRes = await fetch(`${this.apiUrl}/api/v1/tasks`, {
        headers: createAuthHeaders(this.apiKey),
      });
      const allTasks = (await allTasksRes.json()) as Array<{ id: string; title: string; description: string; type?: string }>;
      const task = allTasks.find((t) => t.id === taskId || t.id.startsWith(taskId));

      if (!task) {
        this.broadcast({ type: WS_MSG.ENRICH_RESULT, task_id: taskId, content: "Task not found", ok: false, timestamp: new Date().toISOString() });
        return;
      }

      const { spawnClaudeOnce } = await import("../utils/spawn-claude.js");
      const prompt = `You are a task decomposition agent. Given a task title and description memo, generate structured fields.

Task: ${task.title}
Type: ${task.type || "feature"}
Description memo:
${task.description || "(empty)"}

Output ONLY a JSON object with these fields (no markdown, no explanation):
{
  "steps": ["step 1", "step 2", ...],
  "acceptance_criteria": ["criterion 1", "criterion 2", ...],
  "files_hint": ["path/to/likely/file.ts", ...],
  "constraints_list": ["constraint 1", ...],
  "category": "read_only" | "mutating" | "destructive"
}

Rules:
- steps: 3-8 concrete implementation steps
- acceptance_criteria: 2-5 testable conditions for "done"
- files_hint: likely files to modify (best guess from description)
- constraints_list: things to avoid or be careful about
- category: read_only (no code changes), mutating (code changes), destructive (deploy/revert/delete)`;

      const result = await spawnClaudeOnce(prompt, { role: "strategist", maxTurns: 1, timeout: 60_000 });
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.broadcast({ type: WS_MSG.ENRICH_RESULT, task_id: taskId, content: "Failed to parse LLM response", ok: false, timestamp: new Date().toISOString() });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      if (Array.isArray(parsed.steps) && parsed.steps.length) update.steps = parsed.steps;
      if (Array.isArray(parsed.acceptance_criteria) && parsed.acceptance_criteria.length) update.acceptance_criteria = parsed.acceptance_criteria;
      if (Array.isArray(parsed.files_hint) && parsed.files_hint.length) update.files_hint = parsed.files_hint;
      if (Array.isArray(parsed.constraints_list) && parsed.constraints_list.length) update.constraints_list = parsed.constraints_list;
      if (parsed.category) update.category = parsed.category;

      // Save to API
      await fetch(`${this.apiUrl}/api/v1/tasks/${task.id}`, {
        method: "PATCH",
        headers: createAuthHeaders(this.apiKey),
        body: JSON.stringify(update),
      });

      // Broadcast completion + data update
      this.broadcast({ type: WS_MSG.ENRICH_RESULT, task_id: taskId, content: "Enriched", ok: true, status: "completed", timestamp: new Date().toISOString() });
      this.broadcast({ type: WS_MSG.DATA_UPDATE, entity: "task", task_id: task.id, changes: update, timestamp: new Date().toISOString() });
      ui.info(`[ws] Enriched task ${task.id.slice(0, 8)}: ${Object.keys(update).join(", ")}`);
    } catch (err) {
      this.broadcast({ type: WS_MSG.ENRICH_RESULT, task_id: taskId, content: `Error: ${err instanceof Error ? err.message : err}`, ok: false, timestamp: new Date().toISOString() });
    }
  }

  private async saveMessageToApi(
    from: string,
    to: string,
    content: string
  ): Promise<void> {
    await fetch(`${this.apiUrl}/api/v1/messages`, {
      method: "POST",
      headers: createAuthHeaders(this.apiKey),
      body: JSON.stringify({ from, to, content }),
    });
  }

  private extractBearerToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      return auth.slice(7);
    }
    return null;
  }
}
