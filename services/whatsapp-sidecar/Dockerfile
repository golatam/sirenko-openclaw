FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN adduser --system --no-create-home --group appuser \
  && mkdir -p /data/auth_state && chown -R appuser:appuser /data

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY main.js /app/

ENV NODE_ENV=production

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-8080}/health || exit 1

STOPSIGNAL SIGTERM
CMD ["node", "main.js"]
