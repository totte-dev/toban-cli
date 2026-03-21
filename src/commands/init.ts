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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createApiClient, type WorkspaceInfo } from "../api-client.js";

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

  // 7. Optionally create first sprint
  const createSprint = await p.confirm({
    message: "Create and start the first sprint now?",
    initialValue: false,
  });
  if (!isCancel(createSprint) && createSprint) {
    const api = createApiClient(apiUrl, apiKey);
    spin.start("Starting sprint...");
    try {
      const result = await api.startSprint();
      spin.stop(`Sprint #${result.sprint.number} started (${result.tasks.length} task(s))`);
    } catch (err) {
      spin.stop("Could not start sprint");
      p.log.warning(`${err instanceof Error ? err.message : String(err)}`);
    }
  }

  p.outro("Done! Run `toban start` to begin.");
}
