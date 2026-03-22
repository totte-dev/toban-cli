/**
 * ChannelMonitor — Watches the agent channel for actionable messages.
 *
 * The orchestrator (run-loop) calls processNewMessages() each poll cycle.
 * Based on message type, it triggers appropriate actions:
 *   - blocker: log + broadcast to dashboard
 *   - request: queue task for target agent
 *   - review: create follow-up task for fixes
 *   - decision: log consensus reached
 *
 * This is the "translator" layer — agents post structured messages,
 * the monitor interprets them and triggers orchestrator-level actions.
 */

import { readMessagesSince, type ChannelMessage, type MessageType } from "./agent-channel.js";
import * as ui from "./ui.js";

/** Action the orchestrator should take based on a channel message */
export interface ChannelAction {
  /** Action type */
  action: "notify" | "create_task" | "update_task" | "log_only";
  /** Source message */
  message: ChannelMessage;
  /** Human-readable description */
  description: string;
  /** Additional data for the orchestrator */
  data?: Record<string, unknown>;
}

export class ChannelMonitor {
  private lastCheckedTs: string;
  private processedIds = new Set<string>();

  constructor(sinceTs?: string) {
    // Default: start monitoring from now. Pass a past timestamp to catch existing messages.
    this.lastCheckedTs = sinceTs ?? new Date().toISOString();
  }

  /**
   * Check for new messages since last poll and return actions.
   * Call this each iteration of the main loop.
   */
  processNewMessages(): ChannelAction[] {
    const newMessages = readMessagesSince(this.lastCheckedTs);
    if (newMessages.length === 0) return [];

    const actions: ChannelAction[] = [];

    for (const msg of newMessages) {
      // Skip already processed (dedup by id)
      if (this.processedIds.has(msg.id)) continue;
      this.processedIds.add(msg.id);

      const action = this.evaluateMessage(msg);
      if (action) {
        actions.push(action);
      }
    }

    // Update cursor to latest message timestamp
    if (newMessages.length > 0) {
      this.lastCheckedTs = newMessages[newMessages.length - 1].ts;
    }

    // Prevent memory leak: trim processed IDs (keep last 500)
    if (this.processedIds.size > 500) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(-300));
    }

    return actions;
  }

  /**
   * Evaluate a single message and determine what action the orchestrator should take.
   */
  private evaluateMessage(msg: ChannelMessage): ChannelAction | null {
    // Skip orchestrator's own messages
    if (msg.from === "orchestrator") return null;

    switch (msg.type) {
      case "blocker":
        ui.warn(`[channel] BLOCKER from ${msg.from}: ${msg.content}`);
        return {
          action: "notify",
          message: msg,
          description: `${msg.from} reports blocker: ${msg.content}`,
          data: { severity: "high" },
        };

      case "request":
        ui.info(`[channel] REQUEST from ${msg.from} → ${msg.to}: ${msg.content}`);
        return {
          action: "create_task",
          message: msg,
          description: `${msg.from} requests ${msg.to}: ${msg.content}`,
          data: {
            target: msg.to,
            requestedBy: msg.from,
          },
        };

      case "review":
        ui.info(`[channel] REVIEW from ${msg.from}: ${msg.content}`);
        return {
          action: "create_task",
          message: msg,
          description: `Review feedback from ${msg.from}: ${msg.content}`,
          data: {
            reviewedBy: msg.from,
            targetTask: msg.topic,
          },
        };

      case "decision":
        ui.step(`[channel] DECISION from ${msg.from} (${msg.topic}): ${msg.content}`);
        return {
          action: "log_only",
          message: msg,
          description: `Decision reached on ${msg.topic}: ${msg.content}`,
        };

      case "proposal":
        ui.info(`[channel] PROPOSAL from ${msg.from} (${msg.topic}): ${msg.content}`);
        return {
          action: "log_only",
          message: msg,
          description: `Proposal from ${msg.from}: ${msg.content}`,
        };

      case "progress":
        // Progress updates are informational only — don't log to keep console clean
        return null;

      case "info":
      case "opinion":
      default:
        return null;
    }
  }

  /**
   * Get the last checked timestamp (for diagnostics).
   */
  getLastCheckedTs(): string {
    return this.lastCheckedTs;
  }
}
