/**
 * verify_build action handler — guardrail check, dependency install, build, test.
 * Extracted from agent-templates.ts to reduce its size.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionContext, TemplateAction } from "../agents/agent-templates.js";
import { resolveRepoRoot } from "../services/git-ops.js";
import { checkDiffViolations } from "../utils/guardrail.js";
import { trackRetry } from "../utils/retry-tracker.js";
import { getExecError } from "../utils/exec-error.js";
import * as ui from "../ui.js";

/** Test file patterns by ecosystem */
const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs)$/,  // JS/TS: *.test.ts
  /\.spec\.(ts|tsx|js|jsx|mjs)$/,  // JS/TS: *.spec.ts
  /^test_.*\.py$/,                  // Python: test_*.py
  /_test\.py$/,                     // Python: *_test.py
  /_test\.go$/,                     // Go: *_test.go
  /_test\.rs$/,                     // Rust: *_test.rs (integration tests)
];

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|kt|swift)$/;

function isTestFile(filename: string): boolean {
  const base = filename.split("/").pop() || "";
  return TEST_FILE_PATTERNS.some((p) => p.test(base)) || filename.includes("__tests__/");
}

/** Detect test runner from defaultCmd or project files */
function detectTestRunner(repoDir: string, defaultCmd: string): string | null {
  if (defaultCmd.includes("vitest")) return "vitest";
  if (defaultCmd.includes("jest")) return "jest";
  if (defaultCmd.includes("pytest")) return "pytest";
  if (defaultCmd.includes("cargo test")) return "cargo";
  if (defaultCmd.includes("go test")) return "go";
  // Auto-detect from package.json or files
  if (existsSync(join(repoDir, "vitest.config.ts")) || existsSync(join(repoDir, "vitest.config.mts"))) return "vitest";
  if (existsSync(join(repoDir, "jest.config.ts")) || existsSync(join(repoDir, "jest.config.js"))) return "jest";
  if (existsSync(join(repoDir, "pytest.ini")) || existsSync(join(repoDir, "pyproject.toml"))) return "pytest";
  if (existsSync(join(repoDir, "Cargo.toml"))) return "cargo";
  if (existsSync(join(repoDir, "go.mod"))) return "go";
  return null;
}

/** Build a scoped test command for specific test files */
function buildRunnerCommand(runner: string, testFiles: string[]): string | null {
  switch (runner) {
    case "vitest": return `npx vitest run ${testFiles.join(" ")}`;
    case "jest": return `npx jest ${testFiles.join(" ")}`;
    case "pytest": return `python -m pytest ${testFiles.join(" ")}`;
    case "cargo": return null; // cargo test doesn't easily scope to files
    case "go": return null; // go test scopes by package, not file
    default: return null;
  }
}

/**
 * Build a test command scoped to files changed in the last commit.
 * Supports JS/TS (vitest, jest), Python (pytest), and falls back to full suite.
 */
function buildScopedTestCommand(repoDir: string, defaultCmd: string): string {
  try {
    const changedFiles = execSync("git diff HEAD~1..HEAD --name-only", {
      cwd: repoDir, stdio: "pipe", timeout: 10_000,
    }).toString().trim().split("\n").filter(Boolean);

    if (changedFiles.length === 0) return defaultCmd;

    const testFiles: string[] = [];
    for (const file of changedFiles) {
      if (isTestFile(file)) {
        testFiles.push(file);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(file)) continue;

      const base = file.split("/").pop()?.replace(SOURCE_EXTENSIONS, "");
      if (!base) continue;

      // Search for related test files
      try {
        const matches = execSync(
          `find . \\( -name "*${base}*.test.*" -o -name "*${base}*.spec.*" -o -name "test_${base}.*" -o -name "${base}_test.*" \\) -not -path "*/node_modules/*" 2>/dev/null`,
          { cwd: repoDir, stdio: "pipe", timeout: 5_000 },
        ).toString().trim().split("\n").filter(Boolean);
        testFiles.push(...matches);
      } catch { /* no matches */ }
    }

    if (testFiles.length === 0) return defaultCmd;

    const uniqueTests = [...new Set(testFiles)].slice(0, 10);
    const runner = detectTestRunner(repoDir, defaultCmd);
    if (!runner) return defaultCmd;

    const cmd = buildRunnerCommand(runner, uniqueTests);
    return cmd ?? defaultCmd;
  } catch {
    return defaultCmd;
  }
}

export async function handleVerifyBuild(
  _action: TemplateAction,
  ctx: ActionContext,
  phase: string,
): Promise<void> {
  const label = _action.label ?? "verify_build";
  const repoDir = resolveRepoRoot(ctx.config.workingDir);
  // Builder-specified commands take priority over workspace defaults
  // Use typecheck instead of full build — faster, no .next cache issues, catches real type errors
  const buildCmd = ctx.completionJson?.build_command || ctx.config.buildCommand || "npm run typecheck --if-present";
  const testCmd = ctx.completionJson?.test_command || ctx.config.testCommand || "npm test";
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

  // Install dependencies (detect package manager from lockfile)
  const pkgJsonPath = join(repoDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    const { detectInstallCommand } = await import("../utils/detect-package-manager.js");
    const installCmd = detectInstallCommand(repoDir) || "npm install";
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
      ctx.api.updateTask(ctx.task.id, { status: "blocked", review_comment: `Build failed ${buildRetry} times: ${detail.slice(0, 300)}` }).catch(() => {});
    }
    return;
  }

  // Test — detect subdirectory from changed files and run tests in correct location
  // For monorepos: if all changes are in a subdirectory (e.g. api/), run tests there
  let effectiveTestCmd = testCmd;
  let effectiveTestDir = repoDir;
  if (!ctx.completionJson?.test_command) {
    try {
      const changedFiles = execSync("git diff HEAD~1..HEAD --name-only", { cwd: repoDir, stdio: "pipe", timeout: 10_000 })
        .toString().trim().split("\n").filter(Boolean);
      // Detect if all changes are in a subdirectory with its own package.json
      const subdirs = new Set(changedFiles.map(f => f.split("/")[0]).filter(Boolean));
      for (const sub of subdirs) {
        const subPkg = join(repoDir, sub, "package.json");
        if (existsSync(subPkg)) {
          try {
            const pkg = JSON.parse(readFileSync(subPkg, "utf-8"));
            if (pkg.scripts?.test) {
              effectiveTestDir = join(repoDir, sub);
              effectiveTestCmd = "npm test";
              ui.info(`[${phase}] ${label}: detected subdirectory "${sub}" with test script`);
              break;
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* diff check failed, use defaults */ }
  }

  let hasTestScript = true;
  const testPkgPath = join(effectiveTestDir, "package.json");
  if (effectiveTestCmd === "npm test" && existsSync(testPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(testPkgPath, "utf-8"));
      hasTestScript = !!(pkg.scripts?.test);
    } catch { /* parse error, try running anyway */ }
  }

  if (!hasTestScript) {
    ui.info(`[${phase}] ${label}: no test script in package.json — skipping tests`);
  } else {
    // Detect changed files and find related test files
    const scopedTestCmd = effectiveTestDir !== repoDir ? effectiveTestCmd : buildScopedTestCommand(repoDir, effectiveTestCmd);
    ui.info(`[${phase}] ${label}: running tests (${scopedTestCmd}) in ${effectiveTestDir === repoDir ? "root" : effectiveTestDir.split("/").pop()}...`);
    try {
      execSync(scopedTestCmd, { cwd: effectiveTestDir, stdio: "pipe", timeout });
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
        ctx.api.updateTask(ctx.task.id, { status: "blocked", review_comment: `Tests failed ${testRetry} times: ${detail.slice(0, 300)}` }).catch(() => {});
      }
      return;
    }
  }

  ui.info(`[${phase}] ${label}: all checks passed`);
}
