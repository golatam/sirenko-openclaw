FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.23

WORKDIR /app
COPY openclaw.json /app/openclaw.json
COPY work-agent /app/work-agent
COPY workspace /app/workspace-image

ENV OPENCLAW_CONFIG_PATH=/app/openclaw.json
ENV NODE_ENV=production

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
