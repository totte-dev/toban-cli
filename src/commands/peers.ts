/**
 * `toban peers` — Show active peer agents and their working files.
 *
 * Reads .toban-peers.md from the current working directory (written by PeerTracker).
 * No API communication — purely local file-based.
 *
 * Usage (called by agents via Bash tool):
 *   toban peers           # Show all peers and their files
 *   toban peers files     # Show file-centric conflict view
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PEERS_FILE = ".toban-peers.md";

export async function handlePeers(subcommand?: string): Promise<void> {
  const cwd = process.cwd();
  const filePath = join(cwd, PEERS_FILE);

  if (!existsSync(filePath)) {
    console.log("No peer information available. (Are you running inside a toban agent session?)");
    return;
  }

  const content = readFileSync(filePath, "utf-8");

  if (subcommand === "files") {
    // Extract and display file-centric view
    printFilesView(content);
  } else {
    // Default: print the full peers file
    console.log(content);
  }
}

/**
 * Parse .toban-peers.md and display a file-centric view.
 */
function printFilesView(content: string): void {
  // Parse agent sections
  const agentRegex = /^## (.+?): (.+)$/gm;
  const fileRegex = /^- (.+)$/gm;

  const fileMap = new Map<string, string[]>();
  let currentAgent: string | null = null;

  for (const line of content.split("\n")) {
    const agentMatch = line.match(/^## (.+?): /);
    if (agentMatch) {
      currentAgent = agentMatch[1];
      continue;
    }
    if (line.startsWith("# ") || line.startsWith("Task:") || line === "") continue;
    if (line.startsWith("- ") && currentAgent && !line.includes("modified by:")) {
      const file = line.slice(2);
      const agents = fileMap.get(file) || [];
      agents.push(currentAgent);
      fileMap.set(file, agents);
    }
  }

  if (fileMap.size === 0) {
    console.log("No files are currently being modified by other agents.");
    return;
  }

  console.log("# Files Being Modified by Peers\n");

  // Show conflicts first
  const conflicts: [string, string[]][] = [];
  const normal: [string, string[]][] = [];

  for (const [file, agents] of fileMap) {
    if (agents.length > 1) {
      conflicts.push([file, agents]);
    } else {
      normal.push([file, agents]);
    }
  }

  if (conflicts.length > 0) {
    console.log("## CONFLICTS (multiple agents editing same file)\n");
    for (const [file, agents] of conflicts) {
      console.log(`  ${file} — ${agents.join(", ")}`);
    }
    console.log("");
  }

  for (const [file, agents] of normal) {
    console.log(`  ${file} — ${agents[0]}`);
  }
}
