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
- [ ] Деплой google-mcp-sidecar на Railway
- [ ] OAuth-авторизация Gmail-аккаунтов
- [ ] Добавить GOOGLE_MCP_URL в переменные gateway на Railway
- [ ] Проверить end-to-end: отправка письма, создание события

## Phase 4 — Search & Reports (Pending)
- Implement unified search across sources
- Implement weekly reports and scheduling
- Add tool guardrails and confirmation flows

## Phase 5 — Hardening (Pending)
- Monitoring and health checks
- Backups + retention
- Access policy review
