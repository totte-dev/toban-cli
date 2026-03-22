/**
 * Event emitter for recording TobanEvents to the API.
 *
 * Provides a simple interface for CLI components to emit events.
 * Events are sent best-effort (non-blocking) and batched when possible.
 *
 * Usage:
 *   const emitter = createEventEmitter(apiClient, sprintNumber);
 *   emitter.agentSpawned("builder", taskId, { role: "builder", model: "claude-opus" });
 *   emitter.taskStatusChanged(taskId, "todo", "in_progress");
 *   await emitter.flush(); // Ensure all buffered events are sent
 */

import type { ApiClient, EventInput } from "../api-client.js";

export interface EventEmitter {
  /** Record an agent spawn event */
  agentSpawned(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  /** Record an agent completion event */
  agentCompleted(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  /** Record an agent failure event */
  agentFailed(agentName: string, taskId: string, data?: Record<string, unknown>): void;
  /** Record a task status change */
  taskStatusChanged(taskId: string, previousStatus: string, newStatus: string, data?: Record<string, unknown>): void;
  /** Record a build event (started/passed/failed) */
  buildEvent(phase: "started" | "passed" | "failed", data?: Record<string, unknown>): void;
  /** Record a review event */
  reviewCompleted(taskId: string, agentName: string, data?: Record<string, unknown>): void;
  /** Record a sprint lifecycle event */
  sprintEvent(eventType: "sprint.started" | "sprint.phase_changed" | "sprint.completed" | "sprint.timeout", data?: Record<string, unknown>): void;
  /** Record a guardrail event */
  guardrailEvent(eventType: "guardrail.violation" | "guardrail.blocked", data?: Record<string, unknown>): void;
  /** Record a generic event */
  emit(event: EventInput): void;
  /** Flush all buffered events */
  flush(): Promise<void>;
}

/** Generate a span ID */
function spanId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function createEventEmitter(
  api: ApiClient,
  sprint?: number,
  traceId?: string,
): EventEmitter {
  const buffer: EventInput[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const resolvedTraceId = traceId ?? (sprint != null ? `sprint-${sprint}` : undefined);

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void doFlush();
    }, 1000); // Batch events within 1 second
  }

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, 50);
    await api.recordEvents(batch);
    // If there are remaining events, schedule another flush
    if (buffer.length > 0) scheduleFlush();
  }

  function addEvent(event: EventInput): void {
    buffer.push({
      ...event,
      trace_id: event.trace_id ?? resolvedTraceId,
      sprint: event.sprint ?? sprint,
    });
    scheduleFlush();
  }

  return {
    agentSpawned(agentName, taskId, data = {}) {
      addEvent({
        type: "agent.spawned",
        span_id: spanId(),
        parent_span_id: taskId,
        task_id: taskId,
        agent_name: agentName,
        data,
      });
    },

    agentCompleted(agentName, taskId, data = {}) {
      addEvent({
        type: "agent.completed",
        span_id: spanId(),
        parent_span_id: taskId,
        task_id: taskId,
        agent_name: agentName,
        data,
      });
    },

    agentFailed(agentName, taskId, data = {}) {
      addEvent({
        type: "agent.failed",
        span_id: spanId(),
        parent_span_id: taskId,
        task_id: taskId,
        agent_name: agentName,
        data,
      });
    },

    taskStatusChanged(taskId, previousStatus, newStatus, data = {}) {
      addEvent({
        type: "task.status_changed",
        span_id: spanId(),
        task_id: taskId,
        data: { previous_status: previousStatus, new_status: newStatus, ...data },
      });
    },

    buildEvent(phase, data = {}) {
      addEvent({
        type: `build.${phase}`,
        span_id: spanId(),
        data,
      });
    },

    reviewCompleted(taskId, agentName, data = {}) {
      addEvent({
        type: "review.completed",
        span_id: spanId(),
        task_id: taskId,
        agent_name: agentName,
        data,
      });
    },

    sprintEvent(eventType, data = {}) {
      addEvent({
        type: eventType,
        span_id: spanId(),
        data,
      });
    },

    guardrailEvent(eventType, data = {}) {
      addEvent({
        type: eventType,
        span_id: spanId(),
        data,
      });
    },

    emit(event) {
      addEvent(event);
    },

    async flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await doFlush();
    },
  };
}
