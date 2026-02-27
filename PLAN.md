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

## Phase 3.5 — Память, проактивность и плагины

### Память агента
- [x] `memory-core` плагин включён (был заблокирован `plugins.allow`)
- [x] Workspace перенесён на persistent volume (`/data/openclaw-state/workspace`)
- [x] Статичные файлы (IDENTITY.md, USER.md) синхронизируются из image при старте
- [ ] Перейти на `memory-lancedb` для auto-recall/auto-capture (нужен OpenAI API key для embeddings)

### Проактивность
- [x] Heartbeat — запущен по умолчанию
- [x] `HEARTBEAT.md` в workspace — проверка срочной почты, напоминания о встречах (seed-only)
- [x] Cron включён: `"cron": { "enabled": true }` в `openclaw.json`
- [ ] Настроить cron-задачи: утренний брифинг, еженедельный отчёт

### Плагины (встроенные OpenClaw)

**Включены:**
- `work-agent` — кастомный плагин (Gmail, Calendar, Drive, Telegram)
- `telegram` — канал Telegram Bot
- `memory-core` — файловая память (MEMORY.md + daily logs)

**Рекомендуется добавить:**
- [x] `work_usage_summary` тул — токены и стоимость из session transcripts (вместо diagnostics-otel) (2026-02-26)

**Рассмотреть позже:**
- `memory-lancedb` — замена memory-core, семантический поиск (нужен OpenAI key)
- `lobster` — цепочки тулов с approval gates (inbox triage, weekly review pipeline)
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

- [ ] Добавить `tools.media.audio` в `gateway/openclaw.json` (Groq provider)
- [ ] Получить `GROQ_API_KEY` на groq.com и добавить в Railway env vars (сервис gateway)
- [ ] Задеплоить gateway
- [ ] Тест: отправить голосовое боту в Telegram

### 4b — Ingestion: голосовые в мониторимых чатах (вторично)

Сайдкары дропают voice-сообщения при ingestion (text=NULL). Для поиска по чужим голосовым нужна отдельная транскрипция в сайдкарах.

- [ ] telegram-sidecar: детектить voice/audio, скачивать через Telethon `download_media()`, транскрибировать через Groq
- [ ] whatsapp-sidecar: детектить `audioMessage`, скачивать через Baileys `downloadMediaMessage()`, транскрибировать через Groq
- [ ] metadata_json: добавить `media_type: "voice"` (схема JSONB уже поддерживает)
- [ ] Добавить `GROQ_API_KEY` в Railway env vars (оба сайдкара)

## Phase 4.5 — Railway → Slack уведомления (Pending)

- [ ] Создать Slack Incoming Webhook (api.slack.com/apps → Incoming Webhooks → Add New)
- [ ] Добавить webhook в Railway: Dashboard → Project Settings → Webhooks
- [ ] Проверить: deploy, crash, resource alerts приходят в Slack
- ~~Slack Activity Alerts template~~ — заменено нативными Railway Webhooks (не нужен отдельный сервис)

## Phase 5 — Search & Reports (Pending)
- Implement unified search across sources
- Implement weekly reports and scheduling
- Add tool guardrails and confirmation flows

## Phase 6 — Архитектурные улучшения

### Критичные (делать сейчас)
- [x] Убрать дубликат `work-agent-plugin/` (оставить только `gateway/work-agent-plugin/`)
- [x] Добавить `requirements.txt` для google-mcp-sidecar с пинами версий
- [x] Добавить таймаут (AbortController) на fetch() в MCP-клиенте (`index.ts`)
- [x] Расширить `.gitignore` — исключить `*.env`, `__pycache__/`, `node_modules/`

### Важные (улучшают надёжность)
- [ ] Реструктурировать репо: `services/` + `plugins/` вместо плоской структуры
- [x] Telegram search — REST API на telegram-sidecar с PostgreSQL full-text (2026-02-26)
- [ ] Добавить health check endpoints на оба сайдкара
- [ ] Создать `docker-compose.yml` для локальной разработки (3 сервиса + Postgres)

### Желательные (масштабируемость)
- [ ] Выделить MCP-клиент из `index.ts` в отдельный `mcp-client.ts`
- [ ] Абстракция `adapter.ts` над OpenClaw Plugin SDK (защита от обновлений)
- [ ] Feature branches workflow вместо прямых коммитов в main
- [ ] Git tags для версий деплоя (`v0.1.0`, `v0.2.0`)
- [ ] Smoke-тесты: gateway запускается, MCP-сервер отвечает на health

## Phase 7 — Hardening (Pending)
- Monitoring and health checks
- Backups + retention
- Access policy review
