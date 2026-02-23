# OpenClaw Work Agent Architecture

**Goal**
Single-purpose agent for: search, summaries, email, calendar, Telegram (user accounts), WhatsApp, and weekly reports.

**Core Decision**
Use OpenClaw Gateway as the primary runtime and add:
- A custom plugin-pack for Gmail/Calendar/search/report tools.
- A Telegram MTProto sidecar for **user accounts** (3 accounts).

**Services**
1. OpenClaw Gateway
- WhatsApp channel (Baileys) via Gateway.
- Control UI for management.
- Tools exposed via `work-agent` plugin.

2. Telegram Sidecar (MTProto)
- Logs into 3 user accounts.
- Ingests messages into Postgres.
- Optional outbound sending hook later.

**Data**
Postgres (shared):
- `messages`: normalized message store for search + summaries.
- `projects`: project metadata and labels.
- `accounts`: connected identities (gmail/gcal/telegram/whatsapp).
- `reports`: stored weekly report outputs.
- `jobs`: background tasks (sync, report generation).

**Tool Surface (OpenClaw)**
- `work_search_messages`
- `work_summarize_project`
- `work_send_email`
- `work_schedule_meeting`
- `work_weekly_report`

**Security / Guardrails**
- All write tools should require confirmation before execution.
- Explicit allowlist of tools in OpenClaw config.
- Separate Telegram sidecar for isolation.

**Railway Topology**
- Service A: `gateway` (OpenClaw)
- Service B: `telegram-sidecar`
- Add-ons: Postgres + Redis
- Persistent volume for Telegram session files

**Operational Flow**
1. Messages arrive via WhatsApp or Telegram.
2. Ingested and normalized into Postgres.
3. OpenClaw tools query Postgres for search/summaries.
4. Reports generated on-demand or via cron.

**Next Implementation Steps**
1. Enable `work-agent` plugin path in `~/.openclaw/openclaw.json`.
2. Add OAuth clients for Gmail/GCal in OpenClaw config.
3. Build Telegram sidecar service with MTProto login.
4. Wire indexing + summaries to Postgres.
5. Deploy both services on Railway.
