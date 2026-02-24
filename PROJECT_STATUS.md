# Project Status — OpenClaw Work Agent

Date: 2026-02-24

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

## Implemented (Google Workspace)
- `google-mcp-sidecar/` — свой MCP-сервер: FastMCP + google-api-python-client (без workspace-mcp)
- 7 MCP-тулов с мультиаккаунтом: Gmail (query, details, send), Calendar (list, create), Drive (search, read)
- `GOOGLE_WORKSPACE_ACCOUNTS` JSON → per-account OAuth credentials с кэшированием
- `work-agent-plugin/index.ts`: MCP-клиент на fetch(), 10 тулов
- google-mcp-sidecar задеплоен на Railway, GOOGLE_MCP_URL настроен
- 3 аккаунта: kirill@sirenko.ru, kirill.s@flexify.finance, ksirenko@dolphin-software.online
- MCP Streamable HTTP: JSON responses, session management

## In Progress
- Configure agent identity (IDENTITY.md/USER.md) and remove BOOTSTRAP.md.

## Pending
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
