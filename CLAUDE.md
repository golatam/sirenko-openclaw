# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Обзор проекта

OpenClaw Work Agent — продуктивный агент на базе OpenClaw. Агент (Сирен) занимается поиском, саммари, почтой, календарем, Telegram (пользовательские аккаунты), WhatsApp и еженедельными отчетами. Язык общения — русский по умолчанию.

Текущий статус: MVP — инфраструктура задеплоена на Railway, тулы подключены к google-mcp-sidecar, память и проактивность настроены. Подробности в `PROJECT_STATUS.md`, план в `PLAN.md`.

## Архитектура

Три сервиса + общая БД, деплой на Railway:

1. **OpenClaw Gateway** (`gateway/`) — Node.js 22, OpenClaw v2026.2.23 (глобально). Загружает плагин `work-agent` по пути. HTTP API + Telegram бот-канал. Конфиг: `gateway/openclaw.json`. Персона агента: `gateway/workspace/IDENTITY.md` и `gateway/workspace/USER.md`. Heartbeat: `gateway/workspace/HEARTBEAT.md`.

2. **Telegram Sidecar** (`telegram-sidecar/`) — Python 3.11 asyncio, Telethon (MTProto). Логинится в 3 пользовательских аккаунта через StringSession, пишет сообщения в PostgreSQL. Точка входа: `main.py`.

3. **Google MCP Sidecar** (`google-mcp-sidecar/`) — Python 3.12, FastMCP + google-api-python-client. Gmail, Calendar, Drive через MCP (JSON-RPC 2.0, Streamable HTTP). Мультиаккаунт через `GOOGLE_WORKSPACE_ACCOUNTS` JSON. Порт 8000. Зависимости: `requirements.txt`.

4. **PostgreSQL** — общий на Railway. Схема в `telegram-sidecar/schema.sql`. Две таблицы: `accounts` (подключённые аккаунты) и `messages` (нормализованное хранилище сообщений с GIN-индексом для полнотекстового поиска).

Плагин (`gateway/work-agent/index.ts`) регистрирует 10 тулов через OpenClaw plugin SDK. Тулы вызывают google-mcp-sidecar через HTTP fetch() с 30s таймаутом (JSON-RPC 2.0) и Telegram-данные из PostgreSQL.

## Persistent Storage

Workspace агента живёт на Railway volume (`/data/openclaw-state/workspace`). Entrypoint использует два паттерна:
- **Always-overwrite**: `IDENTITY.md`, `USER.md` — source of truth в git, перезаписываются при деплое
- **Seed-only**: `HEARTBEAT.md` — копируется из image только если отсутствует на volume, агент может менять в runtime

Runtime-файлы (`MEMORY.md`, `memory/*.md`, `cron/jobs.json`) создаются агентом и переживают деплои.

## Плагины

Включены: `work-agent` (кастомный), `telegram` (канал), `memory-core` (память).
Cron-подсистема включена. Heartbeat работает по умолчанию.

## Разработка

Сборка, тесты и линтер не настроены. Плагин загружается OpenClaw динамически.

### Локальный запуск

```bash
# Gateway (нужен openclaw глобально: npm install -g openclaw@2026.2.23)
cd gateway && openclaw gateway run --allow-unconfigured --port 18789

# Google MCP sidecar
cd google-mcp-sidecar && docker build -t google-mcp . && docker run -p 8000:8000 --env-file .env google-mcp

# Telegram sidecar (нужен .env по шаблону config.example.env)
cd telegram-sidecar && pip install -r requirements.txt && python main.py

# Генерация Telegram StringSession (интерактивно)
cd telegram-sidecar && python gen_session.py
```

### Деплой

Три сервиса — Docker на Railway. Gateway Dockerfile ставит OpenClaw глобально, копирует плагин и workspace-image. Entrypoint синхронизирует файлы на persistent volume. Google MCP sidecar запускает свой FastMCP сервер. Telegram sidecar ставит Python-зависимости и запускает `main.py`.

Переменные окружения — в Railway. Секреты (токены, API-ключи, session-строки) хранятся только в Railway variables, не коммитятся.

## Ключевые соглашения

- Документация ведётся на русском
- Тулы плагина используют префикс `work_` и возвращают `{ content: [...], details: {...} }`
- Схема конфигурации плагина: `gateway/work-agent/openclaw.plugin.json`
- Конфиг Gateway использует `${VAR}` для интерполяции переменных окружения
- Таблица `messages` сайдкара — общий слой данных; тулы плагина будут обращаться к ней через `dbUrl`
- Все write-тулы (email, календарь) требуют подтверждения пользователя перед выполнением
