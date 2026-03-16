#!/usr/bin/env node
/**
 * Discord Bot CLI entry point.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=yyy TOBAN_API_KEY=zzz node dist/discord-bot-cli.js
 *
 * Or via npm:
 *   npm run discord-bot
 */

import { startFromEnv } from "./discord-bot.js";

async function main() {
  console.log("[discord-bot] Starting...");

  const bot = await startFromEnv();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[discord-bot] Shutting down...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[discord-bot] Fatal: ${err.message}`);
  process.exit(1);
});
