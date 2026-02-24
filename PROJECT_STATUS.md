# Project Status — OpenClaw Work Agent

Date: 2026-02-23

## Goal
Build a focused agent using OpenClaw for:
- Search and summaries across email/messaging
- Gmail send
- Google Calendar scheduling
- Telegram (user accounts, 3 accounts)
- WhatsApp (1 account)
- Weekly project reports

## Architecture
See: `ARCHITECTURE.md`

## Current Services (Railway)
Project: `openclaw-work-agent`
Services:
- `gateway` (OpenClaw Gateway + work-agent plugin)
- `telegram-sidecar` (Telethon MTProto ingestion)
- `Postgres`
- `Redis`

Gateway domain:
- `https://gateway-production-1382.up.railway.app`

## Implemented
- Telegram bot channel enabled and responding in Gateway.
- OpenClaw installed locally.
- `work-agent` plugin skeleton created.
- `telegram-sidecar` implemented (Telethon, multi-account, Postgres ingest).
- Railway project created; services + Postgres + Redis added.
- Gateway Dockerfile and sidecar Dockerfile created.
- Sidecar uses persistent volume `/data` for sessions and optional StringSession.
- TG1/TG2/TG3 StringSessions generated and stored in Railway vars.

## In Progress
- Configure agent identity (IDENTITY.md/USER.md) and remove BOOTSTRAP.md.

## Implemented (Google Workspace)
- `google-mcp-sidecar/` — Dockerfile + config для workspace-mcp (Gmail, Calendar, Drive)
- `work-agent-plugin/index.ts` переписан: MCP-клиент на fetch(), 10 реальных тулов вместо 5 стабов
- `openclaw.plugin.json` обновлён: mcpServerUrl + dbUrl вместо отдельных gmail/gcal секций
- `gateway/openclaw.json` обновлён: передаёт GOOGLE_MCP_URL и DATABASE_URL в плагин

## Pending
- Деплой google-mcp-sidecar на Railway
- OAuth-авторизация Gmail-аккаунтов (локально → Redis)
- Добавить GOOGLE_MCP_URL в переменные gateway на Railway
- Verify `telegram-sidecar` running successfully and ingesting messages.
- WhatsApp channel login for Gateway.
- Add tool allowlist and guardrails in OpenClaw config.
- Configure weekly reports via OpenClaw cron.

## Files Added
- `ARCHITECTURE.md`
- `work-agent-plugin/*`
- `telegram-sidecar/*`
- `gateway/*`
- `google-mcp-sidecar/*`

## Notes
- Telegram uses MTProto user accounts via sidecar.
- StringSession approach chosen for Railway (no console).
- Sensitive secrets should not be shared in chat.
