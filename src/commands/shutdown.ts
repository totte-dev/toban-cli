/**
 * Graceful shutdown handler setup
 */

import type { AgentRunner } from "../runner.js";
import type { ChatPoller } from "../chat-poller.js";
import * as ui from "../ui.js";

export interface ShutdownState {
  shuttingDown: boolean;
  activeChatPoller: ChatPoller | null;
  activeManager: ReturnType<typeof Object> | null;
  activeWsServer: { stop: () => Promise<void> } | null;
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
    if (state.activeManager && "stop" in state.activeManager) (state.activeManager as { stop: () => void }).stop();
    for (const agent of runner.status()) { ui.info(`Stopping agent: ${agent.name}`); runner.stop(agent.name); }
    setTimeout(() => { ui.shutdown(); process.exit(0); }, 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
