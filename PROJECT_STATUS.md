# Project Status — OpenClaw Work Agent

Date: 2026-02-26

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
- `telegram-sidecar` (Telethon MTProto ingestion + HTTP search API)
- `whatsapp-sidecar` (Baileys ingestion → PostgreSQL, source-agnostic search через telegram-sidecar)
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
- `gateway/work-agent/index.ts`: MCP-клиент на fetch(), 11 тулов (Gmail, Calendar, Drive, Telegram, WhatsApp search, usage)
- 30s AbortController таймаут на все fetch-вызовы
- `extractParams()` helper: извлекает params из `execute(toolUseId, params, context, callback)` (OpenClaw передаёт 4 аргумента, не 1)
- `param()` helper: резолвит snake_case/camelCase параметры (defense in depth)
- Email send: параметр `message` (не `body` — конфликтует с OpenClaw) → маппится в `body` для сайдкара
- Директория переименована `work-agent-plugin/` → `work-agent/` (соответствует manifest ID)

### Telegram
- Telegram bot channel включён и отвечает
- `telegram-sidecar`: Telethon multi-account ingestion + aiohttp HTTP search API
- `POST /search` — full-text поиск по PostgreSQL (GIN индекс, `plainto_tsquery`)
- `GET /health` — health check
- Плагин вызывает сайдкар через `fetchWithTimeout()` (аналог google-mcp-sidecar)
- 4300+ сообщений в базе, 3 аккаунта (TG1/TG2/TG3 StringSessions)
- `TELEGRAM_SIDECAR_URL` в gateway env vars → приватная сеть Railway

### WhatsApp
- `whatsapp-sidecar`: Node.js + @whiskeysockets/baileys (WhatsApp Web эмуляция)
- Ingestion в PostgreSQL (`source='whatsapp'`), та же таблица `messages`
- Поиск через telegram-sidecar (source-agnostic, параметр `source`)
- QR-паринг: `/qr` endpoint + raw строка в логах
- Auth state на volume `/data/auth_state/`
- 1 аккаунт: +34698992000 (wa1)
- Домен: `https://whatsapp-sidecar-production-93a3.up.railway.app`

### Observability
- `work_usage_summary` тул в плагине — токены и стоимость из session transcripts
- Агент может сам проверять расход и отправлять отчёт в Telegram
- Данные: daily breakdown (tokens, cost USD), per-model usage
- Используется `loadCostUsageSummary()` из OpenClaw Plugin SDK (internal module, version pinned)

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
- [x] Verify `telegram-sidecar` running and ingesting messages (2026-02-26, 4179+ msgs)
- [x] Telegram search — REST API на sidecar с PostgreSQL full-text (2026-02-26)
- [x] WhatsApp sidecar: Baileys ingestion, QR-паринг, деплой на Railway (2026-02-26)

## Files Structure
```
gateway/
  openclaw.json          — конфиг Gateway (agents, cron, channels, plugins)
  Dockerfile             — Node.js 22 + OpenClaw
  entrypoint.sh          — auth, workspace sync, session cleanup
  work-agent/            — кастомный плагин (11 тулов)
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
  main.py                — Telethon ingestion + aiohttp search API (source-agnostic)
  schema.sql             — PostgreSQL schema
  requirements.txt       — telethon, asyncpg, aiohttp
whatsapp-sidecar/
  main.js                — Baileys ingestion + HTTP health (~200 строк)
  package.json           — @whiskeysockets/baileys, pg, pino
  Dockerfile
```

## Notes
- Telegram uses MTProto user accounts via sidecar
- WhatsApp uses Baileys (WhatsApp Web emulation) via sidecar, QR pairing
- WhatsApp sidecar domain: `https://whatsapp-sidecar-production-93a3.up.railway.app`
- StringSession approach chosen for Railway (no console)
- Sensitive secrets stored only in Railway variables, never committed
