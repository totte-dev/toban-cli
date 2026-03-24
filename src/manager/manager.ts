/**
 * Manager — Lightweight sprint manager (LLM deprecated).
 *
 * Previously powered by LLM for chat and task dispatch.
 * Now: heartbeat only + fixed WS responses.
 * Task dispatch is handled by run-loop directly.
 */

import { execSync } from "node:child_process";
import { createAuthHeaders, type ApiClient } from "../services/api-client.js";
import type { AgentRunner } from "../agents/runner.js";
import * as ui from "../ui.js";

// ---------------------------------------------------------------------------
// Types (kept for backward compat with setup.ts / run-loop.ts)
// ---------------------------------------------------------------------------

export interface ManagerOptions {
  apiUrl: string;
  apiKey: string;
  /** @deprecated — LLM no longer used */
  llmBaseUrl?: string;
  /** @deprecated */
  llmApiKey?: string;
  model?: string;
  runner?: AgentRunner;
  api?: ApiClient;
  reposDir?: string;
  repositories?: Array<{ name: string; path: string; description?: string }>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class Manager {
  private apiUrl: string;
  private apiKey: string;
  private repositories: Array<{ name: string; path: string; description?: string }>;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Callback to broadcast reply via WebSocket */
  onReply?: (reply: string) => void;
  /** Callback when Manager activity changes (for WS broadcast) */
  onActivityChange?: (activity: string) => void;
  /** Callback for real-time data updates (sprint, task, etc.) */
  onDataUpdate?: (entity: string, id: string, changes: Record<string, unknown>) => void;

  constructor(options: ManagerOptions) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.repositories = options.repositories ?? [];
  }

  // ── Lifecycle ────────────────────────────────────────────

  /** Start heartbeat + periodic repo pulls (no LLM polling) */
  startHeartbeat(): void {
    ui.info("[manager] Started (heartbeat only, LLM disabled)");
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat().catch(() => {});
      this.pullRepos();
    }, 30_000);
    // Initial heartbeat
    this.heartbeat().catch(() => {});
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    ui.debug("manager", "Manager stopped");
  }

  // ── WebSocket entry point ────────────────────────────────

  /**
   * Handle a message received via WebSocket.
   * Returns a fixed response — LLM is no longer used.
   */
  async handleWsMessage(content: string): Promise<{ reply: string }> {
    ui.chatMessage("user", "manager", content, "ws");
    const reply = "Task dispatch is automatic. Use the dashboard to create/update tasks, and the CLI will pick them up.";
    this.onReply?.(reply);
    ui.chatMessage("manager", "user", reply, "ws");
    return { reply };
  }

  // ── Internal ─────────────────────────────────────────────

  /** Pull latest changes in Manager's repo clones */
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
        // Non-fatal
      }
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/api/v1/agents`, {
        method: "PUT",
        headers: createAuthHeaders(this.apiKey),
        body: JSON.stringify({ name: "manager", status: "active", activity: "listening" }),
      });
    } catch {
      // Non-fatal
    }
  }
}
