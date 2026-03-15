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

/** Message format over WebSocket */
interface WsMessage {
  type: "chat" | "status" | "ping" | "pong" | "stdout" | "stderr";
  from?: string;
  to?: string;
  content?: string;
  timestamp?: string;
  /** Agent name for stdout/stderr messages */
  agent_name?: string;
}

export interface WsChatServerOptions {
  /** Port to listen on (0 = auto-assign) */
  port?: number;
  /** API key for authentication on WS handshake */
  apiKey: string;
  /** Toban API URL for registering the WS port and saving history */
  apiUrl: string;
  /** Callback when a user message is received */
  onMessage: (message: string) => Promise<string>;
}

export class WsChatServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private port: number;
  private apiKey: string;
  private apiUrl: string;
  private onMessage: (message: string) => Promise<string>;
  private clients = new Set<WebSocket>();

  constructor(options: WsChatServerOptions) {
    this.port = options.port ?? 0;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl;
    this.onMessage = options.onMessage;
  }

  /**
   * Start the WebSocket server.
   * Returns the actual port (useful when port=0 for auto-assign).
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer();

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
        this.clients.add(ws);
        console.log(`[ws] Client connected (${this.clients.size} total)`);

        ws.on("message", async (data) => {
          try {
            const msg: WsMessage = JSON.parse(data.toString());
            await this.handleMessage(ws, msg);
          } catch (err) {
            console.error(`[ws] Invalid message:`, err);
            ws.send(JSON.stringify({
              type: "status",
              content: "Invalid message format",
            }));
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
          console.log(`[ws] Client disconnected (${this.clients.size} remaining)`);
        });

        ws.on("error", (err) => {
          console.error(`[ws] Client error:`, err.message);
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
        console.log(`[ws] WebSocket server listening on ws://127.0.0.1:${actualPort}`);
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          name: "manager",
          status: "active",
          activity: "listening",
          ws_port: this.port,
        }),
      });
      console.log(`[ws] Registered WS port ${this.port} with API`);
    } catch (err) {
      console.warn(`[ws] Failed to register WS port: ${err}`);
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
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
    console.log("[ws] WebSocket server stopped");
  }

  /** Number of connected clients */
  get clientCount(): number {
    return this.clients.size;
  }

  /** The port this server is listening on */
  get listeningPort(): number {
    return this.port;
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
          // Generate reply
          const reply = await this.onMessage(msg.content);

          // Send reply via WebSocket
          const replyMsg: WsMessage = {
            type: "chat",
            from: "manager",
            to: "user",
            content: reply,
            timestamp: new Date().toISOString(),
          };
          this.broadcast(replyMsg);

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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
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
