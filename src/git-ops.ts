/**
 * Git operations — credential management, repo cloning/updating, revert.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRepository } from "./api-client.js";
import * as ui from "./ui.js";

/**
 * Resolve the git repo root from a working directory (handles worktrees).
 * Falls back to the given directory if resolution fails.
 */
export function resolveRepoRoot(workingDir: string): string {
  if (!existsSync(workingDir)) return workingDir;
  try {
    return execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: workingDir, stdio: "pipe" })
      .toString().trim().replace(/\/.git$/, "");
  } catch {
    return workingDir;
  }
}

/**
 * Create a git credential helper script that fetches fresh tokens from the Toban API.
 * GitHub App installation tokens expire after 1 hour, so we need to refresh on each git operation.
 */
export function setupGitCredentialHelper(tobanHome: string, apiUrl: string, apiKey: string): string {
  const helperPath = join(tobanHome, "git-credential-helper.sh");
  const cachePath = join(tobanHome, ".git-token-cache");
  const script = `#!/bin/sh
# Toban git credential helper — fetches fresh GitHub App token on demand
# Supports multi-org: extracts repo path from git input, requests per-repo token
if [ "$1" = "get" ]; then
  # Read git credential input to extract host and path
  REPO_PATH=""
  while IFS= read -r line; do
    case "$line" in
      path=*) REPO_PATH="\${line#path=}" ;;
      "") break ;;
    esac
  done
  # Strip .git suffix if present
  REPO_PATH="\${REPO_PATH%.git}"

  # Use repo-specific cache file
  CACHE_KEY=$(echo "$REPO_PATH" | tr '/' '_')
  CACHE_FILE="${cachePath}-\${CACHE_KEY:-default}"
  CACHE_MAX_AGE=3000
  if [ -f "$CACHE_FILE" ]; then
    CACHE_AGE=$(( $(date +%s) - $(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
    if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
      cat "$CACHE_FILE"
      exit 0
    fi
  fi
  # Fetch token, optionally scoped to repo
  TOKEN_URL="${apiUrl}/api/v1/workspace/git-token"
  if [ -n "$REPO_PATH" ]; then
    TOKEN_URL="\${TOKEN_URL}?repo=\${REPO_PATH}"
  fi
  TOKEN=$(curl -sf -H "Authorization: Bearer ${apiKey}" "$TOKEN_URL" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
  if [ -n "$TOKEN" ]; then
    OUTPUT="protocol=https
host=github.com
username=x-access-token
password=$TOKEN"
    echo "$OUTPUT" > "$CACHE_FILE"
    chmod 600 "$CACHE_FILE"
    echo "$OUTPUT"
  fi
fi
`;
  writeFileSync(helperPath, script, { mode: 0o700 });
  return helperPath;
}

/**
 * Clean up stale token-embedded URLs and reset credential helper on a repo.
 */
export function cleanRepoAuth(repoDir: string, credentialHelperPath?: string): void {
  // Clean up stale token-embedded URLs
  try {
    const remoteUrl = execSync("git remote get-url origin", { cwd: repoDir, stdio: "pipe" }).toString().trim();
    if (remoteUrl.includes("x-access-token")) {
      const cleanPath = remoteUrl.replace(/https:\/\/x-access-token:[^@]+@github\.com\//, "").replace(/\.git$/, "");
      execSync(`git remote set-url origin "https://github.com/${cleanPath}.git"`, { cwd: repoDir, stdio: "pipe" });
    }
  } catch { /* non-fatal */ }

  // Reset credential helper
  if (credentialHelperPath) {
    try { execSync("git config --unset-all credential.helper", { cwd: repoDir, stdio: "pipe" }); } catch { /* may not exist */ }
    try {
      execSync(`git config --add credential.helper ""`, { cwd: repoDir, stdio: "pipe" });
      execSync(`git config --add credential.helper "${credentialHelperPath}"`, { cwd: repoDir, stdio: "pipe" });
    } catch { /* non-fatal */ }
  }
}

/**
 * Fetch and reset a repo to match remote main (handles diverged branches).
 */
export function fetchAndResetToRemote(repoDir: string): void {
  execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });

  // Check if remote has any branches (empty repo has none)
  const remoteBranches = execSync("git branch -r", { cwd: repoDir, stdio: "pipe" }).toString().trim();
  if (!remoteBranches) {
    // Empty repo — create initial branch with empty commit
    try {
      execSync("git checkout -b main", { cwd: repoDir, stdio: "pipe" });
    } catch { /* already on main */ }
    execSync('git commit --allow-empty -m "Initial commit"', { cwd: repoDir, stdio: "pipe" });
    return;
  }

  execSync("git checkout main 2>/dev/null || git checkout master", {
    cwd: repoDir, stdio: "pipe", shell: "/bin/sh",
  });
  try {
    execSync("git pull --ff-only", { cwd: repoDir, stdio: "pipe" });
  } catch {
    execSync("git reset --hard origin/main 2>/dev/null || git reset --hard origin/master", {
      cwd: repoDir, stdio: "pipe", shell: "/bin/sh",
    });
  }
}

/**
 * Ensure a repository is cloned/updated for the given agent.
 * Returns the path to the repo working directory.
 */
export function ensureAgentRepo(
  tobanHome: string,
  agentName: string,
  repo: WorkspaceRepository,
  gitToken?: string,
  gitUser?: { name: string; email: string },
  credentialHelperPath?: string
): string {
  const agentDir = join(tobanHome, agentName);
  const repoDir = join(agentDir, repo.repo_name);

  mkdirSync(agentDir, { recursive: true });

  if (existsSync(join(repoDir, ".git"))) {
    ui.info(`Updating ${repo.repo_name} for ${agentName}`);
    cleanRepoAuth(repoDir, credentialHelperPath);
    try {
      fetchAndResetToRemote(repoDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ui.warn(`git update failed for ${repo.repo_name}: ${msg}`);
    }
  } else {
    // Clone the repo — use token for initial clone only
    let cloneUrl = repo.repo_url || repo.repo_path;
    if (gitToken && cloneUrl.includes("github.com")) {
      const repoPath = cloneUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
      cloneUrl = `https://x-access-token:${gitToken}@github.com/${repoPath}.git`;
      ui.info(`Cloning ${repo.repo_name} (authenticated)`);
    } else if (!cloneUrl.startsWith("http") && !cloneUrl.startsWith("git@")) {
      cloneUrl = gitToken
        ? `https://x-access-token:${gitToken}@github.com/${cloneUrl}.git`
        : `https://github.com/${cloneUrl}.git`;
      ui.info(`Cloning ${repo.repo_name}`);
    } else {
      ui.info(`Cloning ${repo.repo_name}`);
    }

    execSync(`git clone "${cloneUrl}" "${repoDir}"`, { stdio: "pipe" });

    // Replace token-embedded URL with clean URL
    try {
      const cleanUrl = (repo.repo_url || repo.repo_path).replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
      execSync(`git remote set-url origin "https://github.com/${cleanUrl}.git"`, { cwd: repoDir, stdio: "pipe" });
    } catch { /* non-fatal */ }
  }

  // Configure credential helper
  cleanRepoAuth(repoDir, credentialHelperPath);

  // Set git user from GitHub App login
  if (gitUser) {
    try {
      execSync(`git config user.name "${gitUser.name}"`, { cwd: repoDir, stdio: "pipe" });
      execSync(`git config user.email "${gitUser.email}"`, { cwd: repoDir, stdio: "pipe" });
    } catch { /* non-fatal */ }
  }

  return repoDir;
}

/**
 * Resolve the working directory for a task.
 */
export function resolveTaskWorkingDir(
  task: { target_repo?: string | null },
  repos: WorkspaceRepository[],
  tobanHome: string,
  agentName: string,
  defaultWorkingDir: string,
  gitToken?: string,
  gitUser?: { name: string; email: string },
  credHelper?: string,
  mainRepo?: string | null
): string {
  if (!task.target_repo) {
    // Prefer workspace's main repo (github_repo), then first registered repo
    const preferred = mainRepo
      ? repos.find((r) => r.repo_name === mainRepo || r.repo_path.includes(mainRepo))
      : null;
    const fallback = preferred || repos[0];
    if (fallback) {
      try {
        return ensureAgentRepo(tobanHome, agentName, fallback, gitToken, gitUser, credHelper);
      } catch (err) {
        ui.warn(`Failed to setup default repo ${fallback.repo_name}: ${err}`);
      }
    }
    return defaultWorkingDir;
  }

  const repo = repos.find(
    (r) => r.repo_name === task.target_repo || r.id === task.target_repo
  );
  if (!repo) {
    ui.warn(`target_repo "${task.target_repo}" not found, using default`);
    return defaultWorkingDir;
  }

  try {
    return ensureAgentRepo(tobanHome, agentName, repo, gitToken, gitUser, credHelper);
  } catch (err) {
    ui.error(`Failed to setup repo ${repo.repo_name}: ${err}`);
    return defaultWorkingDir;
  }
}

/**
 * Execute git revert for given commits in the appropriate repo directory.
 */
export async function executeRevert(
  repoName: string,
  commits: string[],
  repos: WorkspaceRepository[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const repo = repos.find((r) => r.repo_name === repoName);
    const repoPath = repo?.repo_path;
    if (!repoPath || !existsSync(repoPath)) {
      return { ok: false, error: `Repository path not found for "${repoName}"` };
    }

    const reversed = [...commits].reverse();
    for (const hash of reversed) {
      ui.info(`[revert] Reverting ${hash.slice(0, 7)} in ${repoName}`);
      execSync(`git revert --no-edit ${hash}`, { cwd: repoPath, stdio: "pipe" });
    }

    ui.info(`[revert] Pushing reverts for ${repoName}`);
    execSync("git push origin HEAD", { cwd: repoPath, stdio: "pipe" });

    ui.step(`[revert] Successfully reverted ${commits.length} commit(s) in ${repoName}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ui.warn(`[revert] Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
