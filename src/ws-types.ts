/**
 * WebSocket message type constants and discriminated union types.
 *
 * Single source of truth for all WS message type strings.
 */

export const WS_MSG = {
  CHAT: "chat",
  STATUS: "status",
  PING: "ping",
  PONG: "pong",
  STDOUT: "stdout",
  STDERR: "stderr",
  PROPOSALS: "proposals",
  REVERT: "revert",
  REVERT_RESULT: "revert_result",
} as const;

export type WsMsgType = typeof WS_MSG[keyof typeof WS_MSG];
