#!/bin/sh
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
AUTH_DIR="$STATE_DIR/agents/main/agent"

# Write OAuth auth profile from env var (Max subscription token)
if [ -n "$ANTHROPIC_OAUTH_TOKEN" ]; then
  mkdir -p "$AUTH_DIR"
  printf '{"version":1,"profiles":{"anthropic:oauth":{"type":"api_key","provider":"anthropic","key":"%s"}}}' \
    "$ANTHROPIC_OAUTH_TOKEN" > "$AUTH_DIR/auth-profiles.json"
  echo "[entrypoint] Auth profile written to $AUTH_DIR/auth-profiles.json"
fi

# Clean stale sessions and locks from previous container runs
rm -rf "$STATE_DIR/agents/main/sessions" 2>/dev/null
find "$STATE_DIR" -name '*.lock' -delete 2>/dev/null

exec openclaw gateway run --allow-unconfigured --port "${PORT:-18789}"
