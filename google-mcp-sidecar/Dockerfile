FROM python:3.12-slim

RUN pip install --no-cache-dir \
    google-api-python-client \
    google-auth \
    google-auth-oauthlib \
    mcp \
    uvicorn

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY google-mcp-sidecar/server.py /app/server.py
COPY google-mcp-sidecar/gen_token.py /app/gen_token.py

EXPOSE 8000

CMD ["python", "server.py"]
