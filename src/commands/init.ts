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

  // 2. API Key
  const apiKey = await p.text({
    message: "API key",
    placeholder: "tb_xxx",
    validate: (v) => {
      if (!v) return "API key is required";
      if (!v.startsWith("tb_")) return "API key must start with tb_";
    },
  });
  if (isCancel(apiKey)) { p.outro("Cancelled."); return; }

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
