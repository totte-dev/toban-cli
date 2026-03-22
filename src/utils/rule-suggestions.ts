/**
 * Project analysis and rule suggestions for toban init.
 *
 * Analyzes the project to suggest playbook rules:
 * 1. Detect tech stack from config files → suggest common rules
 * 2. Parse existing linter configs (.eslintrc, .rubocop.yml, etc.)
 * 3. Analyze git log for repeated fix patterns
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleSuggestion {
  title: string;
  content: string;
  category: string;
  source: string; // "tech-stack" | "linter" | "git-history"
}

// ---------------------------------------------------------------------------
// Tech stack detection
// ---------------------------------------------------------------------------

interface TechProfile {
  languages: string[];
  frameworks: string[];
  tools: string[];
}

function detectTechStack(cwd: string): TechProfile {
  const profile: TechProfile = { languages: [], frameworks: [], tools: [] };

  // Node.js / JavaScript / TypeScript
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (allDeps.typescript) profile.languages.push("typescript");
      else profile.languages.push("javascript");

      if (allDeps.react) profile.frameworks.push("react");
      if (allDeps.next) profile.frameworks.push("nextjs");
      if (allDeps.vue) profile.frameworks.push("vue");
      if (allDeps.express) profile.frameworks.push("express");
      if (allDeps.hono) profile.frameworks.push("hono");
      if (allDeps.fastify) profile.frameworks.push("fastify");

      if (allDeps.vitest || allDeps.jest) profile.tools.push("testing");
      if (allDeps.eslint) profile.tools.push("eslint");
      if (allDeps.prettier) profile.tools.push("prettier");
    } catch { /* ignore parse errors */ }
  }

  // Python
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml"))) {
    profile.languages.push("python");
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    profile.languages.push("go");
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    profile.languages.push("rust");
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Tech stack rules
// ---------------------------------------------------------------------------

function getTechStackRules(profile: TechProfile): RuleSuggestion[] {
  const rules: RuleSuggestion[] = [];

  if (profile.languages.includes("typescript") || profile.languages.includes("javascript")) {
    rules.push({
      title: "Type Safety",
      content: "Avoid using `any` type. Use specific types or `unknown` when the type is truly uncertain.",
      category: "code_quality",
      source: "tech-stack",
    });
  }

  if (profile.frameworks.includes("react") || profile.frameworks.includes("nextjs")) {
    rules.push({
      title: "React Key Prop",
      content: "Always provide a stable, unique `key` prop when rendering lists. Do not use array index as key for dynamic lists.",
      category: "code_quality",
      source: "tech-stack",
    });
  }

  if (profile.tools.includes("testing")) {
    rules.push({
      title: "Test Coverage",
      content: "Every new function or module should have corresponding unit tests. Do not submit code without tests for new logic.",
      category: "testing",
      source: "tech-stack",
    });
  }

  // Common rules for all projects
  rules.push({
    title: "No Hardcoded Secrets",
    content: "Never hardcode API keys, tokens, passwords, or connection strings. Use environment variables or a secrets manager.",
    category: "security",
    source: "tech-stack",
  });

  rules.push({
    title: "Error Handling",
    content: "Do not swallow errors silently. Log or handle errors appropriately. Avoid empty catch blocks without explanation.",
    category: "code_quality",
    source: "tech-stack",
  });

  return rules;
}

// ---------------------------------------------------------------------------
// Linter config parsing
// ---------------------------------------------------------------------------

function parseLinterConfigs(cwd: string): RuleSuggestion[] {
  const rules: RuleSuggestion[] = [];

  // Check for .eslintrc / eslint.config.js
  const eslintFiles = [
    ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", ".eslintrc",
    "eslint.config.js", "eslint.config.mjs",
  ];
  for (const file of eslintFiles) {
    if (existsSync(join(cwd, file))) {
      rules.push({
        title: "ESLint Compliance",
        content: `This project uses ESLint (${file}). All code changes must pass ESLint checks without disabling rules inline unless absolutely necessary.`,
        category: "code_quality",
        source: "linter",
      });
      break;
    }
  }

  // Check for prettier
  const prettierFiles = [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"];
  for (const file of prettierFiles) {
    if (existsSync(join(cwd, file))) {
      rules.push({
        title: "Consistent Formatting",
        content: `This project uses Prettier (${file}). All code must be formatted before commit. Do not mix formatting styles.`,
        category: "style",
        source: "linter",
      });
      break;
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Git history analysis
// ---------------------------------------------------------------------------

function analyzeGitHistory(cwd: string): RuleSuggestion[] {
  const rules: RuleSuggestion[] = [];

  try {
    const log = execSync("git log --oneline -200 --format=%s", {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!log) return rules;

    const messages = log.split("\n");

    // Count fix patterns
    const fixMessages = messages.filter((m) => /^fix[:(]/i.test(m));
    if (fixMessages.length >= 5) {
      // Find common words in fix messages
      const wordCounts = new Map<string, number>();
      for (const msg of fixMessages) {
        const words = msg.toLowerCase().match(/[a-z]{4,}/g) || [];
        for (const word of new Set(words)) {
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }
      }

      // Find most common fix topics (excluding common words)
      const commonWords = new Set(["this", "that", "with", "from", "have", "been", "were", "make", "when", "into", "type", "test", "file", "code", "commit"]);
      const topWords = [...wordCounts.entries()]
        .filter(([word, count]) => count >= 3 && !commonWords.has(word))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      if (topWords.length > 0) {
        const topics = topWords.map(([word, count]) => `${word} (${count} fixes)`).join(", ");
        rules.push({
          title: "Repeated Fix Pattern",
          content: `Git history shows recurring fixes in: ${topics}. Pay extra attention to these areas during review.`,
          category: "process",
          source: "git-history",
        });
      }
    }

    // Check if there are many revert commits
    const reverts = messages.filter((m) => /^revert/i.test(m));
    if (reverts.length >= 3) {
      rules.push({
        title: "Pre-merge Verification",
        content: `${reverts.length} revert commits found in recent history. Verify changes thoroughly before merging — run full build and test suite.`,
        category: "process",
        source: "git-history",
      });
    }
  } catch { /* non-fatal: no git or no history */ }

  return rules;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a project directory and return rule suggestions.
 */
export async function analyzeProjectAndSuggestRules(cwd: string): Promise<RuleSuggestion[]> {
  const profile = detectTechStack(cwd);
  const techRules = getTechStackRules(profile);
  const linterRules = parseLinterConfigs(cwd);
  const gitRules = analyzeGitHistory(cwd);

  // Deduplicate by title
  const seen = new Set<string>();
  const all: RuleSuggestion[] = [];
  for (const rule of [...linterRules, ...gitRules, ...techRules]) {
    if (!seen.has(rule.title)) {
      seen.add(rule.title);
      all.push(rule);
    }
  }

  return all;
}
