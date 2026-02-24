# Plan — OpenClaw Work Agent

## Phase 1 — Infrastructure (Done)
- Install OpenClaw
- Create plugin skeleton
- Create Telegram sidecar
- Create Railway project, services, Postgres, Redis
- Deploy Gateway + sidecar

## Phase 2 — Messaging Ingest (In Progress)
- Confirm `telegram-sidecar` is running
- Verify ingestion in Postgres
- Connect WhatsApp to Gateway

## Phase 3 — Gmail/GCal/Drive Integration (In Progress)
- [x] Создан google-mcp-sidecar (workspace-mcp, Dockerfile, порт 8000)
- [x] Плагин переписан: MCP-клиент на fetch(), 10 тулов вместо 5 стабов
- [x] Конфиг обновлён: mcpServerUrl + dbUrl
- [x] Деплой google-mcp-sidecar на Railway
- [x] OAuth-авторизация — 3 refresh token'а получены
- [x] kirill@sirenko.ru — работает (single-account)
- [x] **Мультиаккаунт** — свой MCP-сервер (без workspace-mcp)
- [ ] Проверить end-to-end: отправка письма, создание события
- [ ] Удалить `GOOGLE_WORKSPACE_REFRESH_TOKEN` из Railway после проверки

### Реализация мультиаккаунта

**Решение**: полностью заменили workspace-mcp на свой MCP-сервер.
- `server.py` (~280 строк): FastMCP + google-api-python-client
- 7 тулов с `account` параметром, Google API напрямую
- `GOOGLE_WORKSPACE_ACCOUNTS` JSON → per-account Credentials с кэшированием
- Те же MCP tool names — плагин не менялся

### OAuth credentials (справка)

**Client**: `GOOGLE_WORKSPACE_CLIENT_ID` и `GOOGLE_WORKSPACE_CLIENT_SECRET` — в Railway env vars.

**Аккаунты (3 шт, scopes: gmail.modify, calendar, drive)**:
1. `kirill@sirenko.ru` — refresh token в Railway
2. `kirill.s@flexify.finance` — refresh token в Railway
3. `ksirenko@dolphin-software.online` — refresh token в Railway

**Railway env vars**:
- `GOOGLE_WORKSPACE_ACCOUNTS` = JSON с тремя refresh-токенами
- `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET` — OAuth client
- `GOOGLE_WORKSPACE_REFRESH_TOKEN` = legacy single-account — удалить после проверки

**Скрипт генерации токенов**: `google-mcp-sidecar/gen_token.py`

## Phase 4 — Search & Reports (Pending)
- Implement unified search across sources
- Implement weekly reports and scheduling
- Add tool guardrails and confirmation flows

## Phase 5 — Hardening (Pending)
- Monitoring and health checks
- Backups + retention
- Access policy review
