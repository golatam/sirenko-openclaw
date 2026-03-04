#!/bin/sh
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/root/.openclaw}"
AUTH_DIR="$STATE_DIR/agents/main/agent"

# --- Persistent workspace on volume ---
# Static files (IDENTITY.md, USER.md) come from the image.
# Runtime files (memory/, MEMORY.md, etc.) live on the persistent volume.
PERSIST_WORKSPACE="$STATE_DIR/workspace"
mkdir -p "$PERSIST_WORKSPACE"

# Sync static identity files from image → volume (always overwrite with latest from git)
for f in IDENTITY.md USER.md .gitkeep; do
  if [ -f "/app/workspace-image/$f" ]; then
    cp "/app/workspace-image/$f" "$PERSIST_WORKSPACE/$f"
  fi
done

# Seed-only files: copy from image ONLY if not yet on volume (agent may edit at runtime)
for f in HEARTBEAT.md; do
  if [ -f "/app/workspace-image/$f" ] && [ ! -f "$PERSIST_WORKSPACE/$f" ]; then
    cp "/app/workspace-image/$f" "$PERSIST_WORKSPACE/$f"
    echo "[entrypoint] Seeded $f"
  fi
done

# --- Sync cron jobs (merge: update definitions from seed, preserve runtime state) ---
mkdir -p "$STATE_DIR/cron"
CRON_STORE="$STATE_DIR/cron/jobs.json"
if [ -f "$CRON_STORE" ]; then
  # Merge seed into existing store: take job definitions from seed,
  # but preserve state/timestamps from the runtime store so that
  # runMissedJobs() can detect and catch up on missed schedules.
  node -e '
    const fs = require("fs");
    const seed = JSON.parse(fs.readFileSync("/app/cron-seed.json", "utf-8"));
    const store = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    const storeMap = new Map((store.jobs || []).map(j => [j.id, j]));
    const merged = (seed.jobs || []).map(seedJob => {
      const existing = storeMap.get(seedJob.id);
      if (!existing) return seedJob;
      // Keep runtime state and timestamps, overwrite everything else from seed
      return {
        ...seedJob,
        state: existing.state || {},
        createdAtMs: existing.createdAtMs,
        updatedAtMs: existing.updatedAtMs
      };
    });
    const out = { version: 1, jobs: merged };
    fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
  ' "$CRON_STORE"
  echo "[entrypoint] Merged cron/jobs.json (preserved runtime state)"
else
  cp /app/cron-seed.json "$CRON_STORE"
  echo "[entrypoint] Seeded cron/jobs.json (first run)"
fi

echo "[entrypoint] Workspace on persistent volume: $PERSIST_WORKSPACE"

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
