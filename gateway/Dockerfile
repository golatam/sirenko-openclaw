FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.23 \
  && cd /usr/local/lib/node_modules/openclaw \
  && npm install --no-save \
    @opentelemetry/api@^1.9.0 \
    @opentelemetry/api-logs@^0.212.0 \
    @opentelemetry/exporter-logs-otlp-proto@^0.212.0 \
    @opentelemetry/exporter-metrics-otlp-proto@^0.212.0 \
    @opentelemetry/exporter-trace-otlp-proto@^0.212.0 \
    @opentelemetry/resources@^2.5.1 \
    @opentelemetry/sdk-logs@^0.212.0 \
    @opentelemetry/sdk-metrics@^2.5.1 \
    @opentelemetry/sdk-node@^0.212.0 \
    @opentelemetry/sdk-trace-base@^2.5.1 \
    @opentelemetry/semantic-conventions@^1.39.0

WORKDIR /app
COPY openclaw.json /app/openclaw.json
COPY work-agent /app/work-agent
COPY workspace /app/workspace-image

ENV OPENCLAW_CONFIG_PATH=/app/openclaw.json
ENV NODE_ENV=production

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
