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

## Code Index (key files and exports)

### Core Flow: cli.ts → setup.ts → commands/run-loop.ts → agents/agent-templates.ts → agents/runner.ts → pipeline/*

| File | Key Exports | Responsibility |
|------|-------------|----------------|
| `agents/agent-templates.ts` | `matchTemplate()`, `executeActions()`, `ActionContext` | Template definitions, pre/post action execution |
| `agents/prompt.ts` | `buildAgentPrompt()`, `PromptContext` | Agent prompt builder (role, spec, rules) |
| `agents/runner.ts` | `AgentRunner` | Agent lifecycle (spawn, monitor, stream output) |
| `agents/spawner.ts` | `spawnAgent()`, `createWorktree()` | Low-level process spawning + worktree |
| `agents/agent-engine.ts` | `AgentEngineProvider`, `resolveModelForRole()` | Engine abstraction (Claude, Codex, Gemini) |
| `commands/run-loop.ts` | `runLoop()` | Main task execution loop, story-mode dispatch |
| `commands/task-scheduler.ts` | `TaskScheduler` | Task filtering, story grouping, slot assignment |
| `commands/sprint-controller.ts` | `SprintController` | Sprint state management |
| `pipeline/merge-pipeline.ts` | `handleMergePipeline()` | git_merge → verify_build → git_push (idempotent) |
| `pipeline/verify-build.ts` | `handleVerifyBuild()` | typecheck + full test verification |
| `pipeline/git-merge.ts` | `handleGitMerge()` | Git merge with rebase + conflict retry |
| `pipeline/spawn-reviewer.ts` | `handleSpawnReviewer()` | Async reviewer agent spawning |
| `pipeline/memory.ts` | `handleInjectMemory()`, `handleCollectMemory()` | Agent memory injection/collection |
| `pipeline/context-sharing.ts` | `handleFetchRecentChanges()`, `handleRecordChanges()` | Peer agent context sharing |
| `channel/ws-server.ts` | `WsChatServer` | WebSocket server for browser-CLI communication |
| `services/api-client.ts` | `createApiClient()`, `ApiClient`, `Task` | REST client for Toban API |
| `services/git-ops.ts` | `setupGitCredentialHelper()`, `resolveRepoRoot()` | Git operations (credential, clone, fetch) |
| `services/slot-scheduler.ts` | `SlotScheduler` | Agent slot allocation |
| `services/job-queue.ts` | `JobQueue` | Unified job queue (enrich, review) |
| `utils/completion-parser.ts` | `extractCompletionJson()` | Parse COMPLETION_JSON from agent output |
| `utils/main-health-check.ts` | `runHealthCheck()` | Main branch health verification |
| `utils/pipeline-state.ts` | `loadPipelineState()`, `savePipelineState()` | Idempotent pipeline step persistence |
| `utils/guardrail.ts` | `buildGuardrailRules()`, `checkDiffViolations()` | Diff guardrail rules |

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

## Reuse Checklist: Adding New Agents / Task Types

Before creating new code for a new agent role or task type, check these existing systems:

### New Agent Role
1. **agent-roles.ts** (API): Add to `AGENT_ROLES` + `ROLES` with capabilities, allowedTaskTypes, forbiddenKeywords
2. **run-loop.ts** (CLI): Add to `agentRoles` array for auto-assignment
3. **agent-templates.ts** (CLI): Check if existing template matches (implementation/research/content/strategy/reviewer) or create new one
4. **prompts/templates.ts** (CLI): Reuse Manager prompt patterns — spawn_agent, send_message
5. **agent-engine.ts** (CLI): Reuse existing engine (claude/codex/gemini), no new code needed
6. **spawnClaudeOnce** (CLI): For single-shot LLM calls, reuse `utils/spawn-claude.ts`
7. **COMPLETION_JSON**: All agent output must use `COMPLETION_JSON:{...}` pattern (parsed by `utils/completion-parser.ts`)

### New Ops Task Type
1. **ops-runner.ts**: Add `config.type === "new_type"` branch in `executeTask()`
2. **Existing patterns**: healthcheck (URL), shell command, qa_scan (build/test/log), rule_evaluate (LLM)
3. **Results**: Use `this.reportResult()` for structured result reporting
4. **Bug creation**: Reuse `this.createBugTasks()` for auto-filing issues
5. **Rule evaluation**: Use `fireRuleEvaluate()` to feed results into Defense Report

### New Action Type
1. **agent-templates.ts**: Add to `TemplateAction.type` union + `executeActions` switch
2. **Existing handlers**: Check `handlers/` directory — git-merge, git-push, spawn-reviewer, review-changes, memory, context-sharing
3. **Error handling**: Use `getExecError()` from `utils/exec-error.ts` for execSync errors
4. **Structured output**: Use `COMPLETION_JSON` pattern with `utils/completion-parser.ts`

## Ops Tasks Setup

The OpsRunner executes background tasks on a schedule. To seed ops tasks via API:

```bash
# QA Scan (build/test/error log check every 4 hours)
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  "$BASE_URL/api/v1/ops-tasks" -d '{
    "title": "QA Scan",
    "description": "{\"type\":\"qa_scan\",\"commands\":{\"build\":\"npm run build\",\"test\":\"npm test\"}}",
    "category": "auto_check",
    "schedule": "interval",
    "interval_hours": 4
  }'

# Rule Evaluation (LLM re-evaluation of keyword matches every 6 hours)
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  "$BASE_URL/api/v1/ops-tasks" -d '{
    "title": "Rule Evaluation",
    "description": "{\"type\":\"rule_evaluate\"}",
    "category": "auto_check",
    "schedule": "interval",
    "interval_hours": 6
  }'
```

QA scan config options: `repo_dir`, `commands.build`, `commands.test`, `health_urls[]`, `error_log`.


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## project: agent-spawn-architecture
Agent Spawn設計(2026-03-16): Manager=ホスト上でclaude --print実行(Keychain可)。子エージェント(builder等)はspawn_agentアクションでRunner経由spawn。デフォルトworktreeモード(--no-docker)。Docker問題: Claude CLIはmacOS Keychainに認証保存、コンテナからアクセス不可。Keychain抽出→credentials.json注入を試みたがCLI認識せず(revert)。結論: ローカル=worktree、クラウド/CI=Docker+ANTHROPIC_API_KEY。Worktreeはgitブランチ隔離のみ(FS/NW/env共有)だがコンフリクト防止に有効。Docker cpSync時はplugins内の.git/.codex/.geminiをfilterで除外必要(symlinkループあり)。
## project: cli-ws-architecture
CLI WS設計(2026-03-16): WS接続中はポーリング停止、sleepUntilWake(Infinity)で待機。task_changed/sprint_changedイベントでwake。WS接続ループ対策: React StrictModeのdouble-mount対策としてcleanup時100ms遅延でアンマウント判定(mountedRef)、CONNECTING状態スキップ、healthCheckRunning並列ガード、onclose reschedule 2秒遅延。チャット: WS送信時はAPI loadChatMessages呼ばない(重複防止)、status:typingでindicator表示、chat入力はuncontrolled ref(再レンダリング防止)、表示100件制限。handleWsMessage: 先にreply返しactionsはバックグラウンド実行(spawn等のブロック防止)。
## project: manager-prompt-design
Managerプロンプト設計(2026-03-16): spawn_agentはプロセス起動。idle/startingのエージェントは動いていない→spawn_agent必要。send_messageはrunning状態のエージェントのみ。エンジン設定: DBにはバージョンなし短縮名(claude-opus等)、CLI側でENGINE_TO_MAPPINGでフルID変換(claude-opus-4-20250514等)。デフォルトモデルはclaude-opus。起動時ConfigurationにModel表示。
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->


<!-- TOBAN_MEMORY_START -->
# Agent Memory (auto-injected by Toban)

## reference: toban-prompt-transparency-redesign
エージェントに渡すプロンプト全文をユーザーが閲覧できる機能の設計。現状: playbookPrompt + security rules + role desc + task desc + API ref + memoriesが合成される。表示方法、タイミング、UIを検討。
## reference: toban-realtime-notify-research
現在のポーリング方式をリアルタイム化する最適な方式を調査する。

比較対象:
1. WebSocket（Durable Objects必須）
2. SSE（Server-Sent Events）
3. qhook push通知経由
4. Long polling改善

調査観点:
- Cloudflare Workers上での実装制約
- 全ユーザー同時接続時のスケーラビリティ
- コスト（Durable Objects課金、リクエスト数等）
- 将来qhookをメッセージングレイヤーとして挟む設計との整合性
- 実装複雑度

アウトプット: 調査レポート（推奨方式+根拠）
対象リポ: totte-dev/toban
<!-- TOBAN_MEMORY_END -->
