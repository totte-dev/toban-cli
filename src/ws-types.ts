/**
 * WebSocket message type constants, legacy types, and TobanEvent envelope.
 *
 * Migration strategy:
 * - New code uses TobanEvent (type hierarchy: "agent.spawned", "chat.message", etc.)
 * - Legacy WS_MSG types are mapped to TobanEvent types via LEGACY_TYPE_MAP
 * - broadcast() wraps all messages in TobanEvent envelope
 * - Frontend reads `event.type` (new) or falls back to `event.legacy_type` (old)
 */

// ── Legacy WS message types (kept for backwards compatibility) ──

export const WS_MSG = {
  CHAT: "chat",
  CHAT_STREAM: "chat_stream",
  STATUS: "status",
  PING: "ping",
  PONG: "pong",
  STDOUT: "stdout",
  STDERR: "stderr",
  PROPOSALS: "proposals",
  REVERT: "revert",
  REVERT_RESULT: "revert_result",
  APPROVAL_REQUEST: "approval_request",
  APPROVAL_RESPONSE: "approval_response",
  AGENT_ACTIVITY: "agent_activity",
  DATA_UPDATE: "data_update",
  REVIEW_UPDATE: "review_update",
} as const;

export type WsMsgType = typeof WS_MSG[keyof typeof WS_MSG];

// ── TobanEvent envelope (new unified format) ──

export interface WsTobanEvent {
  /** New hierarchical event type */
  type: string;
  /** Unique event ID (time-sortable) */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;

  // OTel-inspired tracing
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;

  // Context
  sprint?: number;
  task_id?: string;
  agent_name?: string;

  // Payload (type-specific data)
  data: Record<string, unknown>;

  /** Legacy type for backwards compatibility with old frontend handlers */
  legacy_type?: WsMsgType;
}

// ── Mapping: Legacy WS_MSG → TobanEvent types ──

export const LEGACY_TYPE_MAP: Record<WsMsgType, string> = {
  chat: "chat.message",
  chat_stream: "chat.stream",
  status: "agent.status",
  ping: "system.ping",
  pong: "system.pong",
  stdout: "agent.stdout",
  stderr: "agent.stderr",
  proposals: "task.proposals",
  revert: "task.revert",
  revert_result: "task.revert_result",
  approval_request: "approval.requested",
  approval_response: "approval.responded",
  agent_activity: "agent.activity",
  data_update: "data.update",
  review_update: "review.update",
};

/** Generate a time-sortable event ID */
export function generateWsEventId(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/**
 * Wrap a legacy WsMessage into a TobanEvent envelope.
 * Moves all legacy fields into `data`, sets proper `type`.
 */
export function wrapLegacyMessage(
  legacyType: WsMsgType,
  fields: Record<string, unknown>,
  context?: { sprint?: number; trace_id?: string },
): WsTobanEvent {
  return {
    type: LEGACY_TYPE_MAP[legacyType] ?? legacyType,
    id: generateWsEventId(),
    timestamp: (fields.timestamp as string) ?? new Date().toISOString(),
    trace_id: context?.trace_id,
    sprint: context?.sprint,
    task_id: fields.task_id as string | undefined,
    agent_name: fields.agent_name as string | undefined,
    data: fields,
    legacy_type: legacyType,
  };
}
