/**
 * AgentChannel — Local file-based communication channel for agents.
 *
 * Messages are stored in ~/.toban/channel/messages.jsonl (append-only).
 * Each message includes agent identity metadata (name, task, sprint).
 * No API communication — purely local file-based.
 *
 * The PeerTracker reads this file and distributes messages to each
 * agent's worktree as .toban-channel.md.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CHANNEL_DIR = join(homedir(), ".toban", "channel");
const MESSAGES_FILE = join(CHANNEL_DIR, "messages.jsonl");
const MAX_MESSAGES = 200;

export interface ChannelMessage {
  /** Agent/slot name (e.g. "builder-1") or "user" */
  from: string;
  /** Task ID (short prefix) */
  task_id: string | null;
  /** Task title */
  task_title: string | null;
  /** Sprint number */
  sprint: number | null;
  /** Message text */
  text: string;
  /** ISO timestamp */
  ts: string;
}

/**
 * Ensure the channel directory exists.
 */
function ensureDir(): void {
  if (!existsSync(CHANNEL_DIR)) {
    mkdirSync(CHANNEL_DIR, { recursive: true });
  }
}

/**
 * Post a message to the channel.
 */
export function postMessage(msg: Omit<ChannelMessage, "ts">): ChannelMessage {
  ensureDir();
  const fullMsg: ChannelMessage = { ...msg, ts: new Date().toISOString() };
  appendFileSync(MESSAGES_FILE, JSON.stringify(fullMsg) + "\n", "utf-8");
  // Trim if over max
  trimMessages();
  return fullMsg;
}

/**
 * Read all messages from the channel.
 */
export function readMessages(): ChannelMessage[] {
  if (!existsSync(MESSAGES_FILE)) return [];
  const content = readFileSync(MESSAGES_FILE, "utf-8").trim();
  if (!content) return [];
  const messages: ChannelMessage[] = [];
  for (const line of content.split("\n")) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Read the last N messages.
 */
export function readRecentMessages(count: number = 50): ChannelMessage[] {
  const all = readMessages();
  return all.slice(-count);
}

/**
 * Trim messages to MAX_MESSAGES (keep most recent).
 */
function trimMessages(): void {
  const messages = readMessages();
  if (messages.length <= MAX_MESSAGES) return;
  const trimmed = messages.slice(-MAX_MESSAGES);
  writeFileSync(
    MESSAGES_FILE,
    trimmed.map((m) => JSON.stringify(m)).join("\n") + "\n",
    "utf-8"
  );
}

/**
 * Clear the channel (e.g. on sprint start).
 */
export function clearChannel(): void {
  ensureDir();
  writeFileSync(MESSAGES_FILE, "", "utf-8");
}

/**
 * Format messages as markdown for .toban-channel.md.
 */
export function formatChannelMarkdown(messages: ChannelMessage[]): string {
  if (messages.length === 0) {
    return "# Agent Channel\n\nNo messages yet.\n";
  }

  const lines: string[] = [
    "# Agent Channel",
    "",
    "Recent communication between agents. Post with: `toban chat \"your message\"`",
    "",
  ];

  for (const msg of messages) {
    const time = msg.ts.slice(11, 19); // HH:MM:SS
    const tag = msg.task_title
      ? `${msg.from} | ${msg.task_title}`
      : msg.from;
    lines.push(`[${time}] [${tag}] ${msg.text}`);
  }

  lines.push("");
  return lines.join("\n");
}
