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

# 10. Container cleanup (--rm flag)
echo "10. Container cleanup"
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
