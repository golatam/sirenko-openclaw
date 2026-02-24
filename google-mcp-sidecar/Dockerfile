FROM python:3.11-slim

RUN pip install --no-cache-dir workspace-mcp

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["workspace-mcp", "--transport", "streamable-http", "--tool-tier", "core", "--port", "8000"]
