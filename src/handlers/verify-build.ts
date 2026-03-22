/**
 * verify_build action handler — guardrail check, dependency install, build, test.
 * Extracted from agent-templates.ts to reduce its size.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionContext, TemplateAction } from "../agent-templates.js";
import { resolveRepoRoot } from "../git-ops.js";
import { checkDiffViolations } from "../utils/guardrail.js";
import { trackRetry } from "../utils/retry-tracker.js";
import { getExecError } from "../utils/exec-error.js";
import * as ui from "../ui.js";

export async function handleVerifyBuild(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: string,
): Promise<void> {
  const label = _action.label ?? "verify_build";
  const repoDir = resolveRepoRoot(ctx.config.workingDir);
  const buildCmd = ctx.config.buildCommand || "npm run build";
  const testCmd = ctx.config.testCommand || "npm test";
  const timeout = 180_000; // 3 minutes per command

  const revertMerge = () => {
    try {
      execSync("git reset --hard HEAD~1", { cwd: repoDir, stdio: "pipe", timeout: 10_000 });
      ui.warn(`[${phase}] ${label}: reverted merge on main`);
    } catch (revertErr) {
      ui.error(`[${phase}] ${label}: failed to revert merge: ${revertErr}`);
    }
  };

  // Layer 4: Pre-merge diff guardrail check
  try {
    const diffStat = execSync("git diff HEAD~1..HEAD --stat", { cwd: repoDir, stdio: "pipe", timeout: 10_000 }).toString();
    const violations = checkDiffViolations(diffStat, ctx.config.guardrailConfig ?? null, ctx.config.autoMode ?? false);
    if (violations.length > 0) {
      ui.error(`[${phase}] ${label}: GUARDRAIL VIOLATION — ${violations.map((v) => v.operation).join("; ")}`);
      ctx.exitCode = 1;
      revertMerge();
      ctx.taskLog?.event("guardrail_violation", { violations });
      return;
    }
  } catch { /* diff check failed, continue with build */ }

  // Install dependencies
  const pkgJsonPath = join(repoDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    const lockfilePath = join(repoDir, "package-lock.json");
    const installCmd = existsSync(lockfilePath) ? "npm ci" : "npm install";
    ui.info(`[${phase}] ${label}: installing dependencies (${installCmd})...`);
    try {
      execSync(installCmd, { cwd: repoDir, stdio: "pipe", timeout });
      ui.info(`[${phase}] ${label}: dependencies installed`);
    } catch (installErr) {
      const detail = getExecError(installErr);
      ui.error(`[${phase}] ${label}: INSTALL FAILED — ${detail.slice(0, 300)}`);
      ctx.exitCode = 1;
      revertMerge();
      ctx.taskLog?.event("action_error", { action: "verify_build", label, error: `Install failed: ${detail.slice(0, 200)}` });
      return;
    }
  }

  // Build
  ui.info(`[${phase}] ${label}: running build (${buildCmd})...`);
  try {
    execSync(buildCmd, { cwd: repoDir, stdio: "pipe", timeout });
    ui.info(`[${phase}] ${label}: build passed`);
  } catch (buildErr) {
    const detail = getExecError(buildErr);
    ui.error(`[${phase}] ${label}: BUILD FAILED — ${detail.slice(0, 300)}`);
    ctx.exitCode = 1;
    revertMerge();
    ctx.taskLog?.event("action_error", { action: "verify_build", label, error: `Build failed: ${detail.slice(0, 200)}` });
    const { retryCount: buildRetry, maxed: buildMaxed } = trackRetry(`build:${ctx.task.id}`);
    if (buildRetry <= 1) {
      ctx.api.recordFailure({
        task_id: ctx.task.id,
        failure_type: "verify_build",
        summary: `Build failed: ${buildCmd}\n${detail.slice(0, 500)}`,
        agent_name: ctx.agentName,
        sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
      }).catch(() => { /* best-effort */ });
    }
    if (buildMaxed) {
      ui.error(`[${phase}] ${label}: build failed ${buildRetry} times — blocking task`);
      ctx.api.updateTask({ id: ctx.task.id, status: "blocked", review_comment: `Build failed ${buildRetry} times: ${detail.slice(0, 300)}` }).catch(() => {});
    }
    return;
  }

  // Test (skip if no test script)
  let hasTestScript = true;
  if (testCmd === "npm test" && existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      hasTestScript = !!(pkg.scripts?.test);
    } catch { /* parse error, try running anyway */ }
  }

  if (!hasTestScript) {
    ui.info(`[${phase}] ${label}: no test script in package.json — skipping tests`);
  } else {
    ui.info(`[${phase}] ${label}: running tests (${testCmd})...`);
    try {
      execSync(testCmd, { cwd: repoDir, stdio: "pipe", timeout });
      ui.info(`[${phase}] ${label}: tests passed`);
    } catch (testErr) {
      const detail = getExecError(testErr);
      ui.error(`[${phase}] ${label}: TESTS FAILED — ${detail.slice(0, 300)}`);
      ctx.exitCode = 1;
      revertMerge();
      ctx.taskLog?.event("action_error", { action: "verify_build", label, error: `Tests failed: ${detail.slice(0, 200)}` });
      const { retryCount: testRetry, maxed: testMaxed } = trackRetry(`test:${ctx.task.id}`);
      if (testRetry <= 1) {
        ctx.api.recordFailure({
          task_id: ctx.task.id,
          failure_type: "verify_build",
          summary: `Tests failed: ${testCmd}\n${detail.slice(0, 500)}`,
          agent_name: ctx.agentName,
          sprint: typeof ctx.task.sprint === "number" ? ctx.task.sprint : undefined,
        }).catch(() => { /* best-effort */ });
      }
      if (testMaxed) {
        ui.error(`[${phase}] ${label}: tests failed ${testRetry} times — blocking task`);
        ctx.api.updateTask({ id: ctx.task.id, status: "blocked", review_comment: `Tests failed ${testRetry} times: ${detail.slice(0, 300)}` }).catch(() => {});
      }
      return;
    }
  }

  ui.info(`[${phase}] ${label}: all checks passed`);
}
