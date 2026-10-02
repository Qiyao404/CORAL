#!/usr/bin/env bash
# CORAL v1.1.0 · 端到端冒烟测试（macOS / Linux）
# 用法：./scripts/e2e/smoke.sh [baseUrl]

set +e
BASE_URL="${1:-http://localhost:3001}"
PASS=0
FAIL=0

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  [PASS] $name"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  CORAL v1.1.0 · E2E 冒烟测试 ($BASE_URL)          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

echo "【1】基础健康检查"
check "GET /api/health" curl -fsS "$BASE_URL/api/health"

DASHSCOPE_OK=$(curl -fsS "$BASE_URL/api/config" | grep -c 'coding.dashscope')
if [ "$DASHSCOPE_OK" -gt 0 ]; then
  echo "  [PASS] /api/config 含 dashscope coding endpoint"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] /api/config 不是 dashscope coding"
  FAIL=$((FAIL + 1))
fi

check "GET /api/stats" curl -fsS "$BASE_URL/api/stats"

echo ""
echo "【2】Skill CRUD"
check "GET /api/skills" curl -fsS "$BASE_URL/api/skills"
check "GET /api/skills?source=builtin" curl -fsS "$BASE_URL/api/skills?source=builtin"

echo ""
echo "【3】公司画像"
check "GET /api/company-profile" curl -fsS "$BASE_URL/api/company-profile"

echo ""
echo "【4】Skill Builder"
SESSION_ID=$(curl -fsS -X POST -H "Content-Type: application/json" -d '{"userId":"smoke-tester"}' "$BASE_URL/api/skill-builder/sessions" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
if [ -n "$SESSION_ID" ]; then
  echo "  [PASS] POST /api/skill-builder/sessions → $SESSION_ID"
  PASS=$((PASS + 1))
  check "GET 会话详情" curl -fsS "$BASE_URL/api/skill-builder/sessions/$SESSION_ID"
else
  echo "  [FAIL] POST /api/skill-builder/sessions"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "════════════════════════════════════════════════════"
echo "  通过：$PASS  失败：$FAIL"
echo "════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
