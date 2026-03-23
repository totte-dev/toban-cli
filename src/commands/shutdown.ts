/**
 * Graceful shutdown handler setup
 */

import type { AgentRunner } from "../agents/runner.js";
import type { WsChatServer } from "../channel/ws-server.js";
import * as ui from "../ui.js";

export interface ShutdownState {
  shuttingDown: boolean;
  activeManager: { stop: () => void } | null;
  activeWsServer: WsChatServer | null;
}

export function createShutdownState(): ShutdownState {
  return {
    shuttingDown: false,
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
    state.activeManager?.stop();
    runner.stopStallDetection();
    for (const agent of runner.status()) { ui.info(`Stopping agent: ${agent.name}`); runner.stop(agent.name); }
    setTimeout(() => { ui.shutdown(); process.exit(0); }, 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
