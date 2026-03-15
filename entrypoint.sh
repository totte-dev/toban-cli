#!/bin/sh
set -e

# Create isolated worktree for agent
BRANCH_NAME="agent/${TOBAN_AGENT_NAME:-unknown}/${TOBAN_TASK_ID:-unknown}"
WORKTREE_DIR="/workspace-agent"

if [ -d /workspace/.git ]; then
  # Configure git to allow the bind-mounted repo
  git config --global --add safe.directory /workspace
  git config --global --add safe.directory "$WORKTREE_DIR"

  git -C /workspace worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" HEAD 2>/dev/null || {
    # Branch may already exist, try without -b
    git -C /workspace worktree add "$WORKTREE_DIR" HEAD 2>/dev/null || true
  }
fi

WORK_DIR="${WORKTREE_DIR}"
[ ! -d "$WORK_DIR" ] && WORK_DIR="/workspace"

# Write secrets to .env.local in worktree
env | grep '^TOBAN_SECRET_' | sed 's/^TOBAN_SECRET_//' > "$WORK_DIR/.env.local" 2>/dev/null || true

cd "$WORK_DIR"
exec "$@"
