/**
 * MessagePoller - Polls for messages addressed to a running agent during task execution.
 *
 * Fetches messages from the Toban API on a fixed interval and writes new messages
 * to a file in the agent's working directory so the spawned agent process can
 * discover and read them.
 */

import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ApiClient, Message } from "./api-client.js";
import * as ui from "./ui.js";

const POLL_INTERVAL_MS = 10_000;
const MESSAGES_FILE = ".toban-messages.md";
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const TRUNCATE_TO = 25 * 1024; // Keep last 25KB

export interface MessagePollerOptions {
  api: ApiClient;
  /** Channel/agent name to poll messages for */
  channel: string;
  /** Working directory where the messages file will be written */
  workingDir: string;
}

export class MessagePoller {
  private api: ApiClient;
  private channel: string;
  private workingDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp: string | null = null;
  private deliveredIds = new Set<string>();

  constructor(options: MessagePollerOptions) {
    this.api = options.api;
    this.channel = options.channel;
    this.workingDir = options.workingDir;
  }

  /**
   * Start polling for messages.
   */
  start(): void {
    ui.info(`[msg] Polling messages for "${this.channel}" every ${POLL_INTERVAL_MS / 1000}s`);
    // Run immediately, then on interval
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  /**
   * Stop polling and clean up.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const messages = await this.api.fetchMessages(this.channel);
      if (!messages || messages.length === 0) return;

      // Sort by timestamp ascending
      const sorted = [...messages].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      // Find messages we haven't delivered yet
      const newMessages = sorted.filter((m) => !this.deliveredIds.has(m.id));

      if (newMessages.length === 0) return;

      // On first poll, mark all existing messages as seen without writing them
      // to avoid dumping old history into the file
      if (this.lastSeenTimestamp === null) {
        for (const m of sorted) {
          this.deliveredIds.add(m.id);
        }
        this.lastSeenTimestamp = sorted[sorted.length - 1].created_at;
        return;
      }

      // Write new messages to the file and log them
      for (const msg of newMessages) {
        this.deliveredIds.add(msg.id);
        this.appendToFile(msg);
        ui.info(`[msg] New message for ${this.channel} from ${msg.from}: "${msg.content.slice(0, 80)}${msg.content.length > 80 ? "..." : ""}"`);
      }

      this.lastSeenTimestamp = newMessages[newMessages.length - 1].created_at;
    } catch {
      // Non-fatal: silently skip this poll cycle
    }
  }

  private appendToFile(msg: Message): void {
    const filePath = join(this.workingDir, MESSAGES_FILE);
    const timestamp = msg.created_at;
    const entry = `### From: ${msg.from} (${timestamp})\n${msg.content}\n\n`;

    let existing = "";
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, "utf-8");

      // Truncate if file exceeds MAX_FILE_SIZE: keep only the last TRUNCATE_TO bytes
      if (existing.length > MAX_FILE_SIZE) {
        const tail = existing.slice(-TRUNCATE_TO);
        // Find the first complete message boundary (### From:) to avoid partial entries
        const boundaryIndex = tail.indexOf("\n### From:");
        existing =
          "## Messages\n\n(earlier messages truncated)\n\n" +
          (boundaryIndex >= 0 ? tail.slice(boundaryIndex + 1) : tail);
      }
    } else {
      existing = "## Messages\n\n";
    }

    writeFileSync(filePath, existing + entry, "utf-8");
  }
}
