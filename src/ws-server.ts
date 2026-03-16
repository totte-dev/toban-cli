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
import { createAuthHeaders } from "./llm-client.js";
import * as ui from "./ui.js";

/** Message format over WebSocket */
interface WsMessage {
  type: "chat" | "status" | "ping" | "pong" | "stdout" | "stderr" | "revert" | "revert_result" | "proposals";
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
  /** Callback when first WS client connects */
  onClientConnected?: () => void;
  /** Callback when last WS client disconnects */
  onAllClientsDisconnected?: () => void;
  /** Callback when a revert is requested from the UI */
  onRevert?: (taskId: string, repo: string, commits: string[]) => Promise<{ ok: boolean; error?: string }>;
}

export class WsChatServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private port: number;
  private apiKey: string;
  private apiUrl: string;
  private onMessage: (message: string) => Promise<string | { reply: string; proposals?: Array<Record<string, string>> }>;
  private onClientConnected?: () => void;
  private onAllClientsDisconnected?: () => void;
  private onRevert?: (taskId: string, repo: string, commits: string[]) => Promise<{ ok: boolean; error?: string }>;
  private clients = new Set<WebSocket>();

  constructor(options: WsChatServerOptions) {
    this.port = options.port ?? 0;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.onMessage = options.onMessage;
    this.onClientConnected = options.onClientConnected;
    this.onAllClientsDisconnected = options.onAllClientsDisconnected;
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
        if (wasEmpty) this.onClientConnected?.();

        ws.on("message", async (data) => {
          try {
            const msg: WsMessage = JSON.parse(data.toString());
            await this.handleMessage(ws, msg);
          } catch (err) {
            ui.warn(`[ws] Invalid message: ${err}`);
            ws.send(JSON.stringify({
              type: "status",
              content: "Invalid message format",
            }));
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          ui.info(`[ws] Client disconnected (${this.clients.size} remaining)`);
          if (this.clients.size === 0) this.onAllClientsDisconnected?.();
        });

        ws.on("error", (err) => {
          ui.warn(`[ws] Client error: ${err.message}`);
          this.clients.delete(ws);
        });

        // Send welcome
        ws.send(JSON.stringify({
          type: "status",
          content: "connected",
          timestamp: new Date().toISOString(),
        }));
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
   */
  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
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
      type: "chat",
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleMessage(ws: WebSocket, msg: WsMessage): Promise<void> {
    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        break;

      case "chat": {
        if (!msg.content) return;

        // Save incoming message to API in background
        this.saveMessageToApi(msg.from ?? "user", "manager", msg.content).catch(() => {});

        // Send typing indicator
        this.broadcast({
          type: "status",
          content: "typing",
          timestamp: new Date().toISOString(),
        });

        try {
          // Generate reply (may include proposals)
          const result = await this.onMessage(msg.content);
          const reply = typeof result === "string" ? result : result.reply;
          const proposals = typeof result === "object" ? result.proposals : undefined;

          // Send reply via WebSocket
          const replyMsg: WsMessage = {
            type: "chat",
            from: "manager",
            to: "user",
            content: reply,
            timestamp: new Date().toISOString(),
          };
          this.broadcast(replyMsg);

          // Broadcast proposals as separate message if present
          if (proposals && proposals.length > 0) {
            this.broadcast({
              type: "proposals",
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
            type: "chat",
            from: "manager",
            to: "user",
            content: `Error: ${errMsg}`,
            timestamp: new Date().toISOString(),
          }));
        }
        break;
      }

      case "revert": {
        if (!msg.task_id || !msg.commits?.length) {
          ws.send(JSON.stringify({ type: "revert_result", task_id: msg.task_id, content: "Missing task_id or commits", timestamp: new Date().toISOString() }));
          return;
        }
        ui.info(`[ws] Revert requested for task ${msg.task_id}: ${msg.commits.length} commit(s)`);
        if (this.onRevert) {
          const result = await this.onRevert(msg.task_id, msg.repo ?? "default", msg.commits);
          this.broadcast({
            type: "revert_result",
            task_id: msg.task_id,
            content: result.ok ? "Revert completed successfully" : `Revert failed: ${result.error}`,
            timestamp: new Date().toISOString(),
          });
        } else {
          ws.send(JSON.stringify({ type: "revert_result", task_id: msg.task_id, content: "Revert not supported", timestamp: new Date().toISOString() }));
        }
        break;
      }

      default:
        // Ignore unknown message types
        break;
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
