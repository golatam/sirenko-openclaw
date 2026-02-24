# Google MCP Sidecar

MCP-сервер для Gmail, Google Calendar и Google Drive. Обёртка над [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (v1.12.0+, MIT).

## Что делает

- **Gmail**: поиск, чтение, отправка писем, черновики
- **Calendar**: список календарей, события, создание событий
- **Drive**: поиск файлов, чтение, шаринг

Работает как HTTP-сервер (JSON-RPC 2.0, Streamable HTTP transport) на порту 8000.

## Локальный запуск

```bash
# Скопировать и заполнить .env
cp config.example.env .env

# Собрать и запустить
docker build -t google-mcp .
docker run -p 8000:8000 --env-file .env google-mcp
```

## Проверка

```bash
# Список доступных тулов
curl -X POST http://localhost:8000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## OAuth-авторизация аккаунтов

При первом запуске нужно авторизовать каждый Gmail-аккаунт:

1. Запустить сервер локально (без Docker, чтобы открылся браузер):
   ```bash
   pip install workspace-mcp
   workspace-mcp --transport streamable-http --port 8000
   ```
2. Вызвать тул авторизации — откроется браузер для OAuth
3. Токены сохраняются в `~/.google-mcp-accounts/`

Для Railway: настроить Redis (`GOOGLE_MCP_REDIS_URL`) и перенести токены.

## Деплой на Railway

- Dockerfile: из этой директории
- Переменные: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_MCP_REDIS_URL`, `TOOL_TIER=core`
- Internal URL: `http://google-mcp-sidecar.railway.internal:8000`
