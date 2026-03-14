# @toban/cli

Toban Agent Runner CLI - Orchestrate AI coding agents from your terminal.

## Installation

```bash
npm install -g @toban/cli
```

## Usage

```bash
# Set up credentials
export TOBAN_API_URL=https://your-toban-instance.example.com
export TOBAN_API_KEY=tb_wsXXX_sk_XXX

# Start the agent runner
toban start

# Or pass credentials directly
toban start --api-url https://... --api-key tb_...
```

## Options

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--api-url <url>` | `TOBAN_API_URL` | Toban API base URL |
| `--api-key <key>` | `TOBAN_API_KEY` | API key for authentication |
| `--working-dir <dir>` | | Repository root (default: cwd) |
| `--agent-name <name>` | | Agent name for status reporting |
| `--branch <branch>` | | Base branch (default: main) |

## How It Works

1. Connects to the Toban API and starts the current sprint
2. Fetches assigned tasks sorted by priority
3. For each task, spawns a Claude Code agent in an isolated git worktree
4. Reports progress and status back to the API
5. Auto-merges completed branches

## Terminal Selection

The CLI detects and uses the best available terminal emulator on your system:

- **macOS**: Terminal.app (default) > iTerm2 > Ghostty
- **Windows**: PowerShell (default) > Windows Terminal
- **Linux**: xterm (default) > GNOME Terminal > Konsole > others

Configure your preferred terminal in Toban workspace settings.

## Development

```bash
npm install
npm run build
npm run dev -- start --api-url ... --api-key ...
```
