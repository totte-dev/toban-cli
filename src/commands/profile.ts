/**
 * Profile management — save/load API credentials to ~/.toban/profiles/
 * Login uses Toban's CLI auth flow (device-flow style):
 *   1. POST /auth/cli/start → cli_code + auth_url
 *   2. User opens auth_url in browser → GitHub OAuth → workspace select
 *   3. CLI polls /auth/cli/poll → receives api_key + workspace info
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { createApiClient } from "../services/api-client.js";

const TOBAN_HOME = join(homedir(), ".toban");
const PROFILES_DIR = join(TOBAN_HOME, "profiles");
const ACTIVE_FILE = join(TOBAN_HOME, "active_profile");

export interface Profile {
  name: string;
  api_url: string;
  api_key: string;
  workspace_id?: string;
  workspace_name?: string;
}

function ensureDir(): void {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });
}

function profilePath(name: string): string {
  return join(PROFILES_DIR, `${name}.json`);
}

export function saveProfile(profile: Profile): void {
  ensureDir();
  writeFileSync(profilePath(profile.name), JSON.stringify(profile, null, 2));
}

export function loadProfile(name: string): Profile | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Profile;
  } catch {
    return null;
  }
}

export function listProfiles(): string[] {
  ensureDir();
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

export function getActiveProfileName(): string {
  if (existsSync(ACTIVE_FILE)) {
    const name = readFileSync(ACTIVE_FILE, "utf-8").trim();
    if (name) return name;
  }
  return "default";
}

export function setActiveProfile(name: string): void {
  ensureDir();
  writeFileSync(ACTIVE_FILE, name);
}

export function loadActiveProfile(): Profile | null {
  return loadProfile(getActiveProfileName());
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open ${JSON.stringify(url)}`, { stdio: "ignore" });
    else if (platform === "win32") execSync(`start "" ${JSON.stringify(url)}`, { stdio: "ignore" });
    else execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: "ignore" });
  } catch { /* non-fatal */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Interactive login via device-flow style auth. */
export async function handleLogin(apiUrl?: string): Promise<void> {
  p.intro("toban login");

  const url = apiUrl || (await p.text({
    message: "Toban API URL",
    placeholder: "http://localhost:8787",
    initialValue: "http://localhost:8787",
  }) as string);
  if (p.isCancel(url)) { p.cancel("Cancelled"); process.exit(0); }

  const s = p.spinner();

  // Step 1: Start CLI auth session
  s.start("Starting authentication...");
  let cliCode: string;
  let pollToken: string;
  let authUrl: string;
  try {
    const res = await fetch(`${url}/api/auth/cli/start`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { cli_code: string; poll_token: string; auth_url: string };
    cliCode = data.cli_code;
    pollToken = data.poll_token;
    authUrl = data.auth_url;
    s.stop(`Auth code: ${cliCode}`);
  } catch (err) {
    s.stop("Failed to start auth");
    p.cancel(`Could not reach ${url}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Step 2: Open browser
  p.note(`Open this URL in your browser:\n\n  ${authUrl}\n\nOr enter the code manually: ${cliCode}`);
  openBrowser(authUrl);

  // Step 3: Poll for completion
  s.start("Waiting for browser authorization...");
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min timeout
  let apiKey: string | null = null;
  let wsId: string | null = null;
  let wsName: string | null = null;

  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const res = await fetch(`${url}/api/auth/cli/poll?poll_token=${pollToken}`);
      if (!res.ok) continue;
      const data = await res.json() as { status: string; api_key?: string; workspace_id?: string; workspace_name?: string };
      if (data.status === "completed" && data.api_key) {
        apiKey = data.api_key;
        wsId = data.workspace_id ?? null;
        wsName = data.workspace_name ?? null;
        break;
      }
      if (data.status === "expired") {
        s.stop("Auth session expired");
        p.cancel("Session expired. Please try again.");
        process.exit(1);
      }
    } catch { /* retry */ }
  }

  if (!apiKey) {
    s.stop("Timed out");
    p.cancel("Authentication timed out after 5 minutes.");
    process.exit(1);
  }

  s.stop(`Authenticated: ${wsName || "workspace"}`);

  // Step 4: Save profile
  const profileName = (wsName || "default").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  saveProfile({
    name: profileName,
    api_url: url,
    api_key: apiKey,
    workspace_id: wsId ?? undefined,
    workspace_name: wsName ?? undefined,
  });
  setActiveProfile(profileName);

  p.outro(`Saved profile "${profileName}". You can now run \`toban start\` without --api-key.`);
}

/** Show current profile info. */
export function handleProfile(sub?: string): void {
  if (sub === "list") {
    const profiles = listProfiles();
    const active = getActiveProfileName();
    if (profiles.length === 0) {
      console.log("No profiles. Run `toban login` to create one.");
      return;
    }
    for (const name of profiles) {
      const marker = name === active ? " (active)" : "";
      const profile = loadProfile(name);
      console.log(`  ${name}${marker} — ${profile?.api_url ?? "?"} (${profile?.workspace_name ?? "?"})`);
    }
    return;
  }

  if (sub === "use") return; // handled by caller

  const active = getActiveProfileName();
  const profile = loadProfile(active);
  if (!profile) {
    console.log("No active profile. Run `toban login` to set up.");
    return;
  }
  console.log(`Profile: ${profile.name}`);
  console.log(`  API URL: ${profile.api_url}`);
  console.log(`  Workspace: ${profile.workspace_name ?? "?"} (${profile.workspace_id?.slice(0, 8) ?? "?"})`);
  console.log(`  API Key: ${profile.api_key.slice(0, 12)}...`);
}
