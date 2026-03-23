/**
 * Init command — interactive project onboarding.
 *
 * Usage:
 *   toban init
 *
 * Creates `.toban/config.json` in the current directory with API credentials
 * and workspace configuration.
 */

import * as p from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createApiClient, type WorkspaceInfo } from "../services/api-client.js";
import { analyzeProjectAndSuggestRules } from "../utils/rule-suggestions.js";

// ---------------------------------------------------------------------------
// Git hook installer
// ---------------------------------------------------------------------------

function findGitDir(cwd: string): string | null {
  try {
    return execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

function installPostPushHook(cwd: string, apiUrl: string, apiKey: string): boolean {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return false;

  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  // post-push is not a native git hook, so we use post-commit + push detection
  // Instead, use pre-push which fires before push completes
  const hookPath = join(hooksDir, "pre-push");

  // Don't overwrite existing hooks
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes("toban review")) return true; // already installed
    return false; // user has a custom hook
  }

  const hookScript = `#!/bin/sh
# Auto-review on push — installed by toban init
# Runs toban review asynchronously after push completes
# Only reviews if the push succeeds (pre-push runs before push, so we background it)

# Get the commit range being pushed
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" != "0000000000000000000000000000000000000000" ]; then
    # Background: wait for push to finish, then review
    (
      sleep 2
      npx toban review --api-url "${apiUrl}" --api-key "${apiKey}" --diff "$remote_sha..$local_sha" 2>/dev/null &
    ) &
  fi
done

exit 0
`;

  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, 0o755);
  return true;
}


// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface TobanConfig {
  api_url: string;
  api_key: string;
  workspace_id: string;
  project_name: string;
  created_at: string;
}

const CONFIG_DIR = ".toban";
const CONFIG_FILE = "config.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function loadConfig(cwd: string): TobanConfig | null {
  const path = configPath(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TobanConfig;
  } catch {
    return null;
  }
}

function isCancel(value: unknown): value is symbol {
  return p.isCancel(value);
}

async function validateApiKey(apiUrl: string, apiKey: string): Promise<WorkspaceInfo | null> {
  try {
    const api = createApiClient(apiUrl, apiKey);
    return await api.fetchWorkspace();
  } catch {
    return null;
  }
}

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open ${JSON.stringify(url)}`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" ${JSON.stringify(url)}`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: "ignore" });
    }
  } catch {
    // Best effort — user can manually open the URL
  }
}

interface CliAuthStartResponse {
  cli_code: string;
  poll_token: string;
  auth_url: string;
}

interface CliAuthPollResponse {
  status: "pending" | "completed" | "expired";
  api_key?: string;
  workspace_id?: string;
  workspace_name?: string;
}

/** Start a CLI auth session on the API. */
async function startCliAuth(apiUrl: string): Promise<CliAuthStartResponse | null> {
  try {
    const res = await fetch(`${apiUrl}/api/auth/cli/start`, { method: "POST" });
    if (!res.ok) return null;
    return (await res.json()) as CliAuthStartResponse;
  } catch {
    return null;
  }
}

/** Poll for CLI auth completion. */
async function pollCliAuth(apiUrl: string, pollToken: string): Promise<CliAuthPollResponse> {
  const res = await fetch(`${apiUrl}/api/auth/cli/poll?poll_token=${encodeURIComponent(pollToken)}`);
  if (!res.ok) throw new Error("Poll request failed");
  return (await res.json()) as CliAuthPollResponse;
}

/** Wait for auth completion by polling every 2s, up to timeoutMs. */
async function waitForCliAuth(
  apiUrl: string,
  pollToken: string,
  timeoutMs: number,
): Promise<CliAuthPollResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pollCliAuth(apiUrl, pollToken);
    if (result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { status: "expired" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleInit(): Promise<void> {
  const cwd = process.cwd();

  p.intro("toban init");

  // Check for existing config
  const existing = loadConfig(cwd);
  if (existing) {
    const overwrite = await p.confirm({
      message: `.toban/config.json already exists (workspace: ${existing.project_name}). Overwrite?`,
      initialValue: false,
    });
    if (isCancel(overwrite) || !overwrite) {
      p.outro("Cancelled.");
      return;
    }
  }

  // 1. API URL
  const apiUrl = await p.text({
    message: "API URL",
    placeholder: "https://api.toban.dev",
    defaultValue: "https://api.toban.dev",
    validate: (v) => {
      if (!v) return "API URL is required";
      try { new URL(v); } catch { return "Invalid URL"; }
    },
  });
  if (isCancel(apiUrl)) { p.outro("Cancelled."); return; }

  // 2. Authentication — browser login or manual API key
  const authMethod = await p.select({
    message: "How would you like to authenticate?",
    options: [
      { value: "browser", label: "Login with GitHub (opens browser)" },
      { value: "manual", label: "Paste API key manually" },
    ],
  });
  if (isCancel(authMethod)) { p.outro("Cancelled."); return; }

  let apiKey: string;
  let workspaceId: string | undefined;
  let workspaceName: string | undefined;

  if (authMethod === "browser") {
    // Browser-based auth flow
    const spin = p.spinner();
    spin.start("Connecting to API...");

    const authSession = await startCliAuth(apiUrl);
    if (!authSession) {
      spin.stop("Connection failed");
      p.log.error("Could not connect to the API. Check your API URL.");
      p.outro("Setup failed.");
      process.exit(1);
    }
    spin.stop("Connected");

    p.note(
      [
        `URL:  ${authSession.auth_url}`,
        `Code: ${authSession.cli_code}`,
      ].join("\n"),
      "Open in browser to authenticate"
    );

    openBrowser(authSession.auth_url);

    spin.start("Waiting for authentication (timeout: 5 min)...");
    const result = await waitForCliAuth(apiUrl, authSession.poll_token, 5 * 60 * 1000);

    if (result.status === "completed" && result.api_key) {
      spin.stop("Authenticated");
      apiKey = result.api_key;
      workspaceId = result.workspace_id;
      workspaceName = result.workspace_name;
    } else {
      spin.stop("Authentication timed out or was rejected");
      p.log.error("Browser authentication did not complete in time.");
      p.outro("Setup failed.");
      process.exit(1);
    }
  } else {
    // Manual API key
    const manualKey = await p.text({
      message: "API key",
      placeholder: "tb_xxx",
      validate: (v) => {
        if (!v) return "API key is required";
        if (!v.startsWith("tb_")) return "API key must start with tb_";
      },
    });
    if (isCancel(manualKey)) { p.outro("Cancelled."); return; }
    apiKey = manualKey;
  }

  // 3. Validate key
  const spin = p.spinner();
  spin.start("Validating API key...");
  const workspace = await validateApiKey(apiUrl, apiKey);
  if (!workspace) {
    spin.stop("Validation failed");
    p.log.error("Could not connect to the API. Check your API URL and key.");
    p.outro("Setup failed.");
    process.exit(1);
  }
  spin.stop(`Connected to workspace: ${workspace.name}`);

  // 4. Show workspace info
  const infoLines = [
    `Name:   ${workspace.name}`,
    `ID:     ${workspace.id}`,
  ];
  if (workspace.github_repo) {
    infoLines.push(`Repo:   ${workspace.github_repo}`);
  }
  if (workspace.language) {
    infoLines.push(`Lang:   ${workspace.language}`);
  }
  p.note(infoLines.join("\n"), "Workspace");

  // 5. Project name
  const projectName = await p.text({
    message: "Project name (for this directory)",
    defaultValue: workspace.name,
    placeholder: workspace.name,
  });
  if (isCancel(projectName)) { p.outro("Cancelled."); return; }

  // 6. Save config
  const config: TobanConfig = {
    api_url: apiUrl,
    api_key: apiKey,
    workspace_id: workspace.id,
    project_name: projectName,
    created_at: new Date().toISOString(),
  };

  const dir = join(cwd, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(cwd), JSON.stringify(config, null, 2) + "\n");

  p.log.success(`Config saved to ${CONFIG_DIR}/${CONFIG_FILE}`);

  // 7. Install git pre-push hook for auto-review
  const gitDir = findGitDir(cwd);
  const hookInstalled = installPostPushHook(cwd, apiUrl, apiKey);
  if (hookInstalled) {
    p.log.success("Git pre-push hook installed (auto-review on push)");
  } else {
    if (!gitDir) {
      p.log.warning("Not a git repository — skipping auto-review hook");
    } else {
      p.log.warning("Existing pre-push hook found — auto-review not installed");
    }
  }

  // 8. Suggest playbook rules based on project analysis
  const api = createApiClient(apiUrl, apiKey);
  if (gitDir) {
    const suggestRules = await p.confirm({
      message: "Analyze project and suggest playbook rules?",
      initialValue: true,
    });
    if (!isCancel(suggestRules) && suggestRules) {
      spin.start("Analyzing project...");
      try {
        const suggestions = await analyzeProjectAndSuggestRules(cwd);
        spin.stop(`Found ${suggestions.length} rule suggestion(s)`);

        if (suggestions.length > 0) {
          const selected = await p.multiselect({
            message: "Select rules to add to your Playbook",
            options: suggestions.map((s, i) => ({
              value: i,
              label: s.title,
              hint: s.source,
            })),
            required: false,
          });

          if (!isCancel(selected) && Array.isArray(selected) && selected.length > 0) {
            let added = 0;
            for (const idx of selected) {
              const rule = suggestions[idx as number];
              try {
                await api.createPlaybookRule(rule.title, rule.content, rule.category);
                added++;
              } catch { /* skip on error */ }
            }
            p.log.success(`Added ${added} rule(s) to Playbook`);
          }
        }
      } catch (err) {
        spin.stop("Analysis failed");
        p.log.warning(`Could not analyze project: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 9. Optionally create first sprint
  const createSprint = await p.confirm({
    message: "Create and start the first sprint now?",
    initialValue: false,
  });
  if (!isCancel(createSprint) && createSprint) {
    spin.start("Starting sprint...");
    try {
      const result = await api.startSprint();
      spin.stop(`Sprint #${result.sprint.number} started (${result.tasks.length} task(s))`);
    } catch (err) {
      spin.stop("Could not start sprint");
      p.log.warning(`${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 10. Generate minimal CLAUDE.md
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const hasClaudeMd = existsSync(claudeMdPath);
  const generateClaudeMd = await p.confirm({
    message: hasClaudeMd ? "Regenerate CLAUDE.md? (existing file will be overwritten)" : "Generate CLAUDE.md for AI agents?",
    initialValue: !hasClaudeMd,
  });
  if (!isCancel(generateClaudeMd) && generateClaudeMd) {
    const claudeContent = [
      `# ${projectName}`,
      ``,
      `## Setup`,
      ``,
      `\`\`\`bash`,
      `# Get project context (spec, rules, sprint, knowledge)`,
      `toban context`,
      ``,
      `# Get specific sections`,
      `toban context spec       # Project spec`,
      `toban context rules      # Playbook rules`,
      `toban context sprint     # Current sprint tasks`,
      `toban context knowledge  # Shared team knowledge`,
      `toban context failures   # Past failures`,
      `\`\`\``,
      ``,
      `## API`,
      ``,
      `- URL: \`${apiUrl}\``,
      `- Auth: \`TOBAN_API_KEY\` env var`,
      ``,
      `## Commands`,
      ``,
      `- \`toban start\` — Start agent runner`,
      `- \`toban report "issue"\` — Report and triage an issue`,
      `- \`toban review --diff HEAD~1..HEAD\` — Review code changes`,
      `- \`toban task enrich <id>\` — Auto-detail a task`,
      ``,
    ].join("\n");
    writeFileSync(claudeMdPath, claudeContent);
    p.log.success("CLAUDE.md generated (slim — use `toban context` for dynamic data)");
  }

  p.outro("Done! Run `toban start` to begin.");
}
