FROM python:3.11-slim

RUN pip install --no-cache-dir google-workspace-mcp

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["google-workspace-worker", "--transport", "sse", "--port", "8000"]
