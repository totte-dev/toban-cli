# toban-cli - Agent Runner CLI

Orchestrates AI coding agents via sprints. Spawns Claude Code agents in git worktrees, manages Manager LLM, communicates with dashboard via WebSocket.

## Directory Structure

```
src/
  cli.ts              # Entrypoint — arg parse, main task loop, shutdown
  setup.ts            # Startup — workspace init, Manager/WS setup, repo cloning
  git-ops.ts          # Git operations — credential helper, repo clone/update, revert
  manager.ts          # Manager — LLM-powered sprint management, action parsing
  runner.ts           # AgentRunner — spawn/monitor worker agents
  spawner.ts          # Low-level agent process spawning + worktree management
  agent-engine.ts     # AgentEngineProvider — per-engine command/output/config
  agent-templates.ts  # Template system — pre/post actions, tool restrictions
  llm-provider.ts     # LLM abstraction — ClaudeCliProvider, OpenAiApiProvider
  prompt.ts           # Agent prompt builder (role, spec, security, completion)
  prompt-loader.ts    # Template loader for Manager prompts
  prompts/
    templates.ts      # Manager prompt templates (system, actions, rules, phases)
  ws-server.ts        # WebSocket server for browser-to-CLI communication
  ws-types.ts         # WS message type constants
  api-client.ts       # REST API client for Toban API
  types.ts            # Shared types (AgentConfig, AgentActivity, etc.)
  ui.ts               # Terminal UI (spinners, colors, formatted output)
  poll-loop.ts        # Generic polling loop utility
  message-poller.ts   # Agent message polling
  chat-poller.ts      # Chat polling (legacy, being replaced by Manager)
  terminal.ts         # Terminal detection for native terminal spawning
  docker.ts           # Docker container isolation (optional)
```

## Architecture

```
CLI starts → setup.ts (workspace, repos, Manager, WS server)
  → Main loop: poll for in_progress tasks
    → For each task:
      1. matchTemplate() → select agent template (implementation/research)
      2. executeActions(pre_actions) → git_auth_check, update_task, update_agent
      3. buildAgentPrompt() → role + spec + template completion instructions
      4. runner.spawn() → Claude CLI in worktree
      5. waitForAgent() → stream activity via WS
      6. executeActions(post_actions) → git_merge, git_push, review_changes, retro
```

## Key Patterns

- **Templates**: agent-templates.ts controls all agent behavior (pre/post actions, tools, prompts)
- **Engine providers**: agent-engine.ts abstracts per-engine differences (Claude, Codex, Gemini)
- **LLM providers**: llm-provider.ts abstracts Manager's LLM backend
- **Git flow**: Agent commits in worktree → CLI merges to main → CLI pushes (agent never pushes)
- **Credential helper**: ~/.toban/git-credential-helper.sh fetches fresh GitHub App tokens
- **Manager prompts**: prompts/templates.ts — edit here to change Manager behavior

## Commands

```bash
npm run build        # tsup → dist/cli.js
npm run dev          # tsx direct execution
npm run local        # build + run
npm run typecheck    # tsc --noEmit
npm test             # Vitest
```

## CLI Usage

```bash
toban start --api-url <URL> --api-key <KEY>
toban sprint complete [--push]
```

## Coding Conventions

- TypeScript strict mode, ESM modules
- tsup for bundling
- No emojis in code
- Keep changes minimal and focused
- Edit prompts/templates.ts for Manager behavior changes
- Edit agent-templates.ts for worker agent behavior changes
