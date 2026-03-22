/**
 * PeerTracker — Tracks active agents' working files and distributes
 * peer info + channel messages to each agent's worktree.
 *
 * Writes two files to each worktree:
 *   .toban-peers.md    — Active peers and their modified files
 *   .toban-channel.md  — Recent agent channel messages
 *
 * Runs in the CLI run-loop (not in agents). No API communication.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { readRecentMessages, formatChannelMarkdown } from "./agent-channel.js";

const PEERS_FILE = ".toban-peers.md";
const CHANNEL_FILE = ".toban-channel.md";
const TOBAN_FILES = [PEERS_FILE, CHANNEL_FILE, ".toban-messages.md"];

export interface PeerInfo {
  /** Agent/slot name (e.g. "builder-1") */
  name: string;
  /** Task ID */
  taskId: string;
  /** Task title */
  taskTitle: string;
  /** Files currently being modified (from git diff) */
  files: string[];
  /** Worktree path (used internally, not written to peers file) */
  worktreePath: string;
}

export class PeerTracker {
  private peers: Map<string, PeerInfo> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastPeerSnapshots: Map<string, string> = new Map();
  private lastChannelSnapshot: string = "";
  /** Callback for WS broadcast when channel has new messages */
  onChannelMessage?: (messages: ReturnType<typeof readRecentMessages>) => void;

  /**
   * Register an active agent for tracking.
   */
  register(name: string, taskId: string, taskTitle: string, worktreePath: string): void {
    this.peers.set(name, { name, taskId, taskTitle, files: [], worktreePath });
    this.ensureGitignore(worktreePath);
    // Immediately refresh and publish so new agents get context
    this.refresh();
    this.publish();
  }

  /**
   * Unregister an agent (when it completes or fails).
   */
  unregister(name: string): void {
    this.peers.delete(name);
    this.lastPeerSnapshots.delete(name);
    this.publish();
  }

  /**
   * Start periodic tracking.
   */
  start(intervalMs: number = 15_000): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.refresh();
      this.publish();
    }, intervalMs);
  }

  /**
   * Stop tracking.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Get current peer info.
   */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Refresh file lists for all tracked agents by running git diff.
   */
  private refresh(): void {
    for (const [, peer] of this.peers) {
      try {
        if (!existsSync(peer.worktreePath)) continue;
        const diffOutput = execSync(
          "git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
          { cwd: peer.worktreePath, stdio: "pipe", timeout: 5_000 }
        ).toString().trim();
        const files = diffOutput
          ? [...new Set(diffOutput.split("\n").filter(Boolean))]
          : [];
        peer.files = files;
      } catch {
        // Non-fatal: worktree may have been removed
      }
    }
  }

  /**
   * Write .toban-peers.md and .toban-channel.md to each worktree.
   */
  private publish(): void {
    const peers = this.getPeers();
    if (peers.length === 0) return;

    // Read channel messages once
    const channelMessages = readRecentMessages(30);
    const channelContent = formatChannelMarkdown(channelMessages);
    const channelChanged = channelContent !== this.lastChannelSnapshot;
    if (channelChanged) {
      this.lastChannelSnapshot = channelContent;
      // Notify WS broadcast callback
      if (this.onChannelMessage) {
        this.onChannelMessage(channelMessages);
      }
    }

    for (const peer of peers) {
      try {
        // Peers file: exclude self
        const otherPeers = peers.filter((p) => p.name !== peer.name);
        const peersContent = this.buildPeersContent(otherPeers);

        if (peersContent !== this.lastPeerSnapshots.get(peer.name)) {
          writeFileSync(join(peer.worktreePath, PEERS_FILE), peersContent, "utf-8");
          this.lastPeerSnapshots.set(peer.name, peersContent);
        }

        // Channel file: same for all agents
        if (channelChanged) {
          writeFileSync(join(peer.worktreePath, CHANNEL_FILE), channelContent, "utf-8");
        }
      } catch {
        // Non-fatal: worktree may have been removed
      }
    }
  }

  /**
   * Ensure .toban-* files are in .gitignore to prevent accidental commits.
   */
  private ensureGitignore(worktreePath: string): void {
    try {
      const gitignorePath = join(worktreePath, ".gitignore");
      let content = "";
      if (existsSync(gitignorePath)) {
        content = readFileSync(gitignorePath, "utf-8");
      }
      const missing = TOBAN_FILES.filter((f) => !content.includes(f));
      if (missing.length > 0) {
        const addition = "\n# Toban agent files (auto-generated)\n" + missing.join("\n") + "\n";
        appendFileSync(gitignorePath, addition, "utf-8");
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Build peers markdown content.
   */
  private buildPeersContent(peers: PeerInfo[]): string {
    if (peers.length === 0) {
      return "# Active Peers\n\nNo other agents are currently running.\n";
    }

    const lines: string[] = [
      "# Active Peers",
      "",
      "Other agents currently working in this repository.",
      "Check their files before modifying shared code to avoid merge conflicts.",
      "",
    ];

    for (const peer of peers) {
      lines.push(`## ${peer.name}: ${peer.taskTitle}`);
      lines.push(`Task: ${peer.taskId.slice(0, 8)}`);
      if (peer.files.length > 0) {
        lines.push("Modified files:");
        for (const f of peer.files) {
          lines.push(`- ${f}`);
        }
      } else {
        lines.push("No files modified yet.");
      }
      lines.push("");
    }

    // File conflict summary
    const fileMap = new Map<string, string[]>();
    for (const peer of peers) {
      for (const f of peer.files) {
        const agents = fileMap.get(f) || [];
        agents.push(peer.name);
        fileMap.set(f, agents);
      }
    }
    const conflicts = Array.from(fileMap.entries()).filter(([, agents]) => agents.length > 1);
    if (conflicts.length > 0) {
      lines.push("## WARNING: Potential File Conflicts");
      lines.push("");
      for (const [file, agents] of conflicts) {
        lines.push(`- ${file} — modified by: ${agents.join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
