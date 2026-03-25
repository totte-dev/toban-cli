/**
 * CLI startup — workspace initialization, Manager setup, WS server.
 * Extracted from cli.ts to keep the entrypoint lean.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectInstallCommand } from "./utils/detect-package-manager.js";
import type { AgentRunner } from "./agents/runner.js";
import type { AgentType } from "./types.js";
import {
  createApiClient,
  type ApiClient,
  type SprintStartResult,
  type WorkspaceRepository,
} from "./services/api-client.js";
import { Manager } from "./manager/manager.js";
import { WsChatServer } from "./channel/ws-server.js";
import { WS_MSG } from "./channel/ws-types.js";
import {
  setupGitCredentialHelper,
  ensureAgentRepo,
  cleanRepoAuth,
  fetchAndResetToRemote,
  executeRevert,
} from "./services/git-ops.js";
import * as ui from "./ui.js";

export interface CliArgs {
  command: string;
  apiUrl: string;
  apiKey: string;
  workingDir: string;
  explicitWorkingDir: boolean;
  agentName: string;
  baseBranch: string;
  model: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  noDocker: boolean;
  wsPort: number;
  debug: boolean;
  engine: AgentType;
  autoTag: boolean;
  autoMode: boolean;
  maxSprints?: number;
  maxHours?: number;
}

/** All state produced by the setup phase, consumed by the main loop */
export interface SetupResult {
  api: ApiClient;
  mgr: Manager;
  wsServer: WsChatServer | null;
  wsPort: number | undefined;
  workingDir: string;
  tobanHome: string;
  repos: WorkspaceRepository[];
  gitToken: string | undefined;
  gitUserInfo: { name: string; email: string } | undefined;
  credentialHelperPath: string | undefined;
  sprintData: SprintStartResult;
  workspaceName: string | undefined;
  workspaceSpec: string | undefined;
  language: string | undefined;
  mainGithubRepo: string | undefined;
}

export async function setup(cliArgs: CliArgs, runner: AgentRunner): Promise<SetupResult> {
  const api = createApiClient(cliArgs.apiUrl, cliArgs.apiKey);

  ui.setDebug(cliArgs.debug);
  ui.intro();

  const s = ui.createSpinner();

  // --- Authenticate ---
  s.start("Authenticating...");
  await api.updateAgent({ name: cliArgs.agentName, status: "online", activity: "Starting up" });
  s.stop("Authenticated");

  // --- Workspace ---
  let workingDir = cliArgs.workingDir;
  let workspaceSpec: string | undefined;
  let workspaceName: string | undefined;
  let mainGithubRepo: string | undefined;
  let wsLanguage: string | undefined;
  let gitUserInfo: { name: string; email: string } | undefined;

  s.start("Fetching workspace...");
  try {
    const ws = await api.fetchWorkspace();
    workspaceSpec = (ws as unknown as Record<string, unknown>).spec as string | undefined || undefined;
    workspaceName = ws.name || undefined;
    mainGithubRepo = ws.github_repo || undefined;
    wsLanguage = ws.language || undefined;
    if (ws.github_login) {
      gitUserInfo = { name: ws.github_login, email: `${ws.github_login}@users.noreply.github.com` };
    }
    s.stop(workspaceName ? `Workspace: ${workspaceName}` : "Workspace loaded");

    if (!cliArgs.explicitWorkingDir && ws.github_repo) {
      const tobanHome = join(homedir(), ".toban");
      const repoDir = join(tobanHome, ws.id);
      const gitCreds = await api.fetchGitToken();

      if (existsSync(join(repoDir, ".git"))) {
        s.start(`Pulling latest for ${ws.github_repo}...`);
        try {
          fetchAndResetToRemote(repoDir);
          s.stop(`Repo updated: ${ws.github_repo}`);
        } catch (pullErr) {
          s.stop(`Repo: ${ws.github_repo} (pull failed, using existing)`);
          ui.warn(`git pull failed: ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`);
        }
      } else {
        s.start(`Cloning ${ws.github_repo}...`);
        mkdirSync(tobanHome, { recursive: true });
        let cloneUrl: string;
        if (gitCreds?.token) {
          const repoPath = ws.github_repo.replace(/^https?:\/\/github\.com\//, "");
          cloneUrl = `https://x-access-token:${gitCreds.token}@github.com/${repoPath}.git`;
        } else {
          const repoUrl = ws.github_repo.startsWith("https://") ? ws.github_repo : `https://github.com/${ws.github_repo}`;
          cloneUrl = `${repoUrl}.git`;
        }
        execSync(`git clone ${cloneUrl} "${repoDir}"`, { stdio: "pipe" });
        s.stop(`Repo cloned: ${ws.github_repo}`);
      }
      workingDir = repoDir;
      // Install dependencies in main repo + api subdirectory (skip if node_modules exists)
      for (const dir of [repoDir, join(repoDir, "api")]) {
        if (!existsSync(join(dir, "package.json"))) continue;
        if (existsSync(join(dir, "node_modules"))) continue;
        const installCmd = detectInstallCommand(dir);
        if (installCmd) {
          try {
            execSync(`${installCmd} --silent`, { cwd: dir, stdio: "pipe", timeout: 120_000 });
          } catch { ui.warn(`Could not install deps in ${dir}`); }
        }
      }
      ui.workspaceInfo(undefined, workingDir, true);
    } else {
      ui.workspaceInfo(undefined, workingDir);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    s.stop("Workspace fetch failed");
    ui.warn(`Using working dir: ${workingDir}`);
    const isGitError = ["clone", "pull", "not found", "authentication", "fatal:", "Could not resolve host"].some(k => errMsg.includes(k));
    if (isGitError) {
      await api.sendMessage("manager", "user", `Failed to set up repository.\n\nError: ${errMsg.slice(0, 200)}`);
    }
  }

  // --- Sprint ---
  // Use fetchSprintData (GET) instead of startSprint (POST) to avoid
  // auto-transitioning planning → active on CLI connect
  let sprintData: SprintStartResult;
  try {
    sprintData = await api.fetchSprintData();
    ui.sprintInfo(sprintData.sprint.number, sprintData.agents.length, sprintData.tasks.length);
  } catch (err) {
    ui.error(`Failed to fetch sprint: ${err}`);
    await api.updateAgent({ name: cliArgs.agentName, status: "error", activity: `No active sprint: ${err}` });
    process.exit(1);
  }

  // --- Repositories + Git credentials ---
  let repos: WorkspaceRepository[] = [];
  try {
    repos = await api.fetchRepositories();
    if (repos.length > 0) ui.info(`${repos.length} workspace repositor${repos.length === 1 ? "y" : "ies"} found`);
  } catch (err) { ui.warn(`Could not fetch repositories: ${err}`); }

  let gitToken: string | undefined;
  try { const creds = await api.fetchGitToken(); if (creds?.token) gitToken = creds.token; }
  catch { /* Non-fatal */ }

  const tobanHome = join(homedir(), ".toban");
  mkdirSync(tobanHome, { recursive: true });

  let credentialHelperPath: string | undefined;
  if (gitToken) {
    credentialHelperPath = setupGitCredentialHelper(tobanHome, cliArgs.apiUrl, cliArgs.apiKey);
    ui.debug("git", `Credential helper: ${credentialHelperPath}`);
    if (existsSync(join(workingDir, ".git"))) {
      try { cleanRepoAuth(workingDir, credentialHelperPath); } catch { /* non-fatal */ }
      // Set git user on workspace clone (used by agent worktrees)
      if (gitUserInfo) {
        try {
          execSync(`git config user.name "${gitUserInfo.name}"`, { cwd: workingDir, stdio: "pipe" });
          execSync(`git config user.email "${gitUserInfo.email}"`, { cwd: workingDir, stdio: "pipe" });
        } catch { /* non-fatal */ }
      }
    }
  }

  // --- Manager repos (read-only access to all repos) ---
  let managerReposDir: string | undefined;
  const managerRepoInfos: Array<{ name: string; path: string; description?: string }> = [];
  {
    const allRepos: WorkspaceRepository[] = [...repos];
    if (mainGithubRepo) {
      const mainRepoName = mainGithubRepo.replace(/^https?:\/\/github\.com\//, "");
      if (!allRepos.some((r) => r.repo_name === mainRepoName || r.repo_path.includes(mainRepoName))) {
        allRepos.unshift({
          id: "main", repo_name: mainRepoName,
          repo_path: mainGithubRepo.startsWith("http") ? mainGithubRepo : `https://github.com/${mainGithubRepo}`,
          repo_url: "", description: "Main repository", access_agents: [],
        });
      }
    }
    if (allRepos.length > 0) {
      const reposParent = join(tobanHome, "manager-repos");
      mkdirSync(reposParent, { recursive: true });
      for (const repo of allRepos) {
        try {
          const repoPath = ensureAgentRepo(reposParent, "shared", repo, gitToken, gitUserInfo, credentialHelperPath);
          // Install dependencies (required for verify_build, skip if already installed)
          for (const dir of [repoPath, join(repoPath, "api")]) {
            if (!existsSync(join(dir, "package.json"))) continue;
            if (existsSync(join(dir, "node_modules"))) continue;
            const cmd = detectInstallCommand(dir);
            if (cmd) {
              try {
                execSync(`${cmd} --silent`, { cwd: dir, stdio: "pipe", timeout: 120_000 });
              } catch { ui.warn(`Could not install deps in ${dir}`); }
            }
          }
          managerRepoInfos.push({ name: repo.repo_name, path: repoPath, description: repo.description || undefined });
        } catch (err) { ui.warn(`Could not clone ${repo.repo_name} for Manager: ${err}`); }
      }
      if (managerRepoInfos.length > 0) {
        managerReposDir = join(reposParent, "shared");
        ui.step(`Manager has read access to ${managerRepoInfos.length} repo(s)`);
      }
    }
  }

  // --- Manager ---
  const mgr = new Manager({
    apiUrl: cliArgs.apiUrl, apiKey: cliArgs.apiKey,
    llmBaseUrl: cliArgs.llmBaseUrl, llmApiKey: cliArgs.llmApiKey,
    model: cliArgs.model, runner, api,
    reposDir: managerReposDir, repositories: managerRepoInfos,
  });

  // Manager LLM deprecated — task dispatch is handled by run-loop directly

  // --- WebSocket server ---
  let wsServer: WsChatServer | null = null;
  let actualWsPort: number | undefined;
  try {
    wsServer = new WsChatServer({
      port: cliArgs.wsPort, apiKey: cliArgs.apiKey, apiUrl: cliArgs.apiUrl,
      onMessage: async (content) => mgr.handleWsMessage(content),
      onRevert: async (taskId, repoName, commits) => executeRevert(repoName, commits, repos),
    });
    actualWsPort = await wsServer.start();
    await wsServer.registerPort();

    mgr.onReply = (reply) => { wsServer?.broadcast({ type: WS_MSG.CHAT, from: "manager", to: "user", content: reply, timestamp: new Date().toISOString() }); };
    mgr.onActivityChange = (activity) => { wsServer?.broadcast({ type: WS_MSG.STATUS, from: "manager", content: activity, timestamp: new Date().toISOString() }); };
    mgr.onDataUpdate = (entity, id, changes) => { wsServer?.broadcast({ type: WS_MSG.DATA_UPDATE, entity, task_id: id, agent_name: entity === "agent" ? id : undefined, changes, timestamp: new Date().toISOString() }); };
  } catch (err) { ui.warn(`WebSocket server failed to start: ${err}`); }

  // Manager LLM polling disabled — run-loop handles task dispatch directly
  mgr.startHeartbeat();

  ui.connectionInfo({
    apiUrl: cliArgs.apiUrl, agent: cliArgs.agentName, branch: cliArgs.baseBranch,
    docker: !cliArgs.noDocker, wsPort: actualWsPort, llmProvider: cliArgs.llmBaseUrl || "Claude Code CLI",
  });

  return {
    api, mgr, wsServer, wsPort: actualWsPort, workingDir, tobanHome,
    repos, gitToken, gitUserInfo, credentialHelperPath, sprintData: sprintData!,
    workspaceName, workspaceSpec, language: wsLanguage,
    mainGithubRepo,
  };
}
