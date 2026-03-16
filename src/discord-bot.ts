/**
 * Discord Bot — Bidirectional agent communication bridge.
 *
 * Monitors a Discord channel for messages mentioning @agent-name,
 * forwards them to the Toban API, and posts agent replies back.
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN   — Discord bot token (required)
 *   DISCORD_CHANNEL_ID  — Channel ID to monitor (required)
 *   TOBAN_API_URL       — Toban API base URL (default: http://localhost:8787)
 *   TOBAN_API_KEY       — Toban API bearer token (required)
 *   POLL_INTERVAL_MS    — How often to poll for agent replies (default: 3000)
 */

import { Client, GatewayIntentBits, type Message as DiscordMessage, type TextChannel } from "discord.js";
import { createApiClient, type ApiClient, type Message } from "./api-client.js";

/** Pattern to match @agent-name at the start of a message */
const AGENT_MENTION_RE = /^@([\w-]+)\s+([\s\S]+)/;

export interface DiscordBotConfig {
  /** Discord bot token */
  botToken: string;
  /** Discord channel ID to monitor */
  channelId: string;
  /** Toban API client */
  api: ApiClient;
  /** How often to poll for agent replies (ms) */
  pollIntervalMs?: number;
  /** Name used as the "from" field when sending messages to agents */
  fromName?: string;
}

export class DiscordBot {
  private client: Client;
  private config: DiscordBotConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Track the last seen message ID per agent to avoid duplicate posts */
  private lastSeenMessageIds = new Map<string, string>();
  /** Track Discord message IDs we sent, to avoid re-processing our own messages */
  private sentMessageIds = new Set<string>();
  /** Agents we are actively polling replies for */
  private activeAgentChannels = new Set<string>();

  constructor(config: DiscordBotConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  /** Start the bot: login to Discord and begin polling for agent replies */
  async start(): Promise<void> {
    this.client.on("ready", () => {
      console.log(`[discord-bot] Logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", (msg) => this.handleDiscordMessage(msg));

    await this.client.login(this.config.botToken);

    // Start polling for agent replies
    const interval = this.config.pollIntervalMs ?? 3000;
    this.pollTimer = setInterval(() => this.pollAgentReplies(), interval);
    console.log(`[discord-bot] Polling agent replies every ${interval}ms`);
  }

  /** Stop the bot gracefully */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.client.destroy();
    console.log("[discord-bot] Stopped");
  }

  /** Handle an incoming Discord message */
  private async handleDiscordMessage(msg: DiscordMessage): Promise<void> {
    // Ignore our own messages
    if (msg.author.id === this.client.user?.id) return;
    if (this.sentMessageIds.has(msg.id)) return;

    // Only listen to the configured channel
    if (msg.channelId !== this.config.channelId) return;

    const match = msg.content.match(AGENT_MENTION_RE);
    if (!match) return;

    const agentName = match[1];
    const content = match[2].trim();
    const fromName = this.config.fromName ?? "discord-user";

    console.log(`[discord-bot] ${fromName} → @${agentName}: ${content.slice(0, 80)}...`);

    try {
      await this.config.api.sendMessage(fromName, agentName, content);
      // Track this agent channel so we poll for replies
      this.activeAgentChannels.add(agentName);
      // React to confirm the message was forwarded
      await msg.react("📨").catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[discord-bot] Failed to forward message: ${errMsg}`);
      await msg.react("❌").catch(() => {});
    }
  }

  /** Poll agent reply channels and post new messages to Discord */
  private async pollAgentReplies(): Promise<void> {
    if (this.activeAgentChannels.size === 0) return;

    const channel = await this.getChannel();
    if (!channel) return;

    for (const agentName of this.activeAgentChannels) {
      try {
        const messages = await this.config.api.fetchMessages(agentName);
        if (!messages.length) continue;

        // Find messages FROM the agent (replies)
        const replies = messages.filter(
          (m) => m.from === agentName && m.to !== agentName
        );
        if (!replies.length) continue;

        // Get last seen ID for this agent
        const lastSeenId = this.lastSeenMessageIds.get(agentName);

        // Find new replies (after lastSeenId)
        let newReplies: Message[];
        if (lastSeenId) {
          const lastIdx = replies.findIndex((m) => m.id === lastSeenId);
          newReplies = lastIdx >= 0 ? replies.slice(lastIdx + 1) : [];
        } else {
          // First poll — only show the most recent reply to avoid flooding
          newReplies = replies.slice(-1);
        }

        for (const reply of newReplies) {
          const text = `**@${agentName}**: ${reply.content}`;
          // Discord has a 2000 char limit
          const chunks = splitMessage(text, 2000);
          for (const chunk of chunks) {
            const sent = await channel.send(chunk);
            this.sentMessageIds.add(sent.id);
          }
          this.lastSeenMessageIds.set(agentName, reply.id);
        }

        // Keep sentMessageIds from growing unbounded
        if (this.sentMessageIds.size > 500) {
          const arr = [...this.sentMessageIds];
          this.sentMessageIds = new Set(arr.slice(-200));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[discord-bot] Error polling ${agentName}: ${errMsg}`);
      }
    }
  }

  private async getChannel(): Promise<TextChannel | null> {
    try {
      const ch = await this.client.channels.fetch(this.config.channelId);
      if (ch?.isTextBased()) return ch as TextChannel;
      return null;
    } catch {
      return null;
    }
  }
}

/** Split a message into chunks of maxLen characters, breaking at newlines when possible */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline
    let breakIdx = remaining.lastIndexOf("\n", maxLen);
    if (breakIdx <= 0) breakIdx = maxLen;
    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).replace(/^\n/, "");
  }
  return chunks;
}

/** Create and start a Discord bot from environment variables */
export async function startFromEnv(): Promise<DiscordBot> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const apiUrl = process.env.TOBAN_API_URL ?? "http://localhost:8787";
  const apiKey = process.env.TOBAN_API_KEY;
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS) || 3000;

  if (!botToken) throw new Error("DISCORD_BOT_TOKEN is required");
  if (!channelId) throw new Error("DISCORD_CHANNEL_ID is required");
  if (!apiKey) throw new Error("TOBAN_API_KEY is required");

  const api = createApiClient(apiUrl, apiKey);
  const bot = new DiscordBot({ botToken, channelId, api, pollIntervalMs });
  await bot.start();
  return bot;
}
