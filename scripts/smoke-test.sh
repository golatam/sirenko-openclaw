#!/usr/bin/env bash
# Smoke test — verify all services respond to health checks.
# Usage: ./scripts/smoke-test.sh
# Assumes docker compose is running (make up).

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
GOOGLE_MCP_URL="${GOOGLE_MCP_URL:-http://localhost:8001}"
TELEGRAM_SIDECAR_URL="${TELEGRAM_SIDECAR_URL:-http://localhost:8002}"
WHATSAPP_SIDECAR_URL="${WHATSAPP_SIDECAR_URL:-http://localhost:8003}"

PASS=0
FAIL=0

check() {
  local name="$1" url="$2"
  if curl -sf --max-time 5 "$url" > /dev/null 2>&1; then
    echo "  OK   $name ($url)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name ($url)"
    FAIL=$((FAIL + 1))
  fi
}

echo "Smoke test — health endpoints"
echo "--------------------------------------"
check "Gateway"             "$GATEWAY_URL/health"
check "Google MCP Sidecar"  "$GOOGLE_MCP_URL/health"
check "Telegram Sidecar"    "$TELEGRAM_SIDECAR_URL/health"
check "WhatsApp Sidecar"    "$WHATSAPP_SIDECAR_URL/health"
echo "--------------------------------------"
echo "Results: $PASS passed, $FAIL failed"

[ "$FAIL" -eq 0 ] || exit 1
