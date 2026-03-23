/**
 * Fire-and-forget rule evaluation: sends retro/review text to the rule evaluation API.
 * Failures are silently logged — this must never block the main flow.
 */

import { createAuthHeaders } from "./api-client.js";
import * as ui from "../ui.js";

interface EvaluateInput {
  apiUrl: string;
  apiKey: string;
  recordId: string;
  recordType: "retro" | "task_review" | "failure" | "qa_scan";
  text: string;
  improvementNotes?: string;
}

export function fireRuleEvaluate(input: EvaluateInput): void {
  const { apiUrl, apiKey, recordId, recordType, text, improvementNotes } = input;

  // Fire and forget — do not await
  fetch(`${apiUrl}/api/v1/rule-evaluations/evaluate`, {
    method: "POST",
    headers: createAuthHeaders(apiKey),
    body: JSON.stringify({
      record_id: recordId,
      record_type: recordType,
      text: text.slice(0, 5000),
      improvement_notes: improvementNotes?.slice(0, 5000) || null,
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        const body = await res.json() as { matches: Array<{ category: string; confidence: number }> };
        if (body.matches.length > 0) {
          const matched = body.matches.map((m) => `${m.category}(${m.confidence.toFixed(1)})`).join(", ");
          ui.info(`[rule-eval] Matched: ${matched}`);
        }
      }
      // Silently ignore non-ok (API may not have the endpoint yet)
    })
    .catch(() => {
      // Silently ignore — rule evaluation is best-effort
    });
}
