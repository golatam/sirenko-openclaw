FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
  && echo "deb http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.3.2 clawhub @clawdbot/lobster@2026.1.24 \
  && echo "[dockerfile] lobster CLI installed: $(lobster --version 2>&1 || echo 'version unknown')"

WORKDIR /app
COPY openclaw.json /app/openclaw.json
COPY work-agent /app/work-agent
COPY workspace /app/workspace-image
COPY cron-seed.json /app/cron-seed.json

ENV OPENCLAW_CONFIG_PATH=/app/openclaw.json
ENV NODE_ENV=production

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-18789}/ || exit 1

STOPSIGNAL SIGTERM
CMD ["/app/entrypoint.sh"]
