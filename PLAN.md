# Plan — OpenClaw Work Agent

## Phase 1 — Infrastructure (Done)
- Install OpenClaw
- Create plugin skeleton
- Create Telegram sidecar
- Create Railway project, services, Postgres, Redis
- Deploy Gateway + sidecar

## Phase 2 — Messaging Ingest (Done)
- [x] Confirm `telegram-sidecar` is running
- [x] Verify ingestion in Postgres (4300+ msgs)
- [x] WhatsApp sidecar: Baileys ingestion → PostgreSQL (source-agnostic search)
- [x] WhatsApp: QR-паринг + первый запуск на Railway (2026-02-26, +34698992000)

## Phase 3 — Gmail/GCal/Drive Integration (Done)
- [x] Создан google-mcp-sidecar (workspace-mcp, Dockerfile, порт 8000)
- [x] Плагин переписан: MCP-клиент на fetch(), 10 тулов вместо 5 стабов
- [x] Конфиг обновлён: mcpServerUrl + dbUrl
- [x] Деплой google-mcp-sidecar на Railway
- [x] OAuth-авторизация — 3 refresh token'а получены
- [x] kirill@sirenko.ru — работает (single-account)
- [x] **Мультиаккаунт** — свой MCP-сервер (без workspace-mcp)
- [x] **Claude OAuth auth** — переход с platform API key на OAuth (Max подписка)
- [x] Проверить end-to-end: отправка письма, создание события
- [x] Удалить `GOOGLE_WORKSPACE_REFRESH_TOKEN` из Railway после проверки

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
- ~~`GOOGLE_WORKSPACE_REFRESH_TOKEN`~~ — удалён (2026-02-25)

**Скрипт генерации токенов**: `services/google-mcp-sidecar/gen_token.py`

### Аутентификация Anthropic (Claude)

**Было**: `ANTHROPIC_API_KEY` (платформенный ключ, оплата per-call)
**Стало**: `ANTHROPIC_OAUTH_TOKEN` (OAuth через Claude Max подписка)

Как работает:
- `services/gateway/entrypoint.sh` при старте пишет `auth-profiles.json` из env var
- OpenClaw читает auth store и использует OAuth токен
- Используется `type: "api_key"` в auth-profiles (OpenClaw воспринимает OAuth token как API key)
- `ANTHROPIC_API_KEY` удалён — OpenClaw его всё равно очищает (clearEnv)

Генерация нового токена: `openclaw models auth setup-token --provider anthropic`

## Phase 3.5 — Память, проактивность и плагины

### Память агента
- [x] `memory-core` плагин включён (был заблокирован `plugins.allow`)
- [x] Workspace перенесён на persistent volume (`/data/openclaw-state/workspace`)
- [x] Статичные файлы (IDENTITY.md, USER.md) синхронизируются из image при старте
- [ ] ~~Перейти на `memory-lancedb`~~ — откат на memory-core (2026-03-03): плагин поддерживает только OpenAI embeddings, не Gemini. Можно вернуть позже с `OPENAI_API_KEY` (~$0.02/1M tokens)

### Проактивность
- [x] Heartbeat — запущен по умолчанию
- [x] `HEARTBEAT.md` в workspace — проверка срочной почты, напоминания о встречах (seed-only)
- [x] Cron включён: `"cron": { "enabled": true }` в `openclaw.json`
- [x] Настроить cron-задачи: утренний брифинг (9:00 Madrid, пн-пт) + еженедельный отчёт (пт 16:00 Madrid) (2026-03-02)
- [x] `work_slack_send` тул — DM по email через Slack API (delivery для cron, минуя баги announce) (2026-03-02)
- [x] `services/gateway/cron-seed.json` → seed-only copy в entrypoint → `cron/jobs.json` на volume (2026-03-02)

### Плагины (встроенные OpenClaw)

**Включены:**
- `work-agent` — кастомный плагин (Gmail, Calendar, Drive, Telegram)
- `telegram` — канал Telegram Bot
- `memory-core` — файловая память (MEMORY.md + workspace). memorySearch с Gemini для vector-поиска по файлам

**Рекомендуется добавить:**
- [x] `work_usage_summary` тул — токены и стоимость из session transcripts (вместо diagnostics-otel) (2026-02-26)

**Рассмотреть позже:**
- `memory-lancedb` — auto-recall/auto-capture; требует OPENAI_API_KEY (text-embedding-3-small ~$0.02/1M tokens)
- [x] `lobster` — цепочки тулов с approval gates; CLI `@clawdbot/lobster@2026.1.24` установлен, `tools.alsoAllow` + `entries.lobster.enabled` (2026-03-03)
- `whatsapp` — WhatsApp Business канал (Phase 2)

**Не нужно:** остальные 30+ встроенных плагинов (Discord, Slack, IRC, Signal, Matrix, auth-провайдеры, voice-call, etc.)

## Phase 4 — Voice Messages (Pending)

Голосовые сообщения сейчас полностью теряются — OpenClaw'овский telegram-плагин дропает voice, сайдкары сохраняют только text.

### Ресёрч STT-провайдеров (2026-02-26)

| Провайдер | Цена/мин | Latency (60с) | Русский | Free tier |
|-----------|----------|---------------|---------|-----------|
| **Groq Whisper v3** | $0.002 | <0.5с | ~5-8% WER, проверен | 480 мин/день бессрочно |
| Deepgram Nova-3 | $0.008 | <0.3с | Proprietary, WER не публикуют | $200 кредитов (~433ч) |
| OpenAI Whisper | $0.006 | 3-10с | ~5-8% WER | Нет |
| Google Cloud STT | $0.016-0.036 | 2-5с | Хорошо | 60 мин/мес |
| Self-hosted Whisper | ~$10/мес flat | 15-30с (CPU) | Зависит от модели | — |

**Выбор: Groq Whisper Large v3** — дешевле всех, быстрее всех, лучший русский, OpenAI-совместимый API.

Deepgram сильнее в streaming, diarization, code-switching — но для batch-транскрипции коротких голосовых это не нужно. Claude API не поддерживает аудио вход. Telegram built-in — Premium-only.

### 4a — Бот-канал: ты → Сирен (приоритет)

OpenClaw v2026.2.23 имеет встроенный media pipeline для аудио (`tools.media.audio`). Достаточно конфига + API key.

- OpenClaw скачивает voice через Bot API `getFile()`, отправляет в Groq, подставляет транскрипт в `{{Transcript}}`
- OGG/Opus (нативный формат голосовых Telegram) — конвертация не нужна
- В группах с `requireMention: true` голосовые транскрибируются до проверки упоминания

```json
"tools": {
  "media": {
    "audio": {
      "enabled": true,
      "models": [{ "provider": "groq", "model": "whisper-large-v3" }]
    }
  }
}
```

- [x] Добавить `tools.media.audio` в `services/gateway/openclaw.json` (Groq provider) (2026-02-27)
- [x] Получить `GROQ_API_KEY` на groq.com и добавить в Railway env vars (сервис gateway) (2026-02-27)
- [x] Задеплоить gateway (2026-02-27)
- [x] Тест: отправить голосовое боту в Telegram (2026-02-27) ✓

### 4b — Ingestion: голосовые в мониторимых чатах (Done, 2026-03-02)

Сайдкары дропают voice-сообщения при ingestion (text=NULL). Для поиска по чужим голосовым нужна отдельная транскрипция в сайдкарах.

- [x] telegram-sidecar: детектить voice/audio, скачивать через Telethon `download_media()`, транскрибировать через Groq (2026-03-02)
- [x] whatsapp-sidecar: детектить `audioMessage`, скачивать через Baileys `downloadContentFromMessage()`, транскрибировать через Groq (2026-03-02)
- [x] metadata_json: добавить `media_type: "voice"`, `transcribed: true` / `transcription_failed: true` (2026-03-02)
- [x] Добавить `GROQ_API_KEY` в Railway env vars (оба сайдкара) (2026-03-02)

## Phase 4.5 — Railway → Slack уведомления (Done)

- [x] Настроен Railway Webhook → Slack (deploy, crash, resource alerts)
- ~~Slack Activity Alerts template~~ — заменено нативными Railway Webhooks (не нужен отдельный сервис)

## Phase 5 — Search & Reports (Done)
- [x] `work_search` — унифицированный поиск по 5 источникам (Gmail, Telegram, WhatsApp, Drive, Calendar) с параллельным выполнением
- [x] `work_weekly_report` — сбор данных из Gmail, Calendar, Telegram, Drive для еженедельного отчёта
- [x] `work_summarize_project` — саммари по проекту из Gmail, Telegram, Drive (параллельно)
- [x] Cron-задачи: утренний брифинг (пн-пт 9:00 Madrid) + еженедельный отчёт (пт 16:00 Madrid) (2026-03-02)
- [x] Confirmation guardrails для `work_send_email` и `work_schedule_meeting` — preview/confirm flow с детерминистичным confirmation_id (2026-03-03)
- [x] Drive-данные в `work_weekly_report` и `work_summarize_project` (2026-03-03)
- [x] IDENTITY.md — инструкции по алгоритму подтверждения (2026-03-03)

## Phase 6 — Архитектурные улучшения

### Критичные (делать сейчас)
- [x] Убрать дубликат `work-agent-plugin/` (оставить только `services/gateway/work-agent/`)
- [x] Добавить `requirements.txt` для google-mcp-sidecar с пинами версий
- [x] Добавить таймаут (AbortController) на fetch() в MCP-клиенте (`index.ts`)
- [x] Расширить `.gitignore` — исключить `*.env`, `__pycache__/`, `node_modules/`

### Важные (улучшают надёжность)
- [x] Реструктурировать репо: все сервисы в `services/` (2026-03-03)
- [x] Telegram search — REST API на telegram-sidecar с PostgreSQL full-text (2026-02-26)
- [x] Добавить health check endpoints на оба сайдкара (2026-03-03)
- [x] Создать `docker-compose.yml` для локальной разработки (5 сервисов + Postgres + Redis) (2026-03-02)

### Желательные (масштабируемость)
- [x] Выделить MCP-клиент из `index.ts` в `mcp-client.ts` + `utils.ts` (2026-03-03)
- [ ] Абстракция `adapter.ts` над OpenClaw Plugin SDK (защита от обновлений)
- [x] Feature branches workflow вместо прямых коммитов в main (2026-03-03)
- [x] Git tags для версий деплоя — `v0.6.0` (2026-03-03)
- [x] Smoke-тесты: `scripts/smoke-test.sh` + `Makefile` (2026-03-03)

## Phase 7 — Hardening (Done)

Контекст: агент лежал ~1 час (CRASHED → FAILED билды), ни одного алерта не пришло. Причины: невалидный конфиг + несинхронизированные root directories.

- [x] Deep health checks — все 4 сервиса возвращают `{status, checks, uptime_seconds}` с реальной диагностикой (2026-03-03)
  - google-mcp-sidecar: OAuth credential validation per account
  - telegram-sidecar: DB connectivity + Telethon client status
  - whatsapp-sidecar: DB connectivity + WhatsApp connection status
  - gateway: `work_health_check` тул — пробирует все сайдкары параллельно
- [x] Docker HEALTHCHECK — все 4 Dockerfile'а (Railway auto-restart при unhealthy) (2026-03-03)
  - Gateway: `--interval=60s --start-period=120s --retries=3`
  - Сайдкары: `--interval=30s --start-period=30s --retries=3`
- [x] Cron health check — каждые 30 мин, алерт в Slack только при degraded/error (2026-03-03)
- [x] HEARTBEAT.md — проверка здоровья при каждом heartbeat тике (2026-03-03)
- [x] `scripts/pg-backup.sh` — pg_dump + gzip, 7-day retention (2026-03-03)

Не вошло (overkill для текущего масштаба): centralized logging, Grafana/metrics, UptimeRobot

## Phase 8 — Аналитика, финансы и бэкапы

### 8a — Amplitude MCP Server
- [ ] Подключить Amplitude MCP Server к gateway (аналитика продуктов)
- [ ] Добавить тулы для агента: просмотр чартов, когорт, дашбордов, query по данным
- [ ] Настроить env vars (`AMPLITUDE_API_KEY`, etc.) в Railway

### 8b — Google Analytics MCP Server
- [ ] Подключить Google Analytics MCP Server к gateway
- [ ] Тулы для агента: отчёты по трафику, конверсиям, аудиториям
- [ ] OAuth credentials — возможно расширить существующие scopes в google-mcp-sidecar или отдельный сервер

### 8c — Финансовый скилл
- [ ] Ресёрч: какие MCP-серверы / API подходят для ведения финансов (учёт расходов, инвойсы, банковские выписки)
- [ ] Варианты: интеграция с банковским API, Google Sheets как БД, специализированный сервис (Plaid, Mercury, etc.)
- [ ] Определить scope: личные финансы, бизнес-финансы, или оба

### 8d — Резервные копии (память и критичные данные)
- [ ] Определить что бэкапить: память агента (`MEMORY.md`, `memory/*.md`), PostgreSQL (messages, accounts), auth state (WhatsApp, Telegram sessions)
- [ ] Организовать автоматический бэкап памяти агента (сейчас только на Railway volume — single point of failure)
- [ ] Расширить `scripts/pg-backup.sh` — автоматический запуск по cron (Railway cron job или внешний)
- [ ] Стратегия хранения: S3/R2, Google Drive, или GitHub (приватный репо)
- [ ] Восстановление: документировать процедуру восстановления из бэкапа

## Phase 9 — Security & Reliability (Done)

Источник: аудит Codex (gpt-5.3-codex) от 2026-03-03.

### 9a — Баги (Low effort)
- [x] Починить `work_list_calendars` — вызывает `calendar_get_events` вместо списка календарей (`index.ts:367-387`) (2026-03-05)
- [x] Починить WhatsApp health status — `status:error` показывает `overall=degraded` вместо `error` (`main.js:354`) (2026-03-05)

### 9b — Security Hardening
- [x] Host validation: allowlist (`*.railway.internal`, Railway public URLs) в `TransportSecurityMiddleware` (2026-03-05)
- [x] Sidecar API auth: `SIDECAR_AUTH_TOKEN` + `X-Internal-Token` header middleware на все сайдкары; `/health` открыт (2026-03-05)
- [x] Account fallback: `_resolve_account()` возвращает 400 при неизвестном аккаунте (2026-03-05)

### 9c — Reliability
- [x] Message dedup: `UNIQUE(source, account_label, thread_id, message_id)` partial index + `ON CONFLICT DO NOTHING` (2026-03-05)
- [x] Telethon task supervision: `supervise_account()` loop с exponential backoff (5s→300s) (2026-03-05)
- [x] Graceful shutdown: SIGTERM/SIGINT handlers, `STOPSIGNAL SIGTERM` во всех Dockerfiles (2026-03-05)
- [x] Voice transcription retry: 3 попытки с backoff (3s→6s→12s) при Groq 429 rate limit (оба сайдкара) (2026-03-05)
