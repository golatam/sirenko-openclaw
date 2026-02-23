# Telegram Sidecar (Telethon)

Purpose: log in with **user accounts** (3 accounts) and ingest messages into Postgres for OpenClaw tools.

## Setup
1. Install deps:
   - `python3 -m venv .venv`
   - `source .venv/bin/activate`
   - `pip install -r requirements.txt`

2. Apply DB schema:
   - `psql "$DATABASE_URL" -f schema.sql`

3. Configure env:
   - copy `config.example.env` to `.env` and fill values

4. Run:
   - `python main.py`

## Environment
- `DATABASE_URL`
- `TG1_API_ID`, `TG1_API_HASH`, `TG1_PHONE`
- `TG1_SESSION` (optional, StringSession)
- `TG2_API_ID`, `TG2_API_HASH`, `TG2_PHONE`
- `TG2_SESSION` (optional, StringSession)
- `TG3_API_ID`, `TG3_API_HASH`, `TG3_PHONE`
- `TG3_SESSION` (optional, StringSession)
- `SYNC_HISTORY_ON_START` (0/1)
- `HISTORY_PER_CHAT` (default 50)
- `PRINT_SESSION_STRING` (0/1) prints StringSession after login when no session provided
- `TG_SESSION_DIR` (directory for .session files, e.g. `/data`)

## Notes
- Session files are stored in `TG_SESSION_DIR` if set, otherwise in the working directory (unless StringSession is used). Use a persistent volume on Railway.
- First run will prompt for login code in console if no StringSession is provided.
- Telegram userbots can violate ToS in some contexts. Proceed intentionally.
