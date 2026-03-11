FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl gosu \
  && rm -rf /var/lib/apt/lists/*

RUN adduser --system --no-create-home --group appuser \
  && mkdir -p /data/auth_state && chown -R appuser:appuser /data

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY main.js /app/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8080}/health || exit 1

STOPSIGNAL SIGTERM
CMD ["/app/entrypoint.sh"]
