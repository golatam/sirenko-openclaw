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

## Phase 3 — Gmail/GCal Integration (Pending)
- Add Gmail search/send tools
- Add GCal list/create tools
- Store tokens in Postgres

## Phase 4 — Search & Reports (Pending)
- Implement unified search across sources
- Implement weekly reports and scheduling
- Add tool guardrails and confirmation flows

## Phase 5 — Hardening (Pending)
- Monitoring and health checks
- Backups + retention
- Access policy review
