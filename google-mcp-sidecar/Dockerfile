FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY google-mcp-sidecar/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY google-mcp-sidecar/server.py /app/server.py
COPY google-mcp-sidecar/gen_token.py /app/gen_token.py

EXPOSE 8000

CMD ["python", "server.py"]
