/**
 * Telemetry sync — sends anonymized rule usage stats to API on sprint completion.
 *
 * Privacy: only rule_hash + counts are sent. No matched text, no code, no workspace ID.
 * Workspace is identified by a SHA-256 hash of the API key.
 */

import { readFileSync, existsSync } from "node:fs";
import * as ui from "../ui.js";

/**
 * Detect project context from the working directory.
 * Returns a comma-separated string of detected technologies.
 */
export function detectContext(workingDir: string): string {
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
      if (allDeps.vitest || allDeps.jest) signals.push("testing");
      if (allDeps.eslint) signals.push("eslint");
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
 * Now a no-op since local rule matching was removed.
 */
export async function syncRuleTelemetry(
  _apiUrl: string,
  _apiKey: string,
  _workingDir: string,
  _sprint?: number,
): Promise<void> {
  // No-op: local rule matching buffer removed
}
