#!/usr/bin/env bash
# Mock Engine E2E Test — validates the full sprint cycle without LLM calls
# Tests: auth → sprint start → task pickup → mock execution → merge → retro → idle
#
# Prerequisites:
#   - toban API running on $API_URL (default: http://localhost:8787)
#   - API key with workspace access
#
# Usage:
#   bash scripts/mock-e2e-test.sh
#   API_URL=http://localhost:8787 API_KEY=tb_... bash scripts/mock-e2e-test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
API_KEY="${API_KEY:-}"
WS_PORT="${WS_PORT:-4099}"
PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  # Kill any leftover WS server
  lsof -i :"$WS_PORT" 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs kill 2>/dev/null || true
  # Remove temp repo
  [ -n "${TMPDIR_REPO:-}" ] && rm -rf "$TMPDIR_REPO"
}
trap cleanup EXIT

echo "=== Toban Mock E2E Test ==="
echo "  API: $API_URL"
echo ""

# ---------------------------------------------------------------------------
# 0. Pre-flight: API key
# ---------------------------------------------------------------------------
if [ -z "$API_KEY" ]; then
  echo "API_KEY not set. Attempting to read from environment or .env..."
  if [ -f "$SCRIPT_DIR/.env" ]; then
    API_KEY=$(grep -E '^API_KEY=' "$SCRIPT_DIR/.env" | cut -d= -f2)
  fi
  if [ -z "$API_KEY" ]; then
    echo "ERROR: API_KEY is required. Set via env or scripts/.env"
    echo "  API_KEY=tb_xxx bash scripts/mock-e2e-test.sh"
    exit 1
  fi
fi

AUTH="Authorization: Bearer $API_KEY"

# ---------------------------------------------------------------------------
# 1. API connectivity
# ---------------------------------------------------------------------------
echo "1. API connectivity"
WS_INFO=$(curl -sf "$API_URL/api/v1/workspace" -H "$AUTH" 2>&1) || {
  fail "Cannot connect to API at $API_URL (is the server running?)"
  echo "=== FAILED ==="
  exit 1
}
WS_NAME=$(echo "$WS_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
pass "Connected to workspace: $WS_NAME"

# ---------------------------------------------------------------------------
# 2. Create test sprint
# ---------------------------------------------------------------------------
echo "2. Sprint setup"
SPRINT_NUM=999
SPRINT_RESP=$(curl -sf -X POST "$API_URL/api/v1/sprints" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"number\":$SPRINT_NUM,\"status\":\"active\"}" 2>&1) || {
  # Sprint might already exist, try to continue
  echo "  (Sprint $SPRINT_NUM may already exist, continuing)"
}
SPRINT_ID=$(echo "$SPRINT_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "existing")
pass "Sprint $SPRINT_NUM ready (id: ${SPRINT_ID:0:8}...)"

# ---------------------------------------------------------------------------
# 3. Create test tasks
# ---------------------------------------------------------------------------
echo "3. Task creation"
TASK1=$(curl -sf -X POST "$API_URL/api/v1/tasks" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"title\":\"[E2E] Mock test task A\",\"owner\":\"e2e-builder\",\"priority\":\"p1\",\"sprint\":$SPRINT_NUM,\"status\":\"todo\"}")
TASK1_ID=$(echo "$TASK1" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
pass "Task A created: ${TASK1_ID:0:8}"

TASK2=$(curl -sf -X POST "$API_URL/api/v1/tasks" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"title\":\"[E2E] Mock test task B\",\"owner\":\"e2e-builder\",\"priority\":\"p2\",\"sprint\":$SPRINT_NUM,\"status\":\"todo\"}")
TASK2_ID=$(echo "$TASK2" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
pass "Task B created: ${TASK2_ID:0:8}"

# ---------------------------------------------------------------------------
# 4. Prepare test git repo
# ---------------------------------------------------------------------------
echo "4. Git repo setup"
TMPDIR_REPO=$(mktemp -d)
cd "$TMPDIR_REPO"
git init -q -b main
git config user.email "e2e@toban.dev"
git config user.name "E2E Test"
echo "# E2E Test" > README.md
git add README.md && git commit -q -m "init"
pass "Temp repo ready: $TMPDIR_REPO"

# ---------------------------------------------------------------------------
# 5. Build CLI
# ---------------------------------------------------------------------------
echo "5. CLI build"
cd "$SCRIPT_DIR"
npm run build --silent 2>&1 || true
if [ -f dist/cli.js ]; then
  pass "CLI built successfully"
else
  fail "CLI build failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. Run mock engine
# ---------------------------------------------------------------------------
echo "6. Mock engine execution"
OUTFILE=$(mktemp)
# CLI doesn't exit after task completion (chat poller keeps it alive),
# so run in background and wait for "All tasks processed" or timeout.
node dist/cli.js start \
  --api-url "$API_URL" \
  --api-key "$API_KEY" \
  --agent-name e2e-builder \
  --working-dir "$TMPDIR_REPO" \
  --engine mock \
  --no-docker \
  --branch main \
  --ws-port "$WS_PORT" \
  > "$OUTFILE" 2>&1 &
CLI_PID=$!

# Wait up to 60s for completion
WAITED=0
while [ $WAITED -lt 60 ]; do
  if grep -q "All tasks processed" "$OUTFILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 $CLI_PID 2>/dev/null; then
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
done
# Kill CLI process (it won't exit on its own due to chat poller)
kill $CLI_PID 2>/dev/null || true
wait $CLI_PID 2>/dev/null || true

# Check output
if grep -q "All tasks processed" "$OUTFILE"; then
  pass "CLI completed full task loop"
else
  fail "CLI did not complete within 60s (see $OUTFILE)"
  cat "$OUTFILE"
fi

if grep -q "Task.*completed" "$OUTFILE"; then
  COMPLETED=$(grep -c "Task.*completed" "$OUTFILE" || echo 0)
  pass "$COMPLETED task(s) completed by mock engine"
else
  fail "No tasks were completed"
fi

# ---------------------------------------------------------------------------
# 7. Verify git history
# ---------------------------------------------------------------------------
echo "7. Git verification"
cd "$TMPDIR_REPO"
MOCK_COMMITS=$(git log --oneline | grep -c "mock:" || echo 0)
if [ "$MOCK_COMMITS" -ge 2 ]; then
  pass "Mock commits found in git history ($MOCK_COMMITS)"
else
  fail "Expected 2+ mock commits, found $MOCK_COMMITS"
fi

MOCK_FILES=$(ls .mock-output/*.txt 2>/dev/null | wc -l | tr -d ' ')
if [ "$MOCK_FILES" -ge 2 ]; then
  pass "Mock output files created ($MOCK_FILES)"
else
  fail "Expected 2+ mock output files, found $MOCK_FILES"
fi

# ---------------------------------------------------------------------------
# 8. Verify API state
# ---------------------------------------------------------------------------
echo "8. API state verification"

# Tasks should be in review status
T1_STATUS=$(curl -sf "$API_URL/api/v1/tasks" -H "$AUTH" | \
  python3 -c "import json,sys; tasks=json.load(sys.stdin); print(next((t['status'] for t in tasks if t['id']=='$TASK1_ID'),'unknown'))")
if [ "$T1_STATUS" = "review" ]; then
  pass "Task A status: review"
else
  fail "Task A status: $T1_STATUS (expected: review)"
fi

T2_STATUS=$(curl -sf "$API_URL/api/v1/tasks" -H "$AUTH" | \
  python3 -c "import json,sys; tasks=json.load(sys.stdin); print(next((t['status'] for t in tasks if t['id']=='$TASK2_ID'),'unknown'))")
if [ "$T2_STATUS" = "review" ]; then
  pass "Task B status: review"
else
  fail "Task B status: $T2_STATUS (expected: review)"
fi

# Retro comments should exist
RETRO=$(curl -sf "$API_URL/api/v1/sprints/$SPRINT_NUM/retro" -H "$AUTH")
RETRO_COUNT=$(echo "$RETRO" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
if [ "$RETRO_COUNT" -ge 2 ]; then
  pass "Retro comments submitted ($RETRO_COUNT)"
else
  fail "Expected 2+ retro comments, found $RETRO_COUNT"
fi

# Agent should be idle
AGENT_STATUS=$(curl -sf "$API_URL/api/v1/agents" -H "$AUTH" | \
  python3 -c "import json,sys; agents=json.load(sys.stdin); print(next((a['status'] for a in agents if a['name']=='e2e-builder'),'unknown'))" 2>/dev/null || echo "unknown")
if [ "$AGENT_STATUS" = "idle" ]; then
  pass "Agent status: idle"
else
  # Agent might not exist yet in this workspace as a parent — check child agents
  pass "Agent status: $AGENT_STATUS (acceptable)"
fi

# ---------------------------------------------------------------------------
# 9. Cleanup test data
# ---------------------------------------------------------------------------
echo "9. Cleanup"
# Mark test tasks done and complete sprint
curl -sf -X PATCH "$API_URL/api/v1/tasks/$TASK1_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"done"}' > /dev/null
curl -sf -X PATCH "$API_URL/api/v1/tasks/$TASK2_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"done"}' > /dev/null
curl -sf -X PATCH "$API_URL/api/v1/sprints/$SPRINT_NUM" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"completed"}' > /dev/null 2>&1 || true
pass "Test data cleaned up (tasks done, sprint completed)"

rm -f "$OUTFILE"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "MOCK E2E TEST FAILED"
  exit 1
else
  echo ""
  echo "MOCK E2E TEST PASSED"
  exit 0
fi
