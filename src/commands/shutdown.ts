/**
 * Graceful shutdown handler setup
 */

import type { AgentRunner } from "../runner.js";
import type { ChatPoller } from "../chat-poller.js";
import type { WsChatServer } from "../ws-server.js";
import * as ui from "../ui.js";

export interface ShutdownState {
  shuttingDown: boolean;
  activeChatPoller: ChatPoller | null;
  activeManager: { stop: () => void } | null;
  activeWsServer: WsChatServer | null;
}

export function createShutdownState(): ShutdownState {
  return {
    shuttingDown: false,
    activeChatPoller: null,
    activeManager: null,
    activeWsServer: null,
  };
}

export function setupShutdownHandlers(runner: AgentRunner, state: ShutdownState): void {
  const shutdown = () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    ui.warn("Shutting down...");
    state.activeWsServer?.stop().catch(() => {});
    state.activeChatPoller?.stop();
    state.activeManager?.stop();
    for (const agent of runner.status()) { ui.info(`Stopping agent: ${agent.name}`); runner.stop(agent.name); }
    setTimeout(() => { ui.shutdown(); process.exit(0); }, 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
