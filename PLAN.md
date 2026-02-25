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
- [x] **Claude OAuth auth** — переход с platform API key на OAuth (Max подписка)
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

### Аутентификация Anthropic (Claude)

**Было**: `ANTHROPIC_API_KEY` (платформенный ключ, оплата per-call)
**Стало**: `ANTHROPIC_OAUTH_TOKEN` (OAuth через Claude Max подписка)

Как работает:
- `gateway/entrypoint.sh` при старте пишет `auth-profiles.json` из env var
- OpenClaw читает auth store и использует OAuth токен
- Используется `type: "api_key"` в auth-profiles (OpenClaw воспринимает OAuth token как API key)
- `ANTHROPIC_API_KEY` удалён — OpenClaw его всё равно очищает (clearEnv)

Генерация нового токена: `openclaw models auth setup-token --provider anthropic`

## Phase 4 — Search & Reports (Pending)
- Implement unified search across sources
- Implement weekly reports and scheduling
- Add tool guardrails and confirmation flows

## Phase 5 — Архитектурные улучшения

### Критичные (делать сейчас)
- [x] Убрать дубликат `work-agent-plugin/` (оставить только `gateway/work-agent-plugin/`)
- [x] Добавить `requirements.txt` для google-mcp-sidecar с пинами версий
- [x] Добавить таймаут (AbortController) на fetch() в MCP-клиенте (`index.ts`)
- [x] Расширить `.gitignore` — исключить `*.env`, `__pycache__/`, `node_modules/`

### Важные (улучшают надёжность)
- [ ] Реструктурировать репо: `services/` + `plugins/` вместо плоской структуры
- [ ] Реализовать Telegram search — REST API на telegram-sidecar с PostgreSQL full-text
- [ ] Добавить health check endpoints на оба сайдкара
- [ ] Создать `docker-compose.yml` для локальной разработки (3 сервиса + Postgres)

### Желательные (масштабируемость)
- [ ] Выделить MCP-клиент из `index.ts` в отдельный `mcp-client.ts`
- [ ] Абстракция `adapter.ts` над OpenClaw Plugin SDK (защита от обновлений)
- [ ] Feature branches workflow вместо прямых коммитов в main
- [ ] Git tags для версий деплоя (`v0.1.0`, `v0.2.0`)
- [ ] Smoke-тесты: gateway запускается, MCP-сервер отвечает на health

## Phase 6 — Hardening (Pending)
- Monitoring and health checks
- Backups + retention
- Access policy review
