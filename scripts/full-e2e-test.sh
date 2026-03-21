#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Full E2E Test — validates CLI + API integration with mock engine
#
# Uses:
#   - Test API server (port 8788, env test) OR Preview API
#   - toban-e2e-test repo (real GitHub repo, not temp dir)
#   - Mock engine (no LLM calls)
#
# Prerequisites:
#   - LOCAL:   cd toban/api && npm run test:e2e:server  (port 8788)
#   - PREVIEW: API already running at https://api.dev.toban.dev
#   - toban-e2e-test repo cloned at ../toban-e2e-test (relative to totte/)
#   - CLI built: cd toban-cli && npm run build
#
# Usage:
#   bash scripts/full-e2e-test.sh                          # local mode
#   E2E_MODE=preview API_KEY=tb_... bash scripts/full-e2e-test.sh  # preview mode
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOTTE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_REPO="$TOTTE_DIR/toban-e2e-test"
E2E_MODE="${E2E_MODE:-local}"
WS_PORT="${WS_PORT:-4098}"
SPRINT_NUM=998
PASS=0
FAIL=0

# ── Mode-specific config ──
if [ "$E2E_MODE" = "preview" ]; then
  API_URL="${API_URL:-https://api.dev.toban.dev}"
  API_KEY="${API_KEY:-}"
  if [ -z "$API_KEY" ]; then
    echo "ERROR: API_KEY required for preview mode"
    echo "  E2E_MODE=preview API_KEY=tb_... bash scripts/full-e2e-test.sh"
    exit 1
  fi
else
  API_URL="${API_URL:-http://localhost:8788}"
  API_KEY="${API_KEY:-}"
fi

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  # Kill WS server
  lsof -i :"$WS_PORT" 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs kill 2>/dev/null || true
  # Reset e2e repo to clean state
  if [ -d "$E2E_REPO" ]; then
    cd "$E2E_REPO"
    # Remove mock output and worktrees
    rm -rf .mock-output .worktrees 2>/dev/null || true
    git checkout main 2>/dev/null || true
    git clean -fd 2>/dev/null || true
    # Remove any branches created during test
    git branch | grep -v '^\* main$' | grep -v '^  main$' | xargs git branch -D 2>/dev/null || true
  fi
  rm -f "${OUTFILE:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Toban Full E2E Test ==="
echo "  Mode: $E2E_MODE"
echo "  API:  $API_URL"
echo "  Repo: $E2E_REPO"
echo ""

# ─────────────────────────────────────────────────────────────
# 0. Pre-flight checks
# ─────────────────────────────────────────────────────────────
echo "0. Pre-flight"

# Check e2e repo exists
if [ ! -d "$E2E_REPO/.git" ]; then
  fail "toban-e2e-test repo not found at $E2E_REPO"
  echo "  Clone it: gh repo clone recuu-pfeg/toban-e2e-test $E2E_REPO"
  exit 1
fi
pass "E2E repo found"

# Check CLI is built
if [ ! -f "$SCRIPT_DIR/dist/cli.js" ]; then
  echo "  Building CLI..."
  cd "$SCRIPT_DIR"
  npm run build --silent 2>&1 || true
fi
if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  pass "CLI built"
else
  fail "CLI build failed"
  exit 1
fi

# ── Create workspace + API key for local mode ──
if [ -z "$API_KEY" ]; then
  echo "  Creating test workspace..."
  WS_RESP=$(curl -sf -X POST "$API_URL/api/workspaces" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"full-e2e-$(date +%s)\"}" 2>&1) || {
    fail "Cannot create workspace at $API_URL (is the test server running?)"
    exit 1
  }
  WS_ID=$(echo "$WS_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

  KEY_RESP=$(curl -sf -X POST "$API_URL/api/keys" \
    -H "Content-Type: application/json" \
    -d "{\"workspace_id\":\"$WS_ID\",\"agent_name\":\"user:e2e-full\"}")
  API_KEY=$(echo "$KEY_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['key'])")
  pass "Workspace created: ${WS_ID:0:8}..."
fi

AUTH="Authorization: Bearer $API_KEY"

# API connectivity
WS_INFO=$(curl -sf "$API_URL/api/v1/workspace" -H "$AUTH" 2>&1) || {
  fail "Cannot connect to API at $API_URL"
  exit 1
}
pass "API connected"

# ─────────────────────────────────────────────────────────────
# 1. Create test sprint + tasks
# ─────────────────────────────────────────────────────────────
echo "1. Sprint & task setup"

SPRINT_RESP=$(curl -sf -X POST "$API_URL/api/v1/sprints" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"number\":$SPRINT_NUM,\"status\":\"active\"}" 2>&1) || {
  echo "  (Sprint $SPRINT_NUM may already exist)"
}
pass "Sprint $SPRINT_NUM ready"

TASK1=$(curl -sf -X POST "$API_URL/api/v1/tasks" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"title\":\"[E2E-Full] Task A\",\"description\":\"Create a test output file to verify the mock engine execution pipeline works end-to-end.\",\"owner\":\"builder\",\"priority\":\"p1\",\"sprint\":$SPRINT_NUM,\"status\":\"todo\"}")
TASK1_ID=$(echo "$TASK1" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
pass "Task A: ${TASK1_ID:0:8}"

TASK2=$(curl -sf -X POST "$API_URL/api/v1/tasks" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"title\":\"[E2E-Full] Task B\",\"description\":\"Create a second test output file to verify parallel task processing in the mock engine.\",\"owner\":\"builder\",\"priority\":\"p2\",\"sprint\":$SPRINT_NUM,\"status\":\"todo\"}")
TASK2_ID=$(echo "$TASK2" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
pass "Task B: ${TASK2_ID:0:8}"

# ─────────────────────────────────────────────────────────────
# 2. Prepare e2e repo (clean state)
# ─────────────────────────────────────────────────────────────
echo "2. Repo preparation"
cd "$E2E_REPO"
git checkout main 2>/dev/null || true
git clean -fd 2>/dev/null || true
rm -rf .mock-output .worktrees 2>/dev/null || true
# Ensure git user config
git config user.email "e2e@toban.dev" 2>/dev/null || true
git config user.name "E2E Test" 2>/dev/null || true
pass "Repo cleaned and ready"

# ─────────────────────────────────────────────────────────────
# 3. Run CLI with mock engine
# ─────────────────────────────────────────────────────────────
echo "3. CLI execution (mock engine)"
OUTFILE=$(mktemp)
cd "$SCRIPT_DIR"

node dist/cli.js start \
  --api-url "$API_URL" \
  --api-key "$API_KEY" \
  --agent-name builder \
  --working-dir "$E2E_REPO" \
  --engine mock \
  --no-docker \
  --branch main \
  --ws-port "$WS_PORT" \
  > "$OUTFILE" 2>&1 &
CLI_PID=$!

# Wait up to 90s for completion (extra buffer for preview latency)
TIMEOUT=90
WAITED=0
while [ $WAITED -lt $TIMEOUT ]; do
  if grep -q "Tasks done" "$OUTFILE" 2>/dev/null || grep -q "All tasks processed" "$OUTFILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 $CLI_PID 2>/dev/null; then
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
done
kill $CLI_PID 2>/dev/null || true
wait $CLI_PID 2>/dev/null || true

if grep -q "Tasks done" "$OUTFILE" || grep -q "All tasks processed" "$OUTFILE"; then
  pass "CLI completed task loop"
else
  fail "CLI did not complete within ${TIMEOUT}s"
  echo "--- CLI output ---"
  tail -30 "$OUTFILE"
  echo "--- end ---"
fi

COMPLETED=$(grep -c "Task.*completed" "$OUTFILE" 2>/dev/null || echo "0")
COMPLETED=$(echo "$COMPLETED" | tr -d '[:space:]')
if [ "$COMPLETED" -ge 1 ]; then
  pass "$COMPLETED task(s) completed"
else
  fail "No tasks completed"
fi

# ─────────────────────────────────────────────────────────────
# 4. Verify git state
# ─────────────────────────────────────────────────────────────
echo "4. Git verification"
cd "$E2E_REPO"

MOCK_COMMITS=$(git log --oneline | grep -c "mock:" || echo "0")
MOCK_COMMITS=$(echo "$MOCK_COMMITS" | tr -d '[:space:]')
if [ "$MOCK_COMMITS" -ge 2 ]; then
  pass "Mock commits: $MOCK_COMMITS"
else
  fail "Expected 2+ mock commits, found $MOCK_COMMITS"
fi

MOCK_FILES=$(ls .mock-output/*.txt 2>/dev/null | wc -l | tr -d ' ')
if [ "$MOCK_FILES" -ge 2 ]; then
  pass "Mock output files: $MOCK_FILES"
else
  fail "Expected 2+ mock output files, found $MOCK_FILES"
fi

# ─────────────────────────────────────────────────────────────
# 5. Verify API state
# ─────────────────────────────────────────────────────────────
echo "5. API verification"

# Verify tasks were processed: status must have changed AND review_comment must exist
# (review_comment is set by the Reviewer agent, proving the task went through the pipeline)
TASKS_JSON=$(curl -sf "$API_URL/api/v1/tasks" -H "$AUTH")

T1_STATUS=$(echo "$TASKS_JSON" | python3 -c "import json,sys; tasks=json.load(sys.stdin); print(next((t['status'] for t in tasks if t['id']=='$TASK1_ID'),'unknown'))")
T1_REVIEWED=$(echo "$TASKS_JSON" | python3 -c "import json,sys; tasks=json.load(sys.stdin); t=next((t for t in tasks if t['id']=='$TASK1_ID'),{}); print('yes' if t.get('review_comment') else 'no')")
if [ "$T1_REVIEWED" = "yes" ]; then
  pass "Task A: status=$T1_STATUS, reviewed=yes"
else
  # review_comment missing means the pipeline didn't complete fully
  fail "Task A: status=$T1_STATUS, reviewed=no (expected review_comment to be set)"
fi

T2_STATUS=$(echo "$TASKS_JSON" | python3 -c "import json,sys; tasks=json.load(sys.stdin); print(next((t['status'] for t in tasks if t['id']=='$TASK2_ID'),'unknown'))")
T2_REVIEWED=$(echo "$TASKS_JSON" | python3 -c "import json,sys; tasks=json.load(sys.stdin); t=next((t for t in tasks if t['id']=='$TASK2_ID'),{}); print('yes' if t.get('review_comment') else 'no')")
if [ "$T2_REVIEWED" = "yes" ]; then
  pass "Task B: status=$T2_STATUS, reviewed=yes"
else
  fail "Task B: status=$T2_STATUS, reviewed=no (expected review_comment to be set)"
fi

RETRO_COUNT=$(curl -sf "$API_URL/api/v1/sprints/$SPRINT_NUM/retro" -H "$AUTH" | \
  python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
if [ "$RETRO_COUNT" -ge 1 ]; then
  pass "Retro comments: $RETRO_COUNT"
else
  fail "Expected 1+ retro comments, found $RETRO_COUNT"
fi

# ─────────────────────────────────────────────────────────────
# 6. Cleanup API state
# ─────────────────────────────────────────────────────────────
echo "6. Cleanup"
curl -sf -X PATCH "$API_URL/api/v1/tasks/$TASK1_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"done"}' > /dev/null 2>&1 || true
curl -sf -X PATCH "$API_URL/api/v1/tasks/$TASK2_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"done"}' > /dev/null 2>&1 || true
curl -sf -X PATCH "$API_URL/api/v1/sprints/$SPRINT_NUM" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"review"}' > /dev/null 2>&1 || true
curl -sf -X PATCH "$API_URL/api/v1/sprints/$SPRINT_NUM" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"retrospective"}' > /dev/null 2>&1 || true
curl -sf -X PATCH "$API_URL/api/v1/sprints/$SPRINT_NUM?force=true" -H "$AUTH" -H "Content-Type: application/json" -d '{"status":"completed"}' > /dev/null 2>&1 || true
pass "API state cleaned up"

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "FULL E2E TEST FAILED"
  exit 1
else
  echo ""
  echo "FULL E2E TEST PASSED"
  exit 0
fi
