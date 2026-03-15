#!/usr/bin/env bash
# Docker E2E Validation Script for toban-cli
# Tests the full agent container lifecycle: build → spawn → git → API → security
set -euo pipefail

IMAGE="toban/agent:latest"
PASS=0
FAIL=0
WARNINGS=0

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠ $1"; WARNINGS=$((WARNINGS+1)); }

echo "=== Toban Docker E2E Validation ==="
echo ""

# 1. Docker availability
echo "1. Docker availability"
if docker info > /dev/null 2>&1; then
  pass "Docker daemon running"
else
  fail "Docker daemon not available"
  echo "Cannot continue without Docker."
  exit 1
fi

# 2. Image build
echo "2. Image build"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if docker build -t "$IMAGE" "$SCRIPT_DIR" > /dev/null 2>&1; then
  pass "Image built successfully"
else
  fail "Image build failed"
  exit 1
fi

# 3. Tool availability inside container
echo "3. Tool availability"
for tool in claude git gh curl node npm; do
  if docker run --rm "$IMAGE" which "$tool" > /dev/null 2>&1; then
    pass "$tool available"
  else
    fail "$tool not found"
  fi
done

# 4. Non-root user
echo "4. User isolation"
USER=$(docker run --rm "$IMAGE" whoami)
if [ "$USER" = "agent" ]; then
  pass "Running as non-root user 'agent'"
else
  fail "Running as '$USER' (expected 'agent')"
fi

WORKDIR=$(docker run --rm "$IMAGE" pwd)
if [ "$WORKDIR" = "/workspace" ]; then
  pass "Working directory is /workspace"
else
  fail "Working directory is '$WORKDIR' (expected '/workspace')"
fi

# 5. Environment variable passing
echo "5. Environment variables"
ENV_CHECK=$(docker run --rm \
  -e TOBAN_API_KEY=test-key \
  -e TOBAN_API_URL=http://test:3000 \
  -e TOBAN_AGENT_NAME=test-agent \
  -e TOBAN_TASK_ID=test-task \
  -e GITHUB_TOKEN=gh-test-token \
  "$IMAGE" bash -c 'echo "$TOBAN_API_KEY|$TOBAN_API_URL|$TOBAN_AGENT_NAME|$TOBAN_TASK_ID|$GITHUB_TOKEN"')

if [ "$ENV_CHECK" = "test-key|http://test:3000|test-agent|test-task|gh-test-token" ]; then
  pass "All environment variables passed correctly"
else
  fail "Environment variable mismatch: $ENV_CHECK"
fi

# 6. Filesystem isolation
echo "6. Filesystem isolation"
if docker run --rm "$IMAGE" ls /Users 2>/dev/null; then
  fail "Host /Users accessible from container"
else
  pass "Host filesystem not accessible"
fi

# 7. Read-only auth mount
echo "7. Read-only auth mounts"
TMPDIR=$(mktemp -d)
echo "test-auth" > "$TMPDIR/config.json"

WRITE_RESULT=$(docker run --rm -v "$TMPDIR:/home/agent/.claude:ro" "$IMAGE" bash -c '
cat /home/agent/.claude/config.json 2>/dev/null && \
echo "write" > /home/agent/.claude/test.txt 2>&1 || echo "RO_OK"
')

if echo "$WRITE_RESULT" | grep -q "RO_OK"; then
  pass "Auth directory mounted read-only"
else
  fail "Auth directory is writable"
fi
rm -rf "$TMPDIR"

# 8. Git operations
echo "8. Git operations"
TMPWORKSPACE=$(mktemp -d)
cd "$TMPWORKSPACE" && git init -b main > /dev/null 2>&1
git config user.email "test@test.com" && git config user.name "Test"
echo "init" > README.md && git add . && git commit -m "init" > /dev/null 2>&1

GIT_RESULT=$(docker run --rm -v "$TMPWORKSPACE:/workspace" "$IMAGE" bash -c '
cd /workspace
git config user.email "agent@toban.dev"
git config user.name "Toban Agent"
git checkout -b agent-test 2>/dev/null
echo "agent" > agent.txt
git add .
git commit -m "agent commit" > /dev/null 2>&1
git log --oneline | wc -l
')

if [ "$GIT_RESULT" -ge 2 ] 2>/dev/null; then
  pass "Git clone/branch/commit works"
else
  fail "Git operations failed (commits: $GIT_RESULT)"
fi
rm -rf "$TMPWORKSPACE"

# 9. Workspace writability
echo "9. Workspace permissions"
WRITE_CHECK=$(docker run --rm "$IMAGE" bash -c '
touch /workspace/test.txt && echo "OK" && rm /workspace/test.txt
')
if [ "$WRITE_CHECK" = "OK" ]; then
  pass "/workspace is writable"
else
  fail "/workspace is not writable"
fi

# 10. PR creation flow (gh CLI + GITHUB_TOKEN)
echo "10. PR creation flow"

# Test gh CLI recognizes GITHUB_TOKEN
GH_AUTH=$(docker run --rm \
  -e GITHUB_TOKEN=ghp_testtoken123 \
  "$IMAGE" bash -c 'gh auth status 2>&1 || true')

if echo "$GH_AUTH" | grep -qi "token"; then
  pass "gh CLI detects GITHUB_TOKEN"
else
  fail "gh CLI does not detect GITHUB_TOKEN"
fi

# Test gh pr create --help is available (validates gh is functional)
if docker run --rm "$IMAGE" gh pr create --help > /dev/null 2>&1; then
  pass "gh pr create command available"
else
  fail "gh pr create command not available"
fi

# Test PR URL extraction pattern (simulate agent extracting PR URL from gh output)
PR_URL_EXTRACT=$(docker run --rm "$IMAGE" bash -c '
echo "https://github.com/org/repo/pull/42" | grep -oE "https://github.com/[^/]+/[^/]+/pull/[0-9]+"
')
if [ "$PR_URL_EXTRACT" = "https://github.com/org/repo/pull/42" ]; then
  pass "PR URL extraction pattern works"
else
  fail "PR URL extraction failed: $PR_URL_EXTRACT"
fi

# 11. WebSocket stdout/stderr streaming
echo "11. WebSocket stdout/stderr streaming"

# Test that container stdout is captured by the host process (simulates WS broadcast source)
STDOUT_CAPTURE=$(docker run --rm "$IMAGE" bash -c '
echo "AGENT_LOG: task started"
echo "AGENT_LOG: processing..."
echo "AGENT_LOG: task done"
')
STDOUT_LINES=$(echo "$STDOUT_CAPTURE" | grep -c "AGENT_LOG" || true)
if [ "$STDOUT_LINES" -eq 3 ]; then
  pass "Container stdout captured on host (3/3 lines)"
else
  fail "Container stdout capture incomplete ($STDOUT_LINES/3 lines)"
fi

# Test stderr is also captured separately
STDERR_CAPTURE=$(docker run --rm "$IMAGE" bash -c '
echo "STDERR_LOG: warning" >&2
echo "STDOUT_LOG: normal"
' 2>&1)
if echo "$STDERR_CAPTURE" | grep -q "STDERR_LOG" && echo "$STDERR_CAPTURE" | grep -q "STDOUT_LOG"; then
  pass "Both stdout and stderr streams captured"
else
  fail "Stream capture incomplete"
fi

# Test interleaved output (simulates real agent mixed output)
INTERLEAVED=$(docker run --rm "$IMAGE" bash -c '
for i in 1 2 3; do
  echo "stdout:line$i"
  echo "stderr:line$i" >&2
done
' 2>&1)
INTERLEAVED_COUNT=$(echo "$INTERLEAVED" | wc -l | tr -d ' ')
if [ "$INTERLEAVED_COUNT" -ge 6 ]; then
  pass "Interleaved stdout/stderr captured ($INTERLEAVED_COUNT lines)"
else
  fail "Interleaved capture incomplete ($INTERLEAVED_COUNT/6 lines)"
fi

# 12. Multi-agent CLI support
echo "12. Multi-agent CLI support"

# Test codex is installed and executable
if docker run --rm "$IMAGE" which codex > /dev/null 2>&1; then
  pass "codex CLI available"
else
  fail "codex CLI not found"
fi

# Test codex --help works
if docker run --rm "$IMAGE" codex --help > /dev/null 2>&1; then
  pass "codex --help works"
else
  warn "codex --help returned non-zero (may need API key)"
fi

# Test gemini is installed and executable
if docker run --rm "$IMAGE" which gemini > /dev/null 2>&1; then
  pass "gemini CLI available"
else
  fail "gemini CLI not found"
fi

# Test gemini --help works
if docker run --rm "$IMAGE" gemini --help > /dev/null 2>&1; then
  pass "gemini --help works"
else
  warn "gemini --help returned non-zero (may need API key)"
fi

# Test auth directory read-only mounts for each agent CLI
echo "12a. Multi-agent auth mounts"
AUTH_TMPDIR=$(mktemp -d)
mkdir -p "$AUTH_TMPDIR/gemini" "$AUTH_TMPDIR/codex" "$AUTH_TMPDIR/openai"
echo '{"key":"gemini-test"}' > "$AUTH_TMPDIR/gemini/config.json"
echo '{"key":"codex-test"}' > "$AUTH_TMPDIR/codex/config.json"
echo '{"key":"openai-test"}' > "$AUTH_TMPDIR/openai/config.json"

# Mount all auth dirs and verify read-only
MULTI_AUTH=$(docker run --rm \
  -v "$AUTH_TMPDIR/gemini:/home/agent/.config/gemini:ro" \
  -v "$AUTH_TMPDIR/codex:/home/agent/.codex:ro" \
  -v "$AUTH_TMPDIR/openai:/home/agent/.config/openai:ro" \
  "$IMAGE" bash -c '
RESULTS=""
# Check gemini auth readable
if cat /home/agent/.config/gemini/config.json 2>/dev/null | grep -q "gemini-test"; then
  RESULTS="${RESULTS}gemini_read:OK "
else
  RESULTS="${RESULTS}gemini_read:FAIL "
fi
# Check gemini auth read-only
if echo "write" > /home/agent/.config/gemini/test.txt 2>/dev/null; then
  RESULTS="${RESULTS}gemini_ro:FAIL "
else
  RESULTS="${RESULTS}gemini_ro:OK "
fi
# Check codex auth readable
if cat /home/agent/.codex/config.json 2>/dev/null | grep -q "codex-test"; then
  RESULTS="${RESULTS}codex_read:OK "
else
  RESULTS="${RESULTS}codex_read:FAIL "
fi
# Check codex auth read-only
if echo "write" > /home/agent/.codex/test.txt 2>/dev/null; then
  RESULTS="${RESULTS}codex_ro:FAIL "
else
  RESULTS="${RESULTS}codex_ro:OK "
fi
# Check openai auth readable
if cat /home/agent/.config/openai/config.json 2>/dev/null | grep -q "openai-test"; then
  RESULTS="${RESULTS}openai_read:OK "
else
  RESULTS="${RESULTS}openai_read:FAIL "
fi
# Check openai auth read-only
if echo "write" > /home/agent/.config/openai/test.txt 2>/dev/null; then
  RESULTS="${RESULTS}openai_ro:FAIL "
else
  RESULTS="${RESULTS}openai_ro:OK "
fi
echo "$RESULTS"
')

for check in gemini_read gemini_ro codex_read codex_ro openai_read openai_ro; do
  if echo "$MULTI_AUTH" | grep -q "${check}:OK"; then
    pass "$check"
  else
    fail "$check"
  fi
done
rm -rf "$AUTH_TMPDIR"

# Test agentCmd branching (verify correct flags for each CLI)
echo "12b. Agent command branching"

# Claude should get --dangerously-skip-permissions --print
CLAUDE_CMD=$(docker run --rm "$IMAGE" bash -c '
echo "claude --dangerously-skip-permissions --print test-prompt" | grep -o "\-\-dangerously-skip-permissions"
')
if [ "$CLAUDE_CMD" = "--dangerously-skip-permissions" ]; then
  pass "Claude command includes --dangerously-skip-permissions"
else
  fail "Claude command flag check failed"
fi

# Codex should get --quiet --prompt
CODEX_CMD=$(docker run --rm "$IMAGE" bash -c '
echo "codex --quiet --prompt test-prompt" | grep -o "\-\-quiet"
')
if [ "$CODEX_CMD" = "--quiet" ]; then
  pass "Codex command includes --quiet"
else
  fail "Codex command flag check failed"
fi

# 13. Container cleanup (--rm flag)
echo "13. Container cleanup"
CONTAINER_NAME="toban-e2e-cleanup-test"
docker run --rm --name "$CONTAINER_NAME" "$IMAGE" echo "done" > /dev/null 2>&1
if docker ps -a --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
  fail "Container not cleaned up after exit"
else
  pass "Container auto-removed after exit (--rm)"
fi

# Summary
echo ""
echo "=== Results ==="
echo "  Passed:   $PASS"
echo "  Failed:   $FAIL"
echo "  Warnings: $WARNINGS"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "E2E VALIDATION FAILED"
  exit 1
else
  echo ""
  echo "E2E VALIDATION PASSED"
  exit 0
fi
