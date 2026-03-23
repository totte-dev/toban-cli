/**
 * Profile management — save/load API credentials to ~/.toban/profiles/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { createApiClient } from "../api-client.js";

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

/** Load the active profile's credentials. Returns null if no profile saved. */
export function loadActiveProfile(): Profile | null {
  return loadProfile(getActiveProfileName());
}

/** Interactive login: save API key to profile. */
export async function handleLogin(apiUrl?: string, apiKey?: string): Promise<void> {
  p.intro("toban login");

  const url = apiUrl || (await p.text({
    message: "API URL",
    placeholder: "http://localhost:8787",
    initialValue: "http://localhost:8787",
  }) as string);
  if (p.isCancel(url)) { p.cancel("Cancelled"); process.exit(0); }

  const key = apiKey || (await p.text({
    message: "API Key",
    placeholder: "tb_...",
  }) as string);
  if (p.isCancel(key)) { p.cancel("Cancelled"); process.exit(0); }

  // Validate
  const s = p.spinner();
  s.start("Validating...");
  try {
    const api = createApiClient(url, key);
    const ws = await api.fetchWorkspace();
    s.stop(`Connected to workspace: ${ws.name}`);

    const profileName = ws.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "default";
    saveProfile({
      name: profileName,
      api_url: url,
      api_key: key,
      workspace_id: ws.id,
      workspace_name: ws.name,
    });
    setActiveProfile(profileName);
    p.outro(`Saved profile "${profileName}". You can now run \`toban start\` without --api-key.`);
  } catch (err) {
    s.stop("Failed");
    p.cancel(`Invalid credentials: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
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

  if (sub === "use") {
    // handled by caller with the name arg
    return;
  }

  // Default: show active profile
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
