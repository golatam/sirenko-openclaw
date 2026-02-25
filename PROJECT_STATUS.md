# Project Status — OpenClaw Work Agent

Date: 2026-02-25

## Goal
Build a focused agent using OpenClaw for:
- Search and summaries across email/messaging
- Gmail send
- Google Calendar scheduling
- Telegram (user accounts, 3 accounts)
- WhatsApp (1 account)
- Weekly project reports
- Proactive reminders and notifications

## Architecture
See: `ARCHITECTURE.md`

## Current Services (Railway)
Project: `openclaw-work-agent`
Services:
- `gateway` (OpenClaw Gateway v2026.2.23 + work-agent plugin + memory-core)
- `google-mcp-sidecar` (FastMCP, 7 тулов, мультиаккаунт)
- `telegram-sidecar` (Telethon MTProto ingestion)
- `Postgres`
- `Redis`

Volumes:
- `gateway-volume` → `/data/openclaw-state` (workspace, memory, cron, sessions)
- `telegram-sidecar-volume` → `/data` (Telethon sessions)
- `postgres-volume`, `redis-volume`

Gateway domain:
- `https://gateway-production-1382.up.railway.app`

## Implemented

### Infrastructure
- Railway project: 4 сервиса + Postgres + Redis
- Gateway Dockerfile: OpenClaw глобально, плагин, workspace
- Persistent volume для workspace агента (memory, HEARTBEAT.md переживают деплои)
- Entrypoint: два паттерна — always-overwrite (IDENTITY.md, USER.md) и seed-only (HEARTBEAT.md)
- Claude OAuth auth (Max подписка вместо platform API key)

### Google Workspace
- `google-mcp-sidecar/` — свой MCP-сервер: FastMCP + google-api-python-client
- 7 MCP-тулов с мультиаккаунтом: Gmail (query, details, send), Calendar (list, create), Drive (search, read)
- `GOOGLE_WORKSPACE_ACCOUNTS` JSON → per-account OAuth credentials с кэшированием
- `requirements.txt` с pinned-версиями зависимостей
- MCP Streamable HTTP: JSON responses, session management
- ASGI middleware: camelCase → snake_case нормализация аргументов (OpenClaw конвертирует snake_case параметры)
- 3 аккаунта: kirill@sirenko.ru, kirill.s@flexify.finance, ksirenko@dolphin-software.online

### Plugin (work-agent)
- `gateway/work-agent/index.ts`: MCP-клиент на fetch(), 10 тулов
- 30s AbortController таймаут на все fetch-вызовы
- `extractParams()` helper: извлекает params из `execute(toolUseId, params, context, callback)` (OpenClaw передаёт 4 аргумента, не 1)
- `param()` helper: резолвит snake_case/camelCase параметры (defense in depth)
- Email send: параметр `message` (не `body` — конфликтует с OpenClaw) → маппится в `body` для сайдкара
- Директория переименована `work-agent-plugin/` → `work-agent/` (соответствует manifest ID)

### Telegram
- Telegram bot channel включён и отвечает
- `telegram-sidecar`: Telethon, multi-account, Postgres ingest
- TG1/TG2/TG3 StringSessions в Railway vars

### Агент (Сирен)
- Персона: IDENTITY.md (стиль, тон), USER.md (предпочтения, аккаунты)
- `memory-core` плагин включён — persistent memory (MEMORY.md + daily logs)
- `HEARTBEAT.md` — стоячие инструкции (проверка срочной почты, напоминания о встречах)
- Heartbeat запущен по умолчанию (~30 мин)
- Cron-подсистема включена (задачи пока не настроены)

## Pending
- [x] Проверить end-to-end: отправка письма, создание события (2026-02-25)
- [x] Удалить `GOOGLE_WORKSPACE_REFRESH_TOKEN` из Railway (2026-02-25)
- [ ] Настроить cron-задачи: утренний брифинг, еженедельный отчёт
- [ ] Verify `telegram-sidecar` running and ingesting messages
- [ ] WhatsApp channel login for Gateway
- [ ] Telegram search — REST API на sidecar с PostgreSQL full-text

## Files Structure
```
gateway/
  openclaw.json          — конфиг Gateway (agents, cron, channels, plugins)
  Dockerfile             — Node.js 22 + OpenClaw
  entrypoint.sh          — auth, workspace sync, session cleanup
  work-agent/            — кастомный плагин (10 тулов)
  workspace/
    IDENTITY.md          — персона агента (always-overwrite)
    USER.md              — данные пользователя (always-overwrite)
    HEARTBEAT.md         — инструкции heartbeat (seed-only)
google-mcp-sidecar/
  server.py              — FastMCP + Google API (~280 строк)
  requirements.txt       — pinned dependencies
  Dockerfile
  gen_token.py           — скрипт генерации OAuth refresh token
telegram-sidecar/
  main.py                — Telethon MTProto ingestion
  schema.sql             — PostgreSQL schema
  requirements.txt
```

## Notes
- Telegram uses MTProto user accounts via sidecar
- StringSession approach chosen for Railway (no console)
- Sensitive secrets stored only in Railway variables, never committed
