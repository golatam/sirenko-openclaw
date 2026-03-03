FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.23 clawhub \
  && LOBSTER_BIN=$(find /usr/local/lib/node_modules/openclaw -name lobster -type f -path '*/bin/*' 2>/dev/null | head -1) \
  && if [ -n "$LOBSTER_BIN" ]; then ln -sf "$LOBSTER_BIN" /usr/local/bin/lobster && echo "[dockerfile] lobster CLI linked from $LOBSTER_BIN"; \
     else echo "[dockerfile] lobster CLI not found in openclaw package — plugin will degrade gracefully"; fi

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

CMD ["/app/entrypoint.sh"]
