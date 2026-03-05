# Project Status — OpenClaw Work Agent

Date: 2026-03-05

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
- `gateway` (OpenClaw Gateway v2026.3.2 + work-agent plugin + memory-core)
- `google-mcp-sidecar` (FastMCP, 9 тулов, мультиаккаунт)
- `telegram-sidecar` (Telethon MTProto ingestion + HTTP search API)
- `whatsapp-sidecar` (Baileys ingestion → PostgreSQL, source-agnostic search через telegram-sidecar)
- `Postgres`
- `Redis`

External:
- Amplitude — official MCP server (`mcp.amplitude.com/mcp`), OAuth 2.0, 25+ тулов

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
- `services/gateway/work-agent/index.ts`: MCP-клиент на fetch(), 17 тулов (Gmail, Calendar, Drive, Telegram, WhatsApp search, usage, channel info, Slack send, health check, backup, Amplitude)
- `work_get_channel_info` — возвращает context текущего разговора (канал, source, user); логирует полный context в stderr
- `work_slack_send` — отправка сообщений в Slack (DM по email или channel ID); используется cron-задачами
- 30s AbortController таймаут на все fetch-вызовы
- `extractParams()` helper: извлекает params из `execute(toolUseId, params, context, callback)` (OpenClaw передаёт 4 аргумента, не 1)
- `param()` helper: резолвит snake_case/camelCase параметры (defense in depth)
- Email send: параметр `message` (не `body` — конфликтует с OpenClaw) → маппится в `body` для сайдкара
- Директория переименована `work-agent-plugin/` → `work-agent/` (соответствует manifest ID)
- Код разделён: `mcp-client.ts` (MCP session), `utils.ts` (хелперы), `index.ts` (тулы)

### Search & Reports (Phase 5)
- `work_search` — унифицированный поиск по 5 источникам (Gmail, Telegram, WhatsApp, Drive, Calendar) с параллельным выполнением
- `work_weekly_report` — сбор данных из всех источников (Gmail, Calendar, Telegram, Drive) для еженедельного отчёта
- `work_summarize_project` — саммари проекта из Gmail, Telegram, Drive (параллельно через Promise.allSettled)
- Confirmation guardrails: `work_send_email` и `work_schedule_meeting` используют preview/confirm flow
  - Без `confirmed` → preview с `confirmation_id` (детерминистичный SHA-256 хеш от payload)
  - С `confirmed: true` + `confirmation_id` → проверка хеша → выполнение
  - Stateless: хеш воспроизводим, не нужно хранить в памяти
- IDENTITY.md: инструкции по алгоритму подтверждения для агента

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

### Slack
- Slack канал — built-in в OpenClaw (не плагин), Socket Mode (WebSocket)
- `dmPolicy: "open"` — DM доступен всем
- `groupPolicy: "open"` — бот отвечает в каналах
- `channels: { "*": { requireMention: false } }` — отвечает на все сообщения без @mention
- `nativeStreaming: true` — ответы печатаются в реальном времени
- Токены: `SLACK_APP_TOKEN` (xapp-...) + `SLACK_BOT_TOKEN` (xoxb-...) в Railway env vars

### Агент (Клавито / Clavito)
- Персона: IDENTITY.md (мотиватор, без лести, краткость), USER.md (предпочтения, аккаунты)
- Память по каналам: 1 Slack-канал = 1 папка в workspace (автосоздание при первом сообщении)
- `work_get_channel_info` тул для определения текущего канала
- `memory-core` плагин включён — persistent memory (MEMORY.md + workspace files)
- `HEARTBEAT.md` — стоячие инструкции (проверка срочной почты, напоминания о встречах)
- Heartbeat запущен по умолчанию (~30 мин)
- Cron-подсистема включена, 2 задачи: утренний брифинг (пн-пт 9:00 Madrid) + еженедельный отчёт (пт 16:00 Madrid)
- Cron seed: `gateway/cron-seed.json` → volume `cron/jobs.json` (seed-only через entrypoint)
- Lobster plugin включён: CLI `@clawdbot/lobster@2026.1.24` установлен в Dockerfile, `tools.alsoAllow: ["lobster"]` — typed workflows с approval gates

### Hardening (Phase 7)
- Deep health checks: все 4 сервиса возвращают `{status, checks, uptime_seconds}` с реальной диагностикой
  - google-mcp-sidecar: проверка OAuth credentials per account
  - telegram-sidecar: DB connectivity (`SELECT 1`) + Telethon client status per account
  - whatsapp-sidecar: DB connectivity + WhatsApp connection status
  - gateway plugin: `work_health_check` тул — пробирует все сайдкары параллельно
- Docker HEALTHCHECK во всех Dockerfiles (Railway auto-restart при unhealthy)
  - Gateway: 60s interval, 120s start-period (медленный старт OpenClaw)
  - Сайдкары: 30s interval, 30s start-period
- Cron health check: каждые 30 мин, алерт в Slack при degraded/error
- HEARTBEAT.md: добавлена проверка здоровья системы
- `scripts/pg-backup.sh`: pg_dump с 7-дневным retention

### Automated Backups (Phase 8d)
- Google Drive as backup storage (existing OAuth, zero new deps)
- `drive_upload` + `drive_delete` MCP-тулы в google-mcp-sidecar
- `backup.ts` модуль: pg_dump → gzip, tar memory files, fetch WA auth state
- Periodic task: check every 6h, backup if >23h since last; 14-day retention with auto-cleanup
- `work_backup` тул для ручного запуска
- Slack alert при ошибках, silent при успехе
- State: `/data/openclaw-state/backup-status.json`

### Security & Reliability (Phase 9)
- **9a Bugfixes**: `work_list_calendars` вызывает правильный MCP-тул; WhatsApp health status корректно показывает `error`
- **9b Security**: `SIDECAR_AUTH_TOKEN` — единый auth token для всех сайдкаров (`X-Internal-Token` header); host allowlist в google-mcp-sidecar; `_resolve_account()` возвращает 400 при неизвестном аккаунте
- **9c Reliability**: message dedup (`UNIQUE` partial index + `ON CONFLICT DO NOTHING`); supervisor loop с exponential backoff в telegram-sidecar; graceful shutdown (SIGTERM handlers) во всех сайдкарах; `STOPSIGNAL SIGTERM` во всех Dockerfiles
- **Voice retry**: транскрипция голосовых с retry (3 попытки, backoff 3s→6s→12s) при Groq 429 rate limit (оба сайдкара)

### Amplitude — Official MCP Server (Phase 8a v2)
- Заменён кастомный amplitude-mcp-sidecar на подключение к официальному `mcp.amplitude.com/mcp`
- OAuth 2.0 PKCE: Dynamic Client Registration, `offline_access` scope, auto-refresh при 401
- `McpClient` расширен: `McpAuthProvider` интерфейс, `OAuthBearerProvider` + `InternalAuthProvider`
- Два тула: `work_amplitude_tools` (discovery 25+ тулов) + `work_amplitude_call` (passthrough)
- Token state: `/data/openclaw-state/amplitude-oauth.json` — access_token переживает рестарты
- Скрипт: `scripts/gen_amplitude_token.py` (Python stdlib, без pip зависимостей)
- Env vars: `AMPLITUDE_OAUTH_CLIENT_ID`, `AMPLITUDE_OAUTH_ACCESS_TOKEN`, `AMPLITUDE_OAUTH_REFRESH_TOKEN`

## Pending
- [x] Проверить end-to-end: отправка письма, создание события (2026-02-25)
- [x] Удалить `GOOGLE_WORKSPACE_REFRESH_TOKEN` из Railway (2026-02-25)
- [x] Настроить cron-задачи: утренний брифинг (9:00 Madrid, пн-пт), еженедельный отчёт (пт 16:00 Madrid) — delivery через work_slack_send (2026-03-02)
- [x] Verify `telegram-sidecar` running and ingesting messages (2026-02-26, 4179+ msgs)
- [x] Telegram search — REST API на sidecar с PostgreSQL full-text (2026-02-26)
- [x] WhatsApp sidecar: Baileys ingestion, QR-паринг, деплой на Railway (2026-02-26)
- [x] Voice messages Phase 4a: Groq Whisper v3 в бот-канале (`tools.media.audio` + `GROQ_API_KEY`) (2026-02-27)
- [x] Voice messages Phase 4b: транскрипция голосовых в сайдкарах — Groq Whisper v3, metadata_json с media_type/transcribed (2026-03-02)
- [x] Добавить `GROQ_API_KEY` в Railway env vars для telegram-sidecar и whatsapp-sidecar (2026-03-02)
- [x] Настроить Railway Webhooks → Slack (нативная интеграция, см. Phase 4.5 в PLAN.md) (2026-03-02)

## Files Structure
```
services/
  gateway/
    openclaw.json          — конфиг Gateway (agents, cron, channels, plugins)
    Dockerfile             — Node.js 22 + OpenClaw
    entrypoint.sh          — auth, workspace sync, cron seed, session cleanup
    cron-seed.json         — seed для cron/jobs.json (2 задачи: briefing + weekly report)
    work-agent/            — кастомный плагин (15 тулов)
      index.ts             — plugin registration, tool definitions
      mcp-client.ts        — MCP JSON-RPC 2.0 session management
      utils.ts             — fetchWithTimeout, extractParams, param, ok/err, confirmationId
      backup.ts            — automated backup orchestration (pg + memory + WA → Drive)
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
scripts/
  smoke-test.sh            — curl health endpoints для всех сервисов
  gen_amplitude_token.py   — OAuth token generator для Amplitude MCP
docker-compose.yml
Makefile
CLAUDE.md, PLAN.md, PROJECT_STATUS.md, .env.example
```

## Notes
- Telegram uses MTProto user accounts via sidecar
- WhatsApp uses Baileys (WhatsApp Web emulation) via sidecar, QR pairing
- WhatsApp sidecar domain: `https://whatsapp-sidecar-production-93a3.up.railway.app`
- StringSession approach chosen for Railway (no console)
- Sensitive secrets stored only in Railway variables, never committed
