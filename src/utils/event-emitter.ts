/**
 * Event emitter for recording TobanEvents.
 *
 * Events are buffered in memory and persisted to a local JSONL file.
 * No API calls are made until flush() is explicitly called.
 *
 * Flush strategy (caller's responsibility):
 * - Sprint start: flush startup events (sprint.started)
 * - CLI shutdown: flush remaining events
 * - Sprint snapshot (API-side Pull): API reads events table directly
 *
 * This keeps API calls to ~2 per Sprint (start + shutdown).
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ApiClient, EventInput } from "../services/api-client.js";

export interface EventEmitter {
  agentSpawned(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  agentCompleted(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  agentFailed(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  taskStatusChanged(taskId: string, previousStatus: string, newStatus: string, data?: Record<string, unknown>): void;
  buildEvent(phase: "started" | "passed" | "failed", data?: Record<string, unknown>): void;
  reviewCompleted(taskId: string, agentName: string, data?: Record<string, unknown>): void;
  sprintEvent(eventType: "sprint.started" | "sprint.phase_changed" | "sprint.completed" | "sprint.timeout", data?: Record<string, unknown>): void;
  guardrailEvent(eventType: "guardrail.violation" | "guardrail.blocked", data?: Record<string, unknown>): void;
  commitCreated(agentName: string, taskId: string, data: { hash: string; message: string; files_changed: number }): void;
  testResult(agentName: string, taskId: string, data: { passed: boolean; command: string; output?: string }): void;
  infraError(agentName: string, taskId: string, data: { category: string; summary: string }): void;
  emit(event: EventInput): void;
  /** Send all buffered events to API. Call on sprint start and CLI shutdown. */
  flush(): Promise<void>;
  /** Number of events currently buffered */
  readonly pending: number;
}

function spanId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function getBufferPath(): string {
  const dir = join(homedir(), ".toban", "events");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "buffer.jsonl");
}

export function createEventEmitter(
  api: ApiClient,
  sprint?: number,
  traceId?: string,
): EventEmitter {
  const resolvedTraceId = traceId ?? (sprint != null ? `sprint-${sprint}` : undefined);
  const bufferPath = getBufferPath();
  let memoryBuffer: EventInput[] = [];

  function addEvent(event: EventInput): void {
    const full: EventInput = {
      ...event,
      trace_id: event.trace_id ?? resolvedTraceId,
      sprint: event.sprint ?? sprint,
    };
    memoryBuffer.push(full);
    // Also persist to disk so events survive a crash
    try {
      appendFileSync(bufferPath, JSON.stringify(full) + "\n");
    } catch { /* best-effort */ }
  }

  return {
    get pending() { return memoryBuffer.length; },

    agentSpawned(agentName, taskId, data = {}) {
      addEvent({ type: "agent.spawned", span_id: spanId(), parent_span_id: taskId, task_id: taskId, agent_name: agentName, data });
    },
    agentCompleted(agentName, taskId, data = {}) {
      addEvent({ type: "agent.completed", span_id: spanId(), parent_span_id: taskId, task_id: taskId, agent_name: agentName, data });
    },
    agentFailed(agentName, taskId, data = {}) {
      addEvent({ type: "agent.failed", span_id: spanId(), parent_span_id: taskId, task_id: taskId, agent_name: agentName, data });
    },
    taskStatusChanged(taskId, previousStatus, newStatus, data = {}) {
      addEvent({ type: "task.status_changed", span_id: spanId(), task_id: taskId, data: { previous_status: previousStatus, new_status: newStatus, ...data } });
    },
    buildEvent(phase, data = {}) {
      addEvent({ type: `build.${phase}`, span_id: spanId(), data });
    },
    reviewCompleted(taskId, agentName, data = {}) {
      addEvent({ type: "review.completed", span_id: spanId(), task_id: taskId, agent_name: agentName, data });
    },
    sprintEvent(eventType, data = {}) {
      addEvent({ type: eventType, span_id: spanId(), data });
    },
    guardrailEvent(eventType, data = {}) {
      addEvent({ type: eventType, span_id: spanId(), data });
    },
    commitCreated(agentName, taskId, data) {
      addEvent({ type: "commit.created", span_id: spanId(), task_id: taskId, agent_name: agentName, data });
    },
    testResult(agentName, taskId, data) {
      addEvent({ type: "test.result", span_id: spanId(), task_id: taskId, agent_name: agentName, data });
    },
    infraError(agentName, taskId, data) {
      addEvent({ type: "infra.error", span_id: spanId(), task_id: taskId, agent_name: agentName, data });
    },
    emit(event) { addEvent(event); },

    async flush() {
      // Merge memory buffer with any crash-recovered events from disk
      let diskEvents: EventInput[] = [];
      if (existsSync(bufferPath)) {
        try {
          const content = readFileSync(bufferPath, "utf-8").trim();
          if (content) {
            diskEvents = content.split("\n").filter(Boolean).map((line) => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);
          }
        } catch { /* best-effort */ }
      }

      // Disk file is the source of truth (memory buffer is a subset)
      const events = diskEvents.length > 0 ? diskEvents : memoryBuffer;
      if (events.length === 0) return;

      // Send in batches of 50
      for (let i = 0; i < events.length; i += 50) {
        const batch = events.slice(i, i + 50);
        try {
          await api.recordEvents(batch);
        } catch {
          // Keep unsent events for next flush
          const remaining = events.slice(i);
          try { writeFileSync(bufferPath, remaining.map((e) => JSON.stringify(e)).join("\n") + "\n"); } catch { /* */ }
          memoryBuffer = remaining;
          return;
        }
      }

      // All sent — clear both buffers
      memoryBuffer = [];
      try { writeFileSync(bufferPath, ""); } catch { /* best-effort */ }
    },
  };
}
