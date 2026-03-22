/**
 * Sprint Controller — phase transitions, auto-mode, timebox, channel actions.
 * Extracted from run-loop.ts to reduce its responsibilities.
 */

import { createAuthHeaders } from "../api-client.js";
import { WS_MSG } from "../ws-types.js";
import { handlePropose } from "./propose.js";
import * as ui from "../ui.js";
import { execSync } from "node:child_process";
import type { ChannelMonitor } from "../channel-monitor.js";
import type { WsChatServer } from "../ws-server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoModeConfig {
  enabled: boolean;
  maxSprints: number;
  maxHours: number;
}

export interface AutoModeState {
  startedAt: number | null;
  sprintCount: number;
}

export interface SprintControllerDeps {
  apiUrl: string;
  apiKey: string;
  wsServer?: WsChatServer | null;
  channelMonitor: ChannelMonitor;
  autoMode: AutoModeConfig;
  autoTag?: boolean;
}

/** Result of a single tick of the sprint controller. */
export type SprintTickResult =
  | { action: "continue" }     // proceed to task dispatch
  | { action: "wait" }         // skip this tick, sleep and re-poll
  | { action: "stop" };        // exit the main loop

// ---------------------------------------------------------------------------
// Sprint Controller
// ---------------------------------------------------------------------------

export class SprintController {
  private deps: SprintControllerDeps;
  private autoState: AutoModeState;

  constructor(deps: SprintControllerDeps) {
    this.deps = deps;
    this.autoState = { startedAt: null, sprintCount: 0 };

    if (deps.autoMode.enabled) {
      this.autoState.startedAt = Date.now();
      ui.info(`[auto-mode] Enabled. Max sprints: ${deps.autoMode.maxSprints}, Max hours: ${deps.autoMode.maxHours}`);
      try {
        const tagName = `auto-start-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
        execSync(`git tag "${tagName}"`, { stdio: "pipe" });
        ui.info(`[auto-mode] Checkpoint tag: ${tagName}`);
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Process one tick of sprint lifecycle.
   * Call this at the top of each main loop iteration, after fetching sprintData.
   * Returns whether the main loop should continue to task dispatch, wait, or stop.
   */
  async tick(sprint: Record<string, unknown> | undefined): Promise<SprintTickResult> {
    // Auto-mode: check stop conditions
    if (this.deps.autoMode.enabled && this.autoState.startedAt) {
      const hoursElapsed = (Date.now() - this.autoState.startedAt) / (1000 * 60 * 60);
      if (hoursElapsed >= this.deps.autoMode.maxHours) {
        ui.info(`[auto-mode] Time limit reached (${this.deps.autoMode.maxHours}h). Stopping.`);
        return { action: "stop" };
      }
      if (this.autoState.sprintCount >= this.deps.autoMode.maxSprints) {
        ui.info(`[auto-mode] Sprint limit reached (${this.deps.autoMode.maxSprints}). Stopping.`);
        return { action: "stop" };
      }
    }

    // No sprint yet — wait
    if (!sprint) {
      ui.info("No active sprint — waiting for project setup to complete...");
      return { action: "wait" };
    }

    // Auto-tag on sprint completion
    if (sprint.status === "completed" && this.deps.autoTag) {
      const tagName = `sprint-${sprint.number}`;
      try {
        const existing = execSync(`git tag -l "${tagName}"`, { stdio: "pipe" }).toString().trim();
        if (!existing) {
          execSync(`git tag "${tagName}"`, { stdio: "pipe" });
          try { execSync(`git push origin "${tagName}"`, { stdio: "pipe" }); } catch { /* push may fail */ }
          ui.step(`[sprint] Tagged ${tagName}`);
        }
      } catch { /* non-fatal */ }
    }

    // Strategist proposals on retrospective entry
    if (sprint.status === "retrospective") {
      await this.handleRetrospective(sprint);
    }

    // Timebox: auto-transition to review if deadline passed
    if (sprint.status === "active" && sprint.deadline) {
      const deadline = new Date(sprint.deadline as string).getTime();
      if (Date.now() > deadline) {
        ui.warn(`[timebox] Sprint deadline passed — transitioning to review`);
        try {
          await fetch(`${this.deps.apiUrl}/api/v1/sprints/${sprint.number}`, {
            method: "PATCH",
            headers: createAuthHeaders(this.deps.apiKey),
            body: JSON.stringify({ status: "review" }),
          });
          this.deps.wsServer?.broadcast({
            type: "data_update" as const, entity: "sprint",
            task_id: String(sprint.number), changes: { status: "review" },
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
        return { action: "wait" };
      }
    }

    // Auto-mode: handle phase transitions
    if (this.deps.autoMode.enabled && sprint) {
      const result = await this.handleAutoModeTransition(sprint);
      if (result) return result;
    }

    // Process channel messages
    this.processChannelMessages(sprint);

    // Only pick up tasks during active phase
    if (sprint.status !== "active") {
      return { action: "wait" };
    }

    return { action: "continue" };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleRetrospective(sprint: Record<string, unknown>): Promise<void> {
    try {
      const headers = createAuthHeaders(this.deps.apiKey);
      const plansRes = await fetch(`${this.deps.apiUrl}/api/v1/sprints/${sprint.number}/plan`, { headers });
      if (plansRes.ok) {
        const plan = (await plansRes.json()) as { status: string; id: string };
        if (plan.status === "generating") {
          ui.info("[strategist] Sprint entered retrospective — generating improvement proposals...");
          try {
            await fetch(`${this.deps.apiUrl}/api/v1/agents/strategist`, {
              method: "PATCH", headers,
              body: JSON.stringify({ status: "working", activity: "Generating proposals..." }),
            });
          } catch { /* non-fatal */ }

          let success = false;
          try {
            await handlePropose(this.deps.apiUrl, this.deps.apiKey);
            success = true;
          } catch (err) {
            ui.warn(`[strategist] Proposal generation failed: ${err}`);
          }

          const planSummary = success
            ? "Proposals generated — review in Backlog > Proposals"
            : "Proposal generation failed";
          try {
            await fetch(`${this.deps.apiUrl}/api/v1/sprints/${sprint.number}/plan`, {
              method: "POST", headers,
              body: JSON.stringify({ summary: planSummary, tasks: [{ id: "done", title: planSummary, reason: "" }], total_sp: 0 }),
            });
          } catch {
            ui.warn("[strategist] Could not update plan status — will retry next poll");
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  private async handleAutoModeTransition(sprint: Record<string, unknown>): Promise<SprintTickResult | null> {
    const headers = createAuthHeaders(this.deps.apiKey);

    // Review → auto-accept → Retro
    if (sprint.status === "review") {
      ui.info("[auto-mode] Review phase — auto-accepting Sprint");
      try {
        await fetch(`${this.deps.apiUrl}/api/v1/sprints/${sprint.number}`, {
          method: "PATCH", headers,
          body: JSON.stringify({ status: "retrospective" }),
        });
      } catch { /* non-fatal */ }
      return { action: "wait" };
    }

    // Completed → create next sprint
    if (sprint.status === "completed") {
      this.autoState.sprintCount++;
      const nextNumber = (sprint.number as number) + 1;

      // Check backlog
      try {
        const backlogRes = await fetch(`${this.deps.apiUrl}/api/v1/tasks?sprint=-1&limit=1`, { headers });
        if (backlogRes.ok) {
          const backlog = (await backlogRes.json()) as unknown[];
          if (Array.isArray(backlog) && backlog.length === 0) {
            ui.info("[auto-mode] Backlog empty. Stopping.");
            return { action: "stop" };
          }
        }
      } catch { /* non-fatal */ }

      ui.info(`[auto-mode] Starting Sprint #${nextNumber} (auto ${this.autoState.sprintCount}/${this.deps.autoMode.maxSprints})`);
      try {
        await fetch(`${this.deps.apiUrl}/api/v1/sprints`, {
          method: "POST", headers,
          body: JSON.stringify({ number: nextNumber, status: "active", goal: `Auto Sprint #${nextNumber}` }),
        });
        try {
          execSync(`git tag "sprint-${nextNumber}-auto"`, { stdio: "pipe" });
        } catch { /* tag may already exist */ }
      } catch (err) {
        ui.warn(`[auto-mode] Failed to create Sprint #${nextNumber}: ${err}`);
      }
      return { action: "wait" };
    }

    return null;
  }

  private processChannelMessages(sprint: Record<string, unknown>): void {
    const channelActions = this.deps.channelMonitor.processNewMessages();

    for (const ca of channelActions) {
      if (ca.action === "notify") {
        this.deps.wsServer?.broadcast({
          type: WS_MSG.CHANNEL_MESSAGE,
          messages: [{ from: ca.message.from, type: ca.message.type, topic: ca.message.topic, text: ca.message.content, ts: ca.message.ts }],
          timestamp: new Date().toISOString(),
        });
      }
      if (ca.action === "create_task" && ca.data) {
        const sprintNum = sprint.number as number | undefined;
        if (sprintNum != null) {
          const owner = ca.data.target as string | undefined;
          const title = `[channel] ${ca.message.type}: ${ca.message.content.slice(0, 80)}`;
          fetch(`${this.deps.apiUrl}/api/v1/tasks`, {
            method: "POST",
            headers: createAuthHeaders(this.deps.apiKey),
            body: JSON.stringify({
              title,
              description: `Auto-created from channel message.\n\nFrom: ${ca.message.from}\nType: ${ca.message.type}\nTopic: ${ca.message.topic}\n\n${ca.message.content}`,
              priority: ca.message.type === "review" ? "p1" : "p2",
              owner: owner && owner !== "all" ? owner : "builder",
              type: "chore",
              sprint: sprintNum,
            }),
          }).then((res) => {
            if (!res.ok) throw new Error(`API ${res.status}`);
            ui.step(`[channel] Created task from ${ca.message.type}: "${title.slice(0, 60)}..."`);
          }).catch((err) => {
            ui.warn(`[channel] Failed to create task: ${err}`);
          });
        }
      }
    }
  }
}
