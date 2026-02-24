FROM python:3.12-slim

RUN pip install --no-cache-dir google-workspace-mcp uvicorn

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY google-mcp-sidecar/server.py /app/server.py

EXPOSE 8000

CMD ["python", "server.py"]
