import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WS_MSG } from "../ws-types.js";

describe("WS_MSG.REVIEW_UPDATE", () => {
  it("should be defined as 'review_update'", () => {
    expect(WS_MSG.REVIEW_UPDATE).toBe("review_update");
  });

  it("should be included in the WS_MSG constants", () => {
    const allTypes = Object.values(WS_MSG);
    expect(allTypes).toContain("review_update");
  });
});

describe("REVIEW_UPDATE message format", () => {
  it("should produce a valid message structure with all fields", () => {
    const message = {
      type: WS_MSG.REVIEW_UPDATE,
      task_id: "task-123",
      agent_name: "builder",
      phase: "completed",
      review_comment: '{"verdict":"APPROVE"}',
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("review_update");
    expect(message.task_id).toBe("task-123");
    expect(message.agent_name).toBe("builder");
    expect(message.phase).toBe("completed");
    expect(message.review_comment).toBeDefined();
  });

  it("should allow message without review_comment for progress phases", () => {
    const message: Record<string, unknown> = {
      type: WS_MSG.REVIEW_UPDATE,
      task_id: "task-456",
      agent_name: "builder",
      phase: "started",
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe("review_update");
    expect(message.phase).toBe("started");
    expect(message.review_comment).toBeUndefined();
  });

  it("should support all review phases", () => {
    const phases = ["started", "analyzing", "agent_submitted", "completed", "failed"];
    for (const phase of phases) {
      const message = {
        type: WS_MSG.REVIEW_UPDATE,
        task_id: "task-789",
        phase,
      };
      expect(message.phase).toBe(phase);
    }
  });
});

describe("WsChatServer review state tracking", () => {
  // Use dynamic import to allow mocking
  let WsChatServer: typeof import("../ws-server.js").WsChatServer;
  let WebSocket: typeof import("ws").WebSocket;

  beforeEach(async () => {
    const wsServerModule = await import("../ws-server.js");
    WsChatServer = wsServerModule.WsChatServer;
    const wsModule = await import("ws");
    WebSocket = wsModule.WebSocket;
  });

  function createServer() {
    return new WsChatServer({
      port: 0,
      apiKey: "test-key",
      apiUrl: "http://localhost:9999",
      onMessage: async () => "ok",
    });
  }

  /** Connect a client and immediately start collecting messages (including those sent on connect) */
  async function connectClient(port: number): Promise<{ ws: import("ws").WebSocket; messages: Array<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=test-key`);
      const messages: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
      });
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("error", reject);
    });
  }

  it("should track latest review state per task via broadcast", async () => {
    const server = createServer();
    const port = await server.start();

    try {
      const { ws: client, messages } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));

      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-100",
        agent_name: "builder",
        phase: "started",
        timestamp: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, 50));

      const reviewMsgs = messages.filter((m) => m.type === "review_update");
      expect(reviewMsgs).toHaveLength(1);
      expect(reviewMsgs[0].task_id).toBe("task-100");
      expect(reviewMsgs[0].phase).toBe("started");

      client.close();
    } finally {
      await server.stop();
    }
  });

  it("should re-send latest review states to newly connected clients", async () => {
    const server = createServer();
    const port = await server.start();

    try {
      const { ws: client1 } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));

      // Broadcast review updates to build up state
      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-200",
        agent_name: "builder",
        phase: "started",
        timestamp: new Date().toISOString(),
      });
      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-200",
        agent_name: "builder",
        phase: "completed",
        review_comment: '{"verdict":"APPROVE"}',
        timestamp: new Date().toISOString(),
      });
      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-300",
        agent_name: "builder",
        phase: "analyzing",
        timestamp: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, 50));

      // Connect second client — should receive latest review states on connect
      const { ws: client2, messages: messages2 } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 100));

      const reviewMsgs = messages2.filter((m) => m.type === "review_update");
      expect(reviewMsgs).toHaveLength(2);

      const task200 = reviewMsgs.find((m) => m.task_id === "task-200");
      expect(task200).toBeDefined();
      expect(task200!.phase).toBe("completed");
      expect(task200!.review_comment).toBe('{"verdict":"APPROVE"}');

      const task300 = reviewMsgs.find((m) => m.task_id === "task-300");
      expect(task300).toBeDefined();
      expect(task300!.phase).toBe("analyzing");

      client1.close();
      client2.close();
    } finally {
      await server.stop();
    }
  });

  it("should not re-send review states in terminal phases (completed/failed) older than 5 minutes", async () => {
    const server = createServer();
    const port = await server.start();

    try {
      const { ws: client1 } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));

      // Broadcast a completed review with old timestamp
      const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-old",
        agent_name: "builder",
        phase: "completed",
        review_comment: "old review",
        timestamp: oldTimestamp,
      });

      // Broadcast an active review (not terminal)
      server.broadcast({
        type: WS_MSG.REVIEW_UPDATE as "review_update",
        task_id: "task-active",
        agent_name: "builder",
        phase: "analyzing",
        timestamp: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, 50));

      // Connect new client — should only get active review, not the expired one
      const { ws: client2, messages: messages2 } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 100));

      const reviewMsgs = messages2.filter((m) => m.type === "review_update");
      expect(reviewMsgs).toHaveLength(1);
      expect(reviewMsgs[0].task_id).toBe("task-active");

      client1.close();
      client2.close();
    } finally {
      await server.stop();
    }
  });

  it("should broadcast multiple phase transitions in order", async () => {
    const server = createServer();
    const port = await server.start();

    try {
      const { ws: client, messages } = await connectClient(port);
      await new Promise((r) => setTimeout(r, 50));

      const phases = ["started", "analyzing", "completed"];
      for (const phase of phases) {
        server.broadcast({
          type: WS_MSG.REVIEW_UPDATE as "review_update",
          task_id: "task-500",
          agent_name: "builder",
          phase,
          timestamp: new Date().toISOString(),
        });
      }

      await new Promise((r) => setTimeout(r, 50));

      const reviewMsgs = messages.filter((m) => m.type === "review_update");
      expect(reviewMsgs).toHaveLength(3);
      expect(reviewMsgs.map((m) => m.phase)).toEqual(["started", "analyzing", "completed"]);

      client.close();
    } finally {
      await server.stop();
    }
  });
});
