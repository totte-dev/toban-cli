/**
 * `toban chat` — Post/read messages in the agent channel.
 *
 * Usage (called by agents via Bash tool):
 *   toban chat                     # Read recent messages
 *   toban chat "message text"      # Post a message
 *   toban chat "@builder-2 msg"    # Post with mention
 *
 * Reads TOBAN_AGENT_NAME, TOBAN_TASK_ID from env for metadata.
 * No API communication — purely local file-based.
 */

import { postMessage, readRecentMessages, formatChannelMarkdown } from "../agent-channel.js";

export async function handleChat(args: string[]): Promise<void> {
  // Collect message from args (everything after "chat")
  const messageText = args.join(" ").trim();

  if (!messageText) {
    // Read mode: show recent messages
    const messages = readRecentMessages(30);
    console.log(formatChannelMarkdown(messages));
    return;
  }

  // Post mode: send a message
  const agentName = process.env.TOBAN_AGENT_NAME || "unknown";
  const taskId = process.env.TOBAN_TASK_ID || null;
  const taskTitle = process.env.TOBAN_TASK_TITLE || null;
  const sprint = process.env.TOBAN_SPRINT ? parseInt(process.env.TOBAN_SPRINT, 10) : null;

  const msg = postMessage({
    from: agentName,
    task_id: taskId ? taskId.slice(0, 8) : null,
    task_title: taskTitle,
    sprint,
    text: messageText,
  });

  const tag = msg.task_title ? `${msg.from} | ${msg.task_title}` : msg.from;
  console.log(`Posted: [${tag}] ${msg.text}`);
}
