/**
 * Health check for the main branch of a repository.
 * Runs build and test commands to verify the repo is in a working state
 * before allowing agents to receive task assignments.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExecError } from "./exec-error.js";
import * as ui from "../ui.js";

export interface HealthCheckResult {
  passed: boolean;
  failedCommand?: string;
  errorDetail?: string;
}

const TIMEOUT_MS = 180_000; // 3 minutes per command

/** Check whether the package.json at dir has a test script */
function hasTestScript(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return !!pkg.scripts?.test;
  } catch {
    return false;
  }
}

/**
 * Run build and test commands in repoDir to check if main is healthy.
 * Returns immediately with a result — does not retry.
 */
export function runHealthCheck(
  repoDir: string,
  buildCmd: string,
  testCmd: string,
): HealthCheckResult {
  if (!existsSync(repoDir)) {
    return { passed: true }; // no repo to check
  }

  // Build
  ui.info(`[health-check] Running build: ${buildCmd}`);
  try {
    execSync(buildCmd, { cwd: repoDir, stdio: "pipe", timeout: TIMEOUT_MS });
    ui.info("[health-check] Build passed");
  } catch (err) {
    const detail = getExecError(err);
    ui.error(`[health-check] Build FAILED: ${detail.slice(0, 300)}`);
    return { passed: false, failedCommand: buildCmd, errorDetail: detail.slice(0, 500) };
  }

  // Test — skip if no test script defined
  if (testCmd === "npm test" && !hasTestScript(repoDir)) {
    ui.info("[health-check] No test script in package.json — skipping tests");
    return { passed: true };
  }

  ui.info(`[health-check] Running tests: ${testCmd}`);
  try {
    execSync(testCmd, { cwd: repoDir, stdio: "pipe", timeout: TIMEOUT_MS });
    ui.info("[health-check] Tests passed");
  } catch (err) {
    const detail = getExecError(err);
    ui.error(`[health-check] Tests FAILED: ${detail.slice(0, 300)}`);
    return { passed: false, failedCommand: testCmd, errorDetail: detail.slice(0, 500) };
  }

  return { passed: true };
}
