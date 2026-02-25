# OpenClaw Work Agent Architecture

**Goal**
Single-purpose agent for: search, summaries, email, calendar, Telegram (user accounts), WhatsApp, and weekly reports.

**Core Decision**
Use OpenClaw Gateway as the primary runtime and add:
- A custom plugin-pack for Gmail/Calendar/search/report tools.
- A Telegram MTProto sidecar for **user accounts** (3 accounts).

**Services**
1. OpenClaw Gateway (`gateway/`)
- Node.js 22, OpenClaw v2026.2.23
- Telegram bot channel (Telegram Bot API)
- WhatsApp channel (Baileys) — pending
- Control UI for management
- Tools exposed via `work-agent` plugin
- Plugins: `work-agent`, `telegram`, `memory-core`
- Cron-подсистема для запланированных задач
- Heartbeat для проактивных проверок (каждые ~30 мин)

2. Google MCP Sidecar (`google-mcp-sidecar/`)
- Python 3.12, FastMCP (`stateless_http=True`)
- google-api-python-client напрямую (без workspace-mcp)
- 7 MCP-тулов с `account` параметром для мультиаккаунта
- OAuth credentials через `GOOGLE_WORKSPACE_ACCOUNTS` JSON
- Transport: MCP Streamable HTTP (JSON-RPC 2.0), порт 8000

3. Telegram Sidecar (`telegram-sidecar/`)
- Python 3.11, Telethon (MTProto)
- Logs into 3 user accounts via StringSession
- Ingests messages into Postgres
- Optional outbound sending hook later

**Data**
Postgres (shared):
- `messages`: normalized message store with GIN index for full-text search
- `accounts`: connected identities (telegram user accounts)

**Persistent Storage (Railway Volumes)**
- `gateway-volume` → `/data/openclaw-state`:
  - `workspace/` — agent workspace (IDENTITY.md, USER.md, HEARTBEAT.md, memory/, MEMORY.md)
  - `agents/` — auth profiles, session data
  - `cron/jobs.json` — scheduled tasks
- `telegram-sidecar-volume` → `/data` — Telethon session files

**Workspace File Lifecycle**
- **Always-overwrite** (source of truth = git): `IDENTITY.md`, `USER.md`
- **Seed-only** (agent может менять в runtime): `HEARTBEAT.md`
- **Runtime-only** (создаются агентом): `MEMORY.md`, `memory/*.md`

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
Тулы `work_*` вызывают google-mcp-sidecar через HTTP (JSON-RPC 2.0, MCP Streamable HTTP).
Сайдкар — свой MCP-сервер на FastMCP + google-api-python-client.
OAuth credentials кэшируются per-account. Все fetch-вызовы с 30s AbortController таймаутом.

**Proactivity**
- **Heartbeat** (~30 мин): проверка срочной почты, напоминания о встречах. Инструкции в `HEARTBEAT.md`.
- **Cron**: запланированные задачи (утренний брифинг, еженедельный отчёт). Агент может создавать cron-задачи через встроенные `cron.add` / `cron.remove` тулы.
- **Memory**: `memory-core` плагин — `MEMORY.md` (долгосрочная память) + `memory/YYYY-MM-DD.md` (дневные логи).

**Security / Guardrails**
- All write tools should require confirmation before execution
- Explicit allowlist of plugins in OpenClaw config
- Separate Telegram sidecar for isolation
- Secrets stored only in Railway env vars, never committed

**Railway Topology**
- Service A: `gateway` (OpenClaw) + volume `/data/openclaw-state`
- Service B: `google-mcp-sidecar` (FastMCP, порт 8000)
- Service C: `telegram-sidecar` + volume `/data`
- Add-ons: Postgres + Redis
