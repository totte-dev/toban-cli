/**
 * Guardrail checker — mechanical checks to prevent dangerous operations.
 *
 * Layer 1: Pre-execution checks (before agent runs)
 *   - Command blocklist: prevent npm publish, deploy, etc.
 *   - File blocklist: prevent .env, CI config changes
 *
 * Layer 4: Pre-merge diff checks (after agent runs, before merge)
 *   - Detect package.json dependency changes
 *   - Detect secret/credential file additions
 *   - Detect CI/CD config changes
 */

export interface GuardrailConfig {
  command_blocklist?: string[];
  file_blocklist?: string[];
  deps_policy?: "allow" | "confirm" | "deny";
  external_network?: "allow" | "restrict" | "deny";
  max_sprints?: number;
  max_hours?: number;
  quality_gate_min_first_pass?: number;
  max_lines_per_sprint?: number;
}

export interface GuardrailViolation {
  layer: number;
  rule: string;
  operation: string;
  details?: string;
}

// Default blocklists
const DEFAULT_COMMAND_BLOCKLIST = [
  "npm publish",
  "npx wrangler deploy",
  "wrangler deploy",
  "vercel --prod",
  "vercel deploy",
  "git push --force",
  "git push -f",
  "gh pr create",
  "gh issue create",
];

const DEFAULT_FILE_BLOCKLIST = [
  ".env",
  ".env.*",
  "*.secret",
  "*.credentials",
  "credentials.json",
];

const AUTO_MODE_COMMAND_BLOCKLIST = [
  ...DEFAULT_COMMAND_BLOCKLIST,
  "vercel",
  "gh pr",
  "gh issue",
  "gh release",
  "rm -rf /",
  "rm -rf ~",
];

const AUTO_MODE_FILE_BLOCKLIST = [
  ...DEFAULT_FILE_BLOCKLIST,
  ".github/workflows/*",
  ".github/actions/*",
  "LICENSE*",
  "TERMS*",
  "PRIVACY*",
];

/**
 * Build CLAUDE.md guardrail rules for injection into agent prompts.
 */
export function buildGuardrailRules(config: GuardrailConfig | null, isAutoMode: boolean): string[] {
  const cmdBlocklist = config?.command_blocklist ??
    (isAutoMode ? AUTO_MODE_COMMAND_BLOCKLIST : DEFAULT_COMMAND_BLOCKLIST);
  const fileBlocklist = config?.file_blocklist ??
    (isAutoMode ? AUTO_MODE_FILE_BLOCKLIST : DEFAULT_FILE_BLOCKLIST);

  const rules: string[] = [
    `BLOCKED COMMANDS (do NOT execute): ${cmdBlocklist.join(", ")}`,
    `PROTECTED FILES (do NOT modify): ${fileBlocklist.join(", ")}`,
  ];

  if (isAutoMode || config?.deps_policy === "deny") {
    rules.push("Do NOT add new dependencies to package.json. Only modify existing code.");
  }

  if (isAutoMode || config?.external_network === "deny") {
    rules.push("Do NOT make HTTP requests to external services. Only use localhost APIs.");
  }

  return rules;
}

/**
 * Layer 4: Check git diff for guardrail violations before merge.
 * Returns list of violations found.
 */
export function checkDiffViolations(
  diffStat: string,
  config: GuardrailConfig | null,
  isAutoMode: boolean,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const fileBlocklist = config?.file_blocklist ??
    (isAutoMode ? AUTO_MODE_FILE_BLOCKLIST : DEFAULT_FILE_BLOCKLIST);
  const depsPolicy = config?.deps_policy ?? (isAutoMode ? "deny" : "allow");

  const lines = diffStat.split("\n");

  for (const line of lines) {
    // Parse git diff --stat format: " path/to/file | 5 ++"  or  " path/to/file | 1 +"
    const statMatch = line.match(/^\s*(.+?)\s*\|/);
    const filePath = statMatch ? statMatch[1].trim() : line.trim().split(/\s+/)[0] ?? "";

    // Check file blocklist
    for (const pattern of fileBlocklist) {
      if (matchGlob(filePath, pattern)) {
        violations.push({
          layer: 4,
          rule: "file_blocklist",
          operation: `Modified protected file: ${filePath}`,
          details: `Pattern: ${pattern}`,
        });
        break;
      }
    }

    // Check package.json dependency changes
    if (depsPolicy !== "allow" && filePath === "package.json") {
      violations.push({
        layer: 4,
        rule: "deps_policy",
        operation: "package.json modified",
        details: `Policy: ${depsPolicy}`,
      });
    }
  }

  return violations;
}

/** Simple glob matching: supports * wildcard and .* suffix */
function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\*/g, ".*"); // * → .*
  const regex = new RegExp(`(^|/)${regexStr}$`, "i");
  return regex.test(filePath);
}
