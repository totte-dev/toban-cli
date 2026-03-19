# Parallel Agent Execution Design

## Overview

Enable multiple agents of the same role (e.g., 2 builders) to run concurrently on different tasks within the same sprint.

## Current Architecture

```
Main Loop (30s poll)
  → Pick up in_progress tasks (sequential)
  → For each task:
    → Spawn agent (name: "builder")
    → BLOCK until agent completes (waitForAgent)
    → Run post-actions (merge, push, review)
    → Next task
```

**Limitations:**
- One agent per role at a time (same-name block in runner.ts)
- Main loop blocks on each agent — no parallelism
- Sequential merge/push is safe but slow

## Proposed Architecture

```
Main Loop (30s poll)
  → Task Queue (sorted by priority)
  → For each task:
    → SlotScheduler.acquireSlot(role) → "builder-1" or null
    → If slot available: spawnInSlot(async, non-blocking)
    → If no slot: skip, try next poll

SlotScheduler
  builder-1 [running: task-abc] → on finish: post_actions → releaseSlot
  builder-2 [idle]              ← assign next task
  builder-3 [running: task-def] → on finish: post_actions → releaseSlot
```

## Agent Naming Strategy

### Pool-based Slots

| Current | Proposed |
|---|---|
| `builder` (single) | `builder-1`, `builder-2`, ... `builder-N` |
| `cloud-engineer` | `cloud-engineer-1` |

- Slot count = `max_concurrency` per role (configurable)
- Slots are **reused** — no DB bloat
- DB: max N rows per role (bounded)
- Manager still refers to agents by role name ("builder")
- Task `owner` field stays as base role ("builder") — any `builder-N` can pick it up

### DB Impact

For a workspace with `{"builder": 3, "cloud-engineer": 1}`:
- 4 agent rows total (builder-1, builder-2, builder-3, cloud-engineer-1)
- Same rows reused across sprints

## Component Changes

### 1. New: SlotScheduler (`src/slot-scheduler.ts`)

```typescript
interface SlotConfig {
  role: string;
  maxConcurrency: number;
}

interface Slot {
  name: string;           // "builder-1"
  role: string;           // "builder"
  taskId: string | null;  // null = available
  status: "idle" | "running" | "finishing";
}

class SlotScheduler {
  constructor(configs: SlotConfig[]);
  acquireSlot(role: string): string | null;
  assignTask(slotName: string, taskId: string): void;
  releaseSlot(slotName: string): void;
  isTaskAssigned(taskId: string): boolean;
  runningCount(role: string): number;
}
```

### 2. New: MergeLock (`src/merge-lock.ts`)

Serializes git merge/push per repository to prevent conflicts.

```typescript
class MergeLock {
  async acquire(repoDir: string): Promise<() => void>;
}
```

Two parallel agents may modify different files, but `git merge` and `git push` must happen one at a time per repo. The lock is acquired before `git_merge` post-action and released after `git_push`.

### 3. CLI Main Loop (`src/cli.ts`)

**Before (sequential):**
```typescript
for (const task of todoTasks) {
  const agent = await runner.spawn(config);
  await waitForAgent(runner, config.name);  // BLOCKS
  await executeActions(post_actions);
}
```

**After (concurrent dispatch):**
```typescript
for (const task of todoTasks) {
  if (scheduler.isTaskAssigned(task.id)) continue;
  const slot = scheduler.acquireSlot(task.owner);
  if (!slot) continue;  // all slots busy
  scheduler.assignTask(slot, task.id);
  spawnInSlot(slot, task);  // async, non-blocking
}
```

`spawnInSlot` is a self-contained async function:
1. Run pre_actions
2. Spawn agent (`runner.spawn` with `name = slot`)
3. Attach completion callback:
   - Acquire merge lock
   - Run post_actions (merge, push, review)
   - Release merge lock
   - `scheduler.releaseSlot(slot)`
   - Broadcast status via WS

### 4. Runner (`src/runner.ts`)

Minimal changes. The `Map<string, ManagedAgent>` already supports concurrent agents with different names. With slot names (`builder-1`, `builder-2`), no same-name conflicts.

### 5. Spawner (`src/spawner.ts`) + Directory Structure

Repo clone directory structure changes to include agent slot:

```
Current:  ~/.toban/{ws-id}/{repo-name}/          ← single agent
Proposed: ~/.toban/{ws-id}/{slot-name}/{repo-name}/  ← per-slot isolation
          ~/.toban/{ws-id}/builder-1/my-app/
          ~/.toban/{ws-id}/builder-2/my-app/
```

This prevents two parallel agents from sharing the same git worktree base directory. `ensureAgentRepo` in `git-ops.ts` needs to include the slot name in the clone path.

Worktree branches become `agent/builder-1-abc12345`, `agent/builder-2-def67890` — unique and conflict-free.

### 6. Agent Templates (`src/agent-templates.ts`)

`git_merge` and `git_push` actions acquire the merge lock via `ActionContext`:

```typescript
interface ActionContext {
  // ... existing fields ...
  mergeLock?: MergeLock;
}

case "git_merge": {
  const release = await ctx.mergeLock?.acquire(repoDir);
  try {
    // ... existing merge logic ...
  } finally {
    release?.();
  }
}
```

### 7. API Changes

**Migration `0050_agent_concurrency.sql`:**
```sql
ALTER TABLE workspaces ADD COLUMN agent_concurrency TEXT DEFAULT '{}';
```

JSON format: `{"builder": 2, "cloud-engineer": 1}`

**Plan limits (`lib/plan-limits.ts`):**
```typescript
free:       { maxConcurrentAgents: 1 },
pro:        { maxConcurrentAgents: 5 },
enterprise: { maxConcurrentAgents: 20 },
```

**Task locking (Phase 4):**
```sql
ALTER TABLE tasks ADD COLUMN locked_by TEXT;
```

### 8. Frontend Changes

**Terminal panel** — already supports per-agent tabs via `agentTimeline[agentName]`. Slot names auto-create separate tabs.

**Agent list** — group by role:
```
builder [1:running] [2:idle]
cloud-engineer [1:idle]
```

**Settings page** — per-role concurrency slider (1-5, bounded by plan).

## Configuration

### CLI Flags
```
--max-concurrency <N>   Max parallel agents per role (default: 1)
```

### Workspace Setting (API)
```json
{
  "agent_concurrency": {
    "builder": 2,
    "cloud-engineer": 1
  }
}
```

CLI reads from API at startup, falls back to 1.

## Edge Cases

### Git Merge Conflicts
Two parallel agents modify overlapping files → second merge conflicts.
- MergeLock serializes merges, so they don't run simultaneously
- If conflict occurs: abort merge, reset task to todo, notify user

### CLI Crash Recovery
- Agent processes continue (detached: true)
- On restart: SlotScheduler starts fresh, all slots idle
- Orphaned processes eventually exit (Claude CLI timeout)
- Stale worktrees cleaned up on next createWorktree call
- API `check-stalls` marks old agents as stalled

### Resource Limits
Each Claude CLI process uses significant RAM/CPU.
- Default: 1 (safe for any machine)
- Recommended: 2-3 per machine
- Plan-level cap prevents abuse

### Same Task Double-Pick
- SlotScheduler.isTaskAssigned() prevents CLI-side double assignment
- Phase 4: API-side `locked_by` column for crash resilience

## Implementation Phases

### Phase 1: CLI Core (no API changes)
- [ ] `SlotScheduler` class
- [ ] `MergeLock` class
- [ ] Convert `runLoop` to concurrent dispatch
- [ ] `--max-concurrency` CLI flag
- [ ] Default concurrency=1 (backward compatible)

### Phase 2: API Configuration
- [ ] Migration: `agent_concurrency` column
- [ ] API endpoint: read/write concurrency config
- [ ] CLI reads config from API at startup
- [ ] Plan limits for `maxConcurrentAgents`

### Phase 3: Frontend
- [ ] Concurrency settings in workspace settings page
- [ ] Terminal tabs show task title per slot
- [ ] Agent badges grouped by role
- [ ] Slot utilization indicator

### Phase 4: Robustness
- [ ] API-side task locking (`locked_by`)
- [ ] Startup worktree cleanup scan
- [ ] Graceful shutdown: wait for all slots
- [ ] Per-slot throughput metrics
