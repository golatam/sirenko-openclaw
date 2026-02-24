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
- `work_search_messages` — поиск по Gmail + Telegram
- `work_read_email` — чтение письма по ID
- `work_send_email` — отправка через Gmail (требует подтверждения)
- `work_list_calendars` — список Google Calendar
- `work_list_events` — события из календаря
- `work_schedule_meeting` — создание события (требует подтверждения)
- `work_drive_search` — поиск файлов в Google Drive
- `work_drive_read` — чтение файла из Drive
- `work_summarize_project` — сбор данных по проекту
- `work_weekly_report` — агрегация за неделю

**Google Workspace Backend**
Тулы `work_*` вызывают google-mcp-sidecar через HTTP (JSON-RPC 2.0).
Сайдкар — это `workspace-mcp` (taylorwilsdon/google_workspace_mcp), запущенный
с Streamable HTTP транспортом. OAuth-токены хранятся в Redis.

**Security / Guardrails**
- All write tools should require confirmation before execution.
- Explicit allowlist of tools in OpenClaw config.
- Separate Telegram sidecar for isolation.

**Railway Topology**
- Service A: `gateway` (OpenClaw)
- Service B: `telegram-sidecar`
- Service C: `google-mcp-sidecar` (workspace-mcp, порт 8000)
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
