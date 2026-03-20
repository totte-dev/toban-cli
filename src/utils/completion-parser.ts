/**
 * COMPLETION_JSON extraction from agent stdout lines.
 *
 * Parses both direct `COMPLETION_JSON:{...}` lines and stream-json `result`
 * events that contain COMPLETION_JSON inside the result text.
 */

import type { TemplateAction } from "../agent-templates.js";
import * as ui from "../ui.js";

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
  }
): CompletionResult | null {
  // Pass 1: stream-json result events (fallback for when no direct COMPLETION_JSON line exists)
  for (const l of stdoutLines) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "result" && ev.subtype === "success" && typeof ev.result === "string") {
        const cjMatch = ev.result.match(/COMPLETION_JSON:(\{[\s\S]*\})/);
        let resultText: string;
        let result: CompletionResult;
        if (cjMatch) {
          try {
            const cj = JSON.parse(cjMatch[1]);
            result = { review_comment: cj.review_comment, commits: cj.commits };
            resultText = cj.review_comment || ev.result.slice(0, 2000);
          } catch {
            resultText = ev.result.slice(0, 2000);
            result = { review_comment: resultText, commits: "" };
          }
        } else {
          resultText = ev.result.slice(0, 2000);
          result = { review_comment: resultText, commits: "" };
        }
        injectIntoPostActions(postActions, resultText, "");
        ui.info(`[completion] Extracted completion from stream result (no COMPLETION_JSON)`);
        callbacks?.taskLog?.event("completion_parse", { source: "stream_result", review_comment: resultText.slice(0, 200) });
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
        injectIntoPostActions(postActions, json.review_comment, json.commits);
        ui.info(`[completion] Parsed COMPLETION_JSON: ${json.review_comment?.slice(0, 80)}...`);
        callbacks?.taskLog?.event("completion_parse", { source: "completion_json", review_comment: json.review_comment?.slice(0, 200), commits: json.commits });
        if (json.review_comment && callbacks?.onReviewUpdate && callbacks?.taskId) {
          callbacks.onReviewUpdate(callbacks.taskId, "agent_submitted", json.review_comment);
        }
        return { review_comment: json.review_comment, commits: json.commits };
      } catch { /* skip */ }
    }

    // Stream-json event containing COMPLETION_JSON in result text
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") {
        const match = event.result.match(/COMPLETION_JSON:(\{[\s\S]*\})/);
        if (match) {
          const json = JSON.parse(match[1]);
          injectIntoPostActions(postActions, json.review_comment, json.commits);
          ui.info(`[completion] Parsed COMPLETION_JSON from stream: ${json.review_comment?.slice(0, 80)}...`);
          if (json.review_comment && callbacks?.onReviewUpdate && callbacks?.taskId) {
            callbacks.onReviewUpdate(callbacks.taskId, "agent_submitted", json.review_comment);
          }
          return { review_comment: json.review_comment, commits: json.commits };
        }
      }
    } catch { /* not JSON */ }
  }

  return null;
}
