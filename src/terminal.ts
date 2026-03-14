import os from "node:os";
import { execSync } from "node:child_process";
import fs from "node:fs";

export interface TerminalInfo {
  name: string;
  command: string;
  args: (shellCommand: string, cwd: string) => string[];
}

/** All known terminal definitions keyed by their preference ID. */
const TERMINAL_REGISTRY: Record<
  string,
  (platform: string) => TerminalInfo | null
> = {
  "terminal.app": (platform) =>
    platform === "darwin"
      ? {
          name: "Terminal.app",
          command: "osascript",
          args: (shellCommand, cwd) => [
            "-e",
            `tell application "Terminal"
        activate
        do script "cd ${escapeAppleScript(cwd)} && ${escapeAppleScript(shellCommand)}"
      end tell`,
          ],
        }
      : null,

  iterm2: (platform) =>
    platform === "darwin" && appExists("/Applications/iTerm.app")
      ? {
          name: "iTerm2",
          command: "osascript",
          args: (shellCommand, cwd) => [
            "-e",
            `tell application "iTerm"
          create window with default profile
          tell current session of current window
            write text "cd ${escapeAppleScript(cwd)} && ${escapeAppleScript(shellCommand)}"
          end tell
        end tell`,
          ],
        }
      : null,

  ghostty: (platform) =>
    platform === "darwin" && appExists("/Applications/Ghostty.app")
      ? {
          name: "Ghostty",
          command: "open",
          args: (shellCommand, cwd) => [
            "-a",
            "Ghostty",
            "--args",
            "-e",
            `cd ${quote(cwd)} && ${shellCommand}`,
          ],
        }
      : platform === "linux" && commandExists("ghostty")
        ? {
            name: "Ghostty",
            command: "ghostty",
            args: (shellCommand, cwd) => [
              "-e",
              `cd ${quote(cwd)} && ${shellCommand}`,
            ],
          }
        : null,

  powershell: (platform) =>
    platform === "win32"
      ? {
          name: "PowerShell",
          command: "powershell",
          args: (shellCommand, cwd) => [
            "-NoExit",
            "-Command",
            `Set-Location '${cwd}'; ${shellCommand}`,
          ],
        }
      : null,

  wt: (platform) =>
    platform === "win32" && commandExists("wt")
      ? {
          name: "Windows Terminal",
          command: "wt",
          args: (shellCommand, cwd) => [
            "-d",
            cwd,
            "cmd",
            "/c",
            shellCommand,
          ],
        }
      : null,

  alacritty: (platform) =>
    (platform === "linux" || platform === "darwin") &&
    commandExists("alacritty")
      ? {
          name: "Alacritty",
          command: "alacritty",
          args: (shellCommand, cwd) => [
            "--working-directory",
            cwd,
            "-e",
            "bash",
            "-c",
            shellCommand,
          ],
        }
      : null,

  kitty: (platform) =>
    (platform === "linux" || platform === "darwin") && commandExists("kitty")
      ? {
          name: "Kitty",
          command: "kitty",
          args: (shellCommand, cwd) => [
            "--directory",
            cwd,
            "bash",
            "-c",
            shellCommand,
          ],
        }
      : null,

  "gnome-terminal": (platform) =>
    platform === "linux" && commandExists("gnome-terminal")
      ? {
          name: "GNOME Terminal",
          command: "gnome-terminal",
          args: (shellCommand, cwd) => [
            "--working-directory",
            cwd,
            "--",
            "bash",
            "-c",
            shellCommand,
          ],
        }
      : null,

  konsole: (platform) =>
    platform === "linux" && commandExists("konsole")
      ? {
          name: "Konsole",
          command: "konsole",
          args: (shellCommand, cwd) => [
            "--workdir",
            cwd,
            "-e",
            "bash",
            "-c",
            shellCommand,
          ],
        }
      : null,

  "xfce4-terminal": (platform) =>
    platform === "linux" && commandExists("xfce4-terminal")
      ? {
          name: "XFCE Terminal",
          command: "xfce4-terminal",
          args: (shellCommand, cwd) => [
            "--working-directory",
            cwd,
            "-e",
            `bash -c '${shellCommand}'`,
          ],
        }
      : null,

  xterm: (platform) =>
    platform === "linux" && commandExists("xterm")
      ? {
          name: "xterm",
          command: "xterm",
          args: (shellCommand, cwd) => [
            "-e",
            `cd ${quote(cwd)} && ${shellCommand}`,
          ],
        }
      : null,
};

/** OS-default detection order: prioritizes OS standard terminals first. */
const OS_DEFAULT_ORDER: Record<string, string[]> = {
  darwin: ["terminal.app", "iterm2", "ghostty", "alacritty", "kitty"],
  win32: ["powershell", "wt"],
  linux: [
    "xterm",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "ghostty",
  ],
};

/**
 * Detect available terminal emulators on the current platform.
 * Returns the best available terminal, prioritizing OS standard terminals.
 */
export function detectTerminal(): TerminalInfo {
  const platform = os.platform();
  const order = OS_DEFAULT_ORDER[platform] ?? [];

  for (const id of order) {
    const factory = TERMINAL_REGISTRY[id];
    if (factory) {
      const info = factory(platform);
      if (info) return info;
    }
  }

  return {
    name: "direct",
    command: platform === "win32" ? "cmd" : "sh",
    args: (shellCommand, _cwd) =>
      platform === "win32"
        ? ["/c", shellCommand]
        : ["-c", shellCommand],
  };
}

/**
 * Get a terminal by preference string, falling back to OS default.
 * @param preference - Terminal preference key (e.g., "ghostty", "iterm2", "wt", "alacritty")
 * @returns The matching terminal info, or OS default if preference not found/available
 */
export function getTerminal(preference?: string): TerminalInfo {
  if (preference && preference !== "auto") {
    const platform = os.platform();
    const key = preference.toLowerCase();
    const factory = TERMINAL_REGISTRY[key];
    if (factory) {
      const info = factory(platform);
      if (info) return info;
    }
  }

  return detectTerminal();
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>NUL`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function appExists(appPath: string): boolean {
  try {
    return fs.existsSync(appPath);
  } catch {
    return false;
  }
}

/** Shell-quote a string (simple single-quote wrapping). */
function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Escape a string for embedding in AppleScript. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the full shell command string for an agent launch.
 */
export function buildShellCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>
): string {
  const envStr = Object.entries(env)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  const cmdStr = [cmd, ...args.map(quote)].join(" ");
  return envStr ? `${envStr} ${cmdStr}` : cmdStr;
}
