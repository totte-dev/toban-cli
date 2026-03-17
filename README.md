# toban-cli

Orchestrate AI coding agents from your terminal. Toban CLI connects to your [Toban](https://toban.dev) workspace, fetches sprint tasks, and runs Claude Code agents in isolated git worktrees -- fully automated.

## Quick Start

```bash
# 1. Install Claude Code CLI (the agent engine)
npm install -g @anthropic-ai/claude-code

# 2. Run from the Sprint page -- click "$ run" to copy the command
npx toban-cli@latest start --api-url <URL> --api-key <KEY>

# 3. Agents pick up tasks and start coding
```

No global install needed. `npx` downloads and runs the latest version.

## What It Does

- Connects to the Toban API and starts the current sprint
- Spawns Claude Code agents in isolated git worktrees (one per task)
- Streams agent activity (tool use, file edits, commands) to the dashboard in real-time
- Auto-merges completed branches and pushes to the remote
- Runs a Manager LLM that coordinates sprint planning and agent orchestration

## Requirements

- **Node.js 20+**
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** installed globally
- A Toban workspace with an API key (get one at [toban.dev](https://toban.dev))

## Usage

```bash
# Using command-line flags
npx toban-cli@latest start --api-url https://api.toban.example.com --api-key tb_...

# Using environment variables
export TOBAN_API_URL=https://api.toban.example.com
export TOBAN_API_KEY=tb_wsXXX_sk_XXX
npx toban-cli@latest start
```

## Options

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--api-url <url>` | `TOBAN_API_URL` | Toban API base URL |
| `--api-key <key>` | `TOBAN_API_KEY` | API key for authentication |
| `--working-dir <dir>` | | Repository root (default: cwd) |
| `--branch <branch>` | | Base branch (default: main) |
| `--model <model>` | | AI model for Manager LLM |
| `--engine <type>` | | Agent engine (default: claude) |
| `--ws-port <port>` | | WebSocket port (default: 4000, 0=auto) |
| `--debug` | `DEBUG=1` | Verbose output |

## Documentation

- [Getting Started](https://toban.dev/docs/getting-started) -- Full setup walkthrough
- [Architecture](https://toban.dev/docs/architecture) -- How Toban works under the hood
- [Agent Execution](https://toban.dev/docs/agent-execution) -- Git worktree isolation model

## License

MIT
