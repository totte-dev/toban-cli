/**
 * COMPLETION_JSON extraction from agent stdout lines.
 *
 * Parses both direct `COMPLETION_JSON:{...}` lines and stream-json `result`
 * events that contain COMPLETION_JSON inside the result text.
 *
 * Uses standardized completion schemas (completion-schema.ts) and normalizes
 * all output to the AgentCompletion format while maintaining backwards
 * compatibility with the legacy { review_comment, commits } format.
 */

import type { TemplateAction } from "../agent-templates.js";
import * as ui from "../ui.js";
import { normalizeCompletion, toLegacyFormat, type AgentCompletion } from "./completion-schema.js";

/** Legacy format — kept for backwards compatibility */
export interface CompletionResult {
  review_comment: string;
  commits: string;
}

/**
 * Inject completion data into the matching update_task post_action.
 */
function injectIntoPostActions(actions: TemplateAction[], review_comment: string, commits: string): void {
  for (const action of actions) {
    if (action.type === "update_task" && action.when === "success" && action.params?.status === "review") {
      action.params = { ...action.params, review_comment, commits };
      break;
    }
  }
}

/**
 * Parse raw JSON into normalized AgentCompletion + legacy CompletionResult.
 */
function parseCompletionJson(json: Record<string, unknown>): { completion: AgentCompletion; legacy: CompletionResult } {
  const completion = normalizeCompletion(json);
  const legacy = toLegacyFormat(completion);
  return { completion, legacy };
}

/**
 * Extract COMPLETION_JSON from agent stdout lines.
 * Returns the parsed completion data or null if not found.
 *
 * Mutates `postActions` to inject review_comment/commits into the update_task action.
 */
export function extractCompletionJson(
  stdoutLines: string[],
  postActions: TemplateAction[],
  callbacks?: {
    onReviewUpdate?: (taskId: string, phase: string, reviewComment: string) => void;
    taskId?: string;
    taskLog?: { event: (name: string, data: Record<string, unknown>) => void };
    /** New: receive the normalized completion */
    onCompletion?: (completion: AgentCompletion) => void;
  }
): CompletionResult | null {
  // Pass 1: stream-json result events (fallback for when no direct COMPLETION_JSON line exists)
  for (const l of stdoutLines) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "result" && ev.subtype === "success" && typeof ev.result === "string") {
        const cjMatch = ev.result.match(/COMPLETION_JSON:(\{[\s\S]*\})/);
        let result: CompletionResult;
        let completion: AgentCompletion;
        if (cjMatch) {
          try {
            const cj = JSON.parse(cjMatch[1]);
            const parsed = parseCompletionJson(cj);
            completion = parsed.completion;
            result = parsed.legacy;
          } catch {
            const resultText = ev.result.slice(0, 2000);
            completion = { summary: resultText };
            result = { review_comment: resultText, commits: "" };
          }
        } else {
          const resultText = ev.result.slice(0, 2000);
          completion = { summary: resultText };
          result = { review_comment: resultText, commits: "" };
        }
        injectIntoPostActions(postActions, result.review_comment, "");
        ui.info(`[completion] Extracted completion from stream result (no COMPLETION_JSON)`);
        callbacks?.taskLog?.event("completion_parse", { source: "stream_result", summary: completion.summary.slice(0, 200) });
        callbacks?.onCompletion?.(completion);
        return result;
      }
    } catch { /* skip */ }
  }

  // Pass 2: direct COMPLETION_JSON: lines and stream-json result events containing COMPLETION_JSON
  for (const line of stdoutLines) {
    // Direct COMPLETION_JSON: line
    if (line.startsWith("COMPLETION_JSON:")) {
      try {
        const json = JSON.parse(line.slice("COMPLETION_JSON:".length));
        const { completion, legacy } = parseCompletionJson(json);
        injectIntoPostActions(postActions, legacy.review_comment, legacy.commits);
        ui.info(`[completion] Parsed COMPLETION_JSON: ${completion.summary.slice(0, 80)}...`);
        callbacks?.taskLog?.event("completion_parse", {
          source: "completion_json",
          summary: completion.summary.slice(0, 200),
          commits: completion.commits,
          files_changed: completion.files_changed,
        });
        if (completion.summary && callbacks?.onReviewUpdate && callbacks?.taskId) {
          callbacks.onReviewUpdate(callbacks.taskId, "agent_submitted", completion.summary);
        }
        callbacks?.onCompletion?.(completion);
        return legacy;
      } catch { /* skip */ }
    }

    // Stream-json event containing COMPLETION_JSON in result text
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") {
        const match = event.result.match(/COMPLETION_JSON:(\{[\s\S]*\})/);
        if (match) {
          const json = JSON.parse(match[1]);
          const { completion, legacy } = parseCompletionJson(json);
          injectIntoPostActions(postActions, legacy.review_comment, legacy.commits);
          ui.info(`[completion] Parsed COMPLETION_JSON from stream: ${completion.summary.slice(0, 80)}...`);
          if (completion.summary && callbacks?.onReviewUpdate && callbacks?.taskId) {
            callbacks.onReviewUpdate(callbacks.taskId, "agent_submitted", completion.summary);
          }
          callbacks?.onCompletion?.(completion);
          return legacy;
        }
      }
    } catch { /* not JSON */ }
  }

  return null;
}
