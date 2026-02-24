FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.23

WORKDIR /app
COPY openclaw.json /app/openclaw.json
COPY work-agent-plugin /app/work-agent-plugin
COPY workspace /app/workspace

ENV OPENCLAW_CONFIG_PATH=/app/openclaw.json
ENV NODE_ENV=production

CMD ["/bin/sh", "-c", "openclaw gateway run --allow-unconfigured --port ${PORT:-18789}"]
