/**
 * `toban chat` — Post/read messages in the agent channel.
 *
 * Usage (called by agents via Bash tool):
 *   toban chat                                      # Read recent messages
 *   toban chat "message text"                       # Post info message
 *   toban chat --type blocker "message"             # Post with type
 *   toban chat --type proposal --topic arch "msg"   # Post with type + topic
 *   toban chat --to builder-2 "message"             # Direct message
 *   toban chat --topic sprint-planning              # Read topic messages
 *
 * Reads TOBAN_AGENT_NAME, TOBAN_TASK_ID from env for metadata.
 * No API communication — purely local file-based.
 */

import {
  postMessage,
  readRecentMessages,
  readMessagesByTopic,
  formatChannelMarkdown,
  type MessageType,
} from "../agent-channel.js";

const VALID_TYPES = new Set([
  "info", "blocker", "proposal", "opinion", "decision", "request", "review", "progress",
]);

export async function handleChat(args: string[]): Promise<void> {
  // Parse flags
  let type: MessageType = "info";
  let topic: string | null = null;
  let to: string = "all";
  let replyTo: string | null = null;
  const messageWords: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--type" && i + 1 < args.length) {
      const val = args[++i];
      if (VALID_TYPES.has(val)) {
        type = val as MessageType;
      } else {
        console.error(`Invalid type: ${val}. Valid: ${[...VALID_TYPES].join(", ")}`);
        process.exitCode = 1;
        return;
      }
    } else if (arg === "--topic" && i + 1 < args.length) {
      topic = args[++i];
    } else if (arg === "--to" && i + 1 < args.length) {
      to = args[++i];
    } else if (arg === "--reply" && i + 1 < args.length) {
      replyTo = args[++i];
    } else {
      messageWords.push(arg);
    }
  }

  const messageText = messageWords.join(" ").trim();

  if (!messageText) {
    // Read mode
    const messages = topic
      ? readMessagesByTopic(topic, 30)
      : readRecentMessages(30);
    console.log(formatChannelMarkdown(messages));
    return;
  }

  // Post mode
  const agentName = process.env.TOBAN_AGENT_NAME || "unknown";
  const taskId = process.env.TOBAN_TASK_ID || null;
  const taskTitle = process.env.TOBAN_TASK_TITLE || null;
  const sprint = process.env.TOBAN_SPRINT ? parseInt(process.env.TOBAN_SPRINT, 10) : null;

  // Default topic: task-{id} if working on a task, otherwise general
  const resolvedTopic = topic ?? (taskId ? `task-${taskId.slice(0, 8)}` : "general");

  const msg = postMessage({
    from: agentName,
    type,
    topic: resolvedTopic,
    to,
    replyTo,
    content: messageText,
    task_id: taskId ? taskId.slice(0, 8) : null,
    task_title: taskTitle,
    sprint,
  });

  const typeLabel = msg.type.toUpperCase();
  const toLabel = msg.to !== "all" ? ` → @${msg.to}` : "";
  console.log(`[${typeLabel}] ${msg.from}${toLabel} (${msg.topic}): ${msg.content}`);
}
