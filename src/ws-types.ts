/**
 * WebSocket message type constants and discriminated union types.
 *
 * Single source of truth for all WS message type strings.
 */

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
