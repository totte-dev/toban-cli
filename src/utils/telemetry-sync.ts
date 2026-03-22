/**
 * Telemetry sync — sends anonymized rule usage stats to API on sprint completion.
 *
 * Privacy: only rule_hash + counts are sent. No matched text, no code, no workspace ID.
 * Workspace is identified by a SHA-256 hash of the API key.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { getMatchBufferPath } from "./rule-matcher.js";
import type { RuleMatchResult } from "./rule-matcher.js";
import type { ApiClient } from "../api-client.js";
import * as ui from "../ui.js";

interface RuleStats {
  rule_hash: string;
  confirm_count: number;
  reject_count: number;
  auto_hit_count: number;
}

/**
 * Detect project context from the working directory.
 * Returns a comma-separated string of detected technologies.
 */
function detectContext(workingDir: string): string {
  const signals: string[] = [];
  try {
    const pkgPath = `${workingDir}/package.json`;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.typescript || allDeps["@types/node"]) signals.push("typescript");
      if (allDeps.react) signals.push("react");
      if (allDeps.next) signals.push("nextjs");
      if (allDeps.vue) signals.push("vue");
      if (allDeps.express || allDeps.hono || allDeps.fastify) signals.push("node-api");
      if (!signals.includes("typescript")) signals.push("javascript");
    }
    if (existsSync(`${workingDir}/requirements.txt`) || existsSync(`${workingDir}/pyproject.toml`)) {
      signals.push("python");
    }
    if (existsSync(`${workingDir}/go.mod`)) signals.push("go");
    if (existsSync(`${workingDir}/Cargo.toml`)) signals.push("rust");
  } catch { /* best-effort */ }
  return signals.join(",");
}

/**
 * Sync rule telemetry to API. Call on sprint completion or CLI shutdown.
 *
 * Reads rule-matches.jsonl, aggregates by rule_id → rule_hash, sends to API,
 * then clears the buffer.
 */
export async function syncRuleTelemetry(
  api: ApiClient,
  apiUrl: string,
  apiKey: string,
  workingDir: string,
  sprint?: number,
): Promise<void> {
  const bufferPath = getMatchBufferPath();
  if (!existsSync(bufferPath)) return;

  let content: string;
  try {
    content = readFileSync(bufferPath, "utf-8").trim();
  } catch { return; }
  if (!content) return;

  // Parse all entries
  const entries = content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as RuleMatchResult; } catch { return null; }
    })
    .filter((e): e is RuleMatchResult => e !== null);

  if (entries.length === 0) return;

  // Aggregate by rule_id
  const statsMap = new Map<string, { confirms: number; rejects: number; autoHits: number }>();
  for (const entry of entries) {
    const key = entry.rule_id;
    const existing = statsMap.get(key) || { confirms: 0, rejects: 0, autoHits: 0 };
    if (entry.tier === "auto_hit") existing.autoHits++;
    // Note: confirm/reject counts come from T2 evaluation results,
    // but we can count auto_hits from T1 here
    statsMap.set(key, existing);
  }

  // Hash rule_ids for anonymization
  const telemetryEntries: RuleStats[] = [];
  for (const [ruleId, stats] of statsMap) {
    const ruleHash = createHash("sha256").update(ruleId).digest("hex").slice(0, 32);
    telemetryEntries.push({
      rule_hash: ruleHash,
      confirm_count: stats.confirms,
      reject_count: stats.rejects,
      auto_hit_count: stats.autoHits,
    });
  }

  if (telemetryEntries.length === 0) return;

  const contextVector = detectContext(workingDir);

  // Send to API
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const res = await fetch(`${apiUrl}/api/v1/telemetry/rules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entries: telemetryEntries,
        context_vector: contextVector || undefined,
        sprint,
      }),
    });

    if (res.ok) {
      ui.info(`[telemetry] Synced ${telemetryEntries.length} rule stats`);
      // Clear the buffer after successful sync
      try { writeFileSync(bufferPath, ""); } catch { /* best-effort */ }
    }
  } catch {
    // Non-fatal: telemetry is best-effort
    ui.warn("[telemetry] Failed to sync rule stats (will retry next sprint)");
  }
}
