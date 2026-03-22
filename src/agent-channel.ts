/**
 * AgentChannel — Local file-based communication channel for agents.
 *
 * Messages are stored in ~/.toban/channel/messages.jsonl (append-only).
 * Each message includes structured metadata (type, topic, addressing).
 * No API communication — purely local file-based.
 *
 * The PeerTracker reads this file and distributes messages to each
 * agent's worktree as .toban-channel.md.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const MAX_MESSAGES = 200;

function getChannelDir(): string {
  return join(homedir(), ".toban", "channel");
}

function getMessagesFile(): string {
  return join(getChannelDir(), "messages.jsonl");
}

/** Message types for structured communication */
export type MessageType =
  | "info"       // General information sharing
  | "blocker"    // Work is blocked, needs help
  | "proposal"   // Propose an idea for discussion
  | "opinion"    // Respond to a proposal
  | "decision"   // Consensus reached, action determined
  | "request"    // Ask another agent to do something
  | "review"     // Review feedback on work
  | "progress";  // Status update on current work

/** Topic prefixes for message categorization */
export type TopicPrefix =
  | "task"             // Task-level discussion (task-{id})
  | "sprint-planning"  // Sprint planning discussion
  | "sprint-review"    // Sprint review discussion
  | "retro"            // Retrospective discussion
  | "architecture"     // Architecture decisions
  | "general";         // General discussion

export interface ChannelMessage {
  /** Unique message ID */
  id: string;
  /** Agent/slot name (e.g. "builder-1") or "orchestrator" or "user" */
  from: string;
  /** Message type — determines how orchestrator handles it */
  type: MessageType;
  /** Topic for threading (e.g. "task-abc123", "sprint-planning", "architecture") */
  topic: string;
  /** Target recipient — "all" for broadcast, or specific agent name */
  to: string;
  /** Reply to a previous message ID (for threaded conversations) */
  replyTo: string | null;
  /** Message content */
  content: string;
  /** Task ID (short prefix) */
  task_id: string | null;
  /** Task title */
  task_title: string | null;
  /** Sprint number */
  sprint: number | null;
  /** ISO timestamp */
  ts: string;
}

/** Input for posting a message (id and ts are auto-generated) */
export type PostMessageInput = Omit<ChannelMessage, "id" | "ts"> & {
  id?: string;
  ts?: string;
};

/**
 * Ensure the channel directory exists.
 */
function ensureDir(): void {
  if (!existsSync(getChannelDir())) {
    mkdirSync(getChannelDir(), { recursive: true });
  }
}

/**
 * Post a message to the channel.
 */
export function postMessage(msg: PostMessageInput): ChannelMessage {
  ensureDir();
  const fullMsg: ChannelMessage = {
    id: msg.id ?? randomUUID().slice(0, 8),
    from: msg.from,
    type: msg.type ?? "info",
    topic: msg.topic ?? "general",
    to: msg.to ?? "all",
    replyTo: msg.replyTo ?? null,
    content: msg.content,
    task_id: msg.task_id,
    task_title: msg.task_title,
    sprint: msg.sprint,
    ts: msg.ts ?? new Date().toISOString(),
  };
  appendFileSync(getMessagesFile(), JSON.stringify(fullMsg) + "\n", "utf-8");
  trimMessages();
  return fullMsg;
}

/**
 * Read all messages from the channel.
 * Handles both old format (text field) and new format (content field).
 */
export function readMessages(): ChannelMessage[] {
  if (!existsSync(getMessagesFile())) return [];
  const raw = readFileSync(getMessagesFile(), "utf-8").trim();
  if (!raw) return [];
  const messages: ChannelMessage[] = [];
  for (const line of raw.split("\n")) {
    try {
      const parsed = JSON.parse(line);
      // Migrate old format: text → content, add defaults for new fields
      messages.push({
        id: parsed.id ?? "legacy",
        from: parsed.from ?? "unknown",
        type: parsed.type ?? "info",
        topic: parsed.topic ?? (parsed.task_id ? `task-${parsed.task_id}` : "general"),
        to: parsed.to ?? "all",
        replyTo: parsed.replyTo ?? null,
        content: parsed.content ?? parsed.text ?? "",
        task_id: parsed.task_id ?? null,
        task_title: parsed.task_title ?? null,
        sprint: parsed.sprint ?? null,
        ts: parsed.ts ?? new Date().toISOString(),
      });
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
 * Read messages since a given timestamp (exclusive).
 * Returns messages newer than the provided ISO timestamp.
 */
export function readMessagesSince(sinceTs: string): ChannelMessage[] {
  const all = readMessages();
  return all.filter((m) => m.ts > sinceTs);
}

/**
 * Read messages filtered by topic.
 */
export function readMessagesByTopic(topic: string, count: number = 50): ChannelMessage[] {
  const all = readMessages();
  return all.filter((m) => m.topic === topic).slice(-count);
}

/**
 * Read messages filtered by type.
 */
export function readMessagesByType(type: MessageType, count: number = 50): ChannelMessage[] {
  const all = readMessages();
  return all.filter((m) => m.type === type).slice(-count);
}

/**
 * Read messages addressed to a specific agent (direct + broadcast).
 */
export function readMessagesFor(agentName: string, sinceTs?: string): ChannelMessage[] {
  let all = readMessages();
  if (sinceTs) {
    all = all.filter((m) => m.ts > sinceTs);
  }
  return all.filter((m) => m.to === "all" || m.to === agentName);
}

/**
 * Trim messages to MAX_MESSAGES (keep most recent).
 */
function trimMessages(): void {
  const messages = readMessages();
  if (messages.length <= MAX_MESSAGES) return;
  const trimmed = messages.slice(-MAX_MESSAGES);
  writeFileSync(
    getMessagesFile(),
    trimmed.map((m) => JSON.stringify(m)).join("\n") + "\n",
    "utf-8"
  );
}

/**
 * Clear the channel (e.g. on sprint start).
 */
export function clearChannel(): void {
  ensureDir();
  writeFileSync(getMessagesFile(), "", "utf-8");
}

/** Type label for display */
const TYPE_LABELS: Record<MessageType, string> = {
  info: "INFO",
  blocker: "BLOCKER",
  proposal: "PROPOSAL",
  opinion: "OPINION",
  decision: "DECISION",
  request: "REQUEST",
  review: "REVIEW",
  progress: "PROGRESS",
};

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
    "Team communication channel. Post with: `toban chat --type <type> --topic <topic> \"message\"`",
    "Types: info, blocker, proposal, opinion, decision, request, review, progress",
    "",
  ];

  // Group by topic for readability
  const byTopic = new Map<string, ChannelMessage[]>();
  for (const msg of messages) {
    const topic = msg.topic || "general";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic)!.push(msg);
  }

  for (const [topic, msgs] of byTopic) {
    lines.push(`## ${topic}`);
    lines.push("");
    for (const msg of msgs) {
      const time = msg.ts.slice(11, 19); // HH:MM:SS
      const typeLabel = TYPE_LABELS[msg.type] || msg.type.toUpperCase();
      const toLabel = msg.to !== "all" ? ` → @${msg.to}` : "";
      const replyLabel = msg.replyTo ? ` (re:${msg.replyTo})` : "";
      lines.push(`[${time}] [${typeLabel}] ${msg.from}${toLabel}${replyLabel}: ${msg.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
