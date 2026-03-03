#!/usr/bin/env bash
# pg-backup.sh — Backup PostgreSQL database with 7-day retention
#
# Usage:
#   ./scripts/pg-backup.sh
#
# Env vars:
#   DATABASE_URL — Postgres connection string (default: Railway public URL)
#   BACKUP_DIR  — Where to save backups (default: ./backups)
#   RETENTION   — Days to keep (default: 7)
#
# Requires: pg_dump, gzip

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"
RETENTION="${RETENTION:-7}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is required" >&2
  echo "Example: DATABASE_URL=postgresql://user:pass@gondola.proxy.rlwy.net:26001/railway ./scripts/pg-backup.sh" >&2
  exit 1
fi

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Filename with date
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/$TIMESTAMP.sql.gz"

echo "[backup] Starting pg_dump → $BACKUP_FILE"
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$BACKUP_FILE"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[backup] Done: $BACKUP_FILE ($SIZE)"

# Retention: delete backups older than N days
if [ "$RETENTION" -gt 0 ]; then
  DELETED=$(find "$BACKUP_DIR" -name "*.sql.gz" -mtime +"$RETENTION" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DELETED" -gt 0 ]; then
    echo "[backup] Cleaned up $DELETED backup(s) older than $RETENTION days"
  fi
fi

echo "[backup] Current backups:"
ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null || echo "  (none)"
