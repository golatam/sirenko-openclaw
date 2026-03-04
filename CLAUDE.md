# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Обзор проекта

OpenClaw Work Agent — продуктивный агент на базе OpenClaw. Агент (Сирен) занимается поиском, саммари, почтой, календарем, Telegram (пользовательские аккаунты), WhatsApp и еженедельными отчетами. Язык общения — русский по умолчанию.

Текущий статус: MVP — инфраструктура задеплоена на Railway, тулы подключены к google-mcp-sidecar, память и проактивность настроены. Подробности в `PROJECT_STATUS.md`, план в `PLAN.md`.

## Архитектура

Три сервиса + общая БД, деплой на Railway:

1. **OpenClaw Gateway** (`services/gateway/`) — Node.js 22, OpenClaw v2026.2.23 (глобально). Загружает плагин `work-agent` по пути. HTTP API + Telegram бот-канал + Slack (Socket Mode, DM + каналы). Конфиг: `services/gateway/openclaw.json`. Персона агента: `services/gateway/workspace/IDENTITY.md` и `services/gateway/workspace/USER.md`. Heartbeat: `services/gateway/workspace/HEARTBEAT.md`.

2. **Telegram Sidecar** (`services/telegram-sidecar/`) — Python 3.11 asyncio, Telethon (MTProto). Логинится в 3 пользовательских аккаунта через StringSession, пишет сообщения в PostgreSQL. HTTP search API (source-agnostic: ищет и Telegram, и WhatsApp). Точка входа: `main.py`.

3. **WhatsApp Sidecar** (`services/whatsapp-sidecar/`) — Node.js 22, @whiskeysockets/baileys. Подключается к WhatsApp через QR-код (Linked Devices), пишет сообщения в ту же таблицу `messages` (`source='whatsapp'`). Только ingestion, поиск через telegram-sidecar. Точка входа: `main.js`.

4. **Google MCP Sidecar** (`services/google-mcp-sidecar/`) — Python 3.12, FastMCP + google-api-python-client. Gmail, Calendar, Drive через MCP (JSON-RPC 2.0, Streamable HTTP). Мультиаккаунт через `GOOGLE_WORKSPACE_ACCOUNTS` JSON. Порт 8000. Зависимости: `requirements.txt`.

5. **PostgreSQL** — общий на Railway. Схема в `services/telegram-sidecar/schema.sql`. Две таблицы: `accounts` (подключённые аккаунты) и `messages` (нормализованное хранилище сообщений с GIN-индексом для полнотекстового поиска).

Плагин (`services/gateway/work-agent/index.ts`) регистрирует 14 тулов через OpenClaw plugin SDK. OpenClaw вызывает `execute(toolUseId, params, context, callback)` — хелпер `extractParams()` извлекает params из аргументов. Тулы вызывают google-mcp-sidecar через HTTP fetch() с 30s таймаутом (JSON-RPC 2.0) и Telegram-данные из PostgreSQL.

## Persistent Storage

Workspace агента живёт на Railway volume (`/data/openclaw-state/workspace`). Entrypoint использует три паттерна:
- **Always-overwrite**: `IDENTITY.md`, `USER.md` — source of truth в git, перезаписываются при деплое
- **Seed-only**: `HEARTBEAT.md` — копируется из image только если отсутствует на volume, агент может менять в runtime
- **Merge**: `cron/jobs.json` — определения jobs из `cron-seed.json`, runtime state (`nextRunAtMs`, `lastRunAtMs` и т.д.) сохраняется из volume. Это критично для `runMissedJobs()` — без сохранённого state пропущенные jobs не обнаруживаются.

Runtime-файлы (`MEMORY.md`, `memory/*.md`) переживают деплои.

## Плагины

Включены: `work-agent` (кастомный), `telegram` (канал), `memory-core` (файловая память + Gemini vector search), `lobster` (workflow chains).
Cron-подсистема включена: утренний брифинг (пн-пт 9:00 Madrid) + еженедельный отчёт (пт 16:00 Madrid) + health check (каждые 30 мин). Формат `cron-seed.json`: `{ "version": 1, "jobs": [...] }`. Heartbeat работает по умолчанию.

## Разработка

Сборка, тесты и линтер не настроены. Плагин загружается OpenClaw динамически.

### Локальный запуск

```bash
# Все сервисы через Docker Compose (рекомендуется):
cp .env.example .env   # заполнить секретами из Railway
docker compose up --build

# Или по отдельности:
# Gateway (нужен openclaw глобально: npm install -g openclaw@2026.2.23)
cd services/gateway && openclaw gateway run --allow-unconfigured --port 18789

# Google MCP sidecar
cd services/google-mcp-sidecar && docker build -t google-mcp . && docker run -p 8000:8000 --env-file .env google-mcp

# Telegram sidecar (нужен .env по шаблону config.example.env)
cd services/telegram-sidecar && pip install -r requirements.txt && python main.py

# Генерация Telegram StringSession (интерактивно)
cd services/telegram-sidecar && python gen_session.py
```

### Деплой

Три сервиса — Docker на Railway. Gateway Dockerfile ставит OpenClaw глобально, копирует плагин и workspace-image. Entrypoint синхронизирует файлы на persistent volume. Google MCP sidecar запускает свой FastMCP сервер. Telegram sidecar ставит Python-зависимости и запускает `main.py`.

Переменные окружения — в Railway. Секреты (токены, API-ключи, session-строки) хранятся только в Railway variables, не коммитятся.

## Git workflow

- **Ветки**: `feature/<name>`, `fix/<name>` → PR → `main`
- **Теги**: `vX.Y.Z` для версий деплоя (e.g. `v0.6.0`)
- Railway деплоит автоматически из `main`

## Ключевые соглашения

- Документация ведётся на русском
- Тулы плагина используют префикс `work_` и возвращают `{ content: [...], details: {...} }`
- Схема конфигурации плагина: `services/gateway/work-agent/openclaw.plugin.json`
- Конфиг Gateway использует `${VAR}` для интерполяции переменных окружения
- Таблица `messages` сайдкара — общий слой данных; тулы плагина будут обращаться к ней через `dbUrl`
- Все write-тулы (email, календарь) требуют подтверждения пользователя перед выполнением
