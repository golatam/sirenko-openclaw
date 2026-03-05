"""Amplitude MCP Server — read-only analytics via Amplitude REST API.

Wraps Amplitude HTTP API v2/v3 as MCP tools. Auth via API Key + Secret Key
(HTTP Basic Auth).

Env vars:
  AMPLITUDE_API_KEY    — Amplitude project API key
  AMPLITUDE_SECRET_KEY — Amplitude project secret key
  SIDECAR_AUTH_TOKEN   — shared auth token for inter-service calls
  PORT                 — HTTP port (default 8000)
"""

import atexit
import base64
import json
import os
import re
import sys
import time
from typing import Any
from urllib.parse import urlencode

import httpx
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecurityMiddleware

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

_api_key = os.environ.get("AMPLITUDE_API_KEY", "")
_secret_key = os.environ.get("AMPLITUDE_SECRET_KEY", "")

if not _api_key or not _secret_key:
    print("[AMPLITUDE] WARNING: AMPLITUDE_API_KEY or AMPLITUDE_SECRET_KEY not set!",
          flush=True, file=sys.stderr)

_basic_auth = base64.b64encode(f"{_api_key}:{_secret_key}".encode()).decode()

_start_time = time.monotonic()
_SIDECAR_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")

_http_client: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(
            headers={
                "Authorization": f"Basic {_basic_auth}",
                "Accept": "application/json",
            },
            timeout=30.0,
        )
    return _http_client


def _amplitude_get(url: str, params: dict[str, Any] | None = None) -> dict:
    """Make authenticated GET request to Amplitude API."""
    client = _get_client()
    resp = client.get(url, params=params)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP("amplitude", stateless_http=True)


# ---------------------------------------------------------------------------
# MCP tools (6 read-only analytics tools)
# ---------------------------------------------------------------------------

@mcp.tool()
def amplitude_query(e: str, start: str, end: str,
                    m: str = "uniques", i: str = "1",
                    s: str = "", g: str = "") -> str:
    """Event Segmentation — the main analytics query tool.

    Args:
        e: Events JSON — Amplitude format, e.g. [{"event_type":"Page View"}]
        start: Start date (YYYYMMDD)
        end: End date (YYYYMMDD)
        m: Metric: uniques, totals, avg, formula (default: uniques)
        i: Interval: -300000 (real-time), 1 (daily), 7 (weekly), 30 (monthly). Default: 1
        s: Segments JSON for filtering (optional)
        g: Group by property JSON (optional)
    """
    params: dict[str, str] = {
        "e": e,
        "m": m,
        "start": start,
        "end": end,
        "i": i,
    }
    if s:
        params["s"] = s
    if g:
        params["g"] = g

    result = _amplitude_get("https://amplitude.com/api/2/events/segmentation", params)
    return json.dumps(result)


@mcp.tool()
def amplitude_funnel(e: str, start: str, end: str,
                     n: str = "14") -> str:
    """Funnel Analysis — conversion between a sequence of events.

    Args:
        e: Events JSON — ordered list of funnel steps, e.g. [{"event_type":"Sign Up"},{"event_type":"Purchase"}]
        start: Start date (YYYYMMDD)
        end: End date (YYYYMMDD)
        n: Conversion window in days (default: 14)
    """
    params = {"e": e, "start": start, "end": end, "n": n}
    result = _amplitude_get("https://amplitude.com/api/2/funnels", params)
    return json.dumps(result)


@mcp.tool()
def amplitude_retention(se: str, re: str, start: str, end: str,
                        rm: str = "bracket") -> str:
    """Retention Analysis — measure user return rates.

    Args:
        se: Start event JSON, e.g. {"event_type":"Sign Up"}
        re: Return event JSON, e.g. {"event_type":"Any Active Event"}
        start: Start date (YYYYMMDD)
        end: End date (YYYYMMDD)
        rm: Retention method: bracket or n-day (default: bracket)
    """
    params = {"se": se, "re": re, "start": start, "end": end, "rm": rm}
    result = _amplitude_get("https://amplitude.com/api/2/retention", params)
    return json.dumps(result)


@mcp.tool()
def amplitude_chart(chart_id: str) -> str:
    """Get data from a saved Amplitude chart by ID.

    Args:
        chart_id: The Amplitude chart ID (found in chart URL)
    """
    result = _amplitude_get(f"https://amplitude.com/api/3/chart/{chart_id}/query")
    return json.dumps(result)


@mcp.tool()
def amplitude_list_events() -> str:
    """List all event types in the Amplitude project.

    Returns event taxonomy — use this to discover available events
    before running queries.
    """
    result = _amplitude_get("https://amplitude.com/api/2/taxonomy/event")
    return json.dumps(result)


@mcp.tool()
def amplitude_user_search(user: str) -> str:
    """Search for users in Amplitude by email, user_id, or amplitude_id.

    Args:
        user: Search term — email address, user_id, or Amplitude ID
    """
    result = _amplitude_get("https://amplitude.com/api/2/usersearch", {"user": user})
    return json.dumps(result)


# ---------------------------------------------------------------------------
# ASGI middleware: health, auth, camelCase→snake_case normalization
# ---------------------------------------------------------------------------

def _camel_to_snake(name: str) -> str:
    """Convert camelCase / PascalCase to snake_case."""
    s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s1).lower()


def _normalize_args_app(inner):
    """ASGI middleware — health endpoint, sidecar auth, camelCase normalization."""

    async def asgi(scope, receive, send):
        if scope["type"] != "http":
            return await inner(scope, receive, send)

        path = scope.get("path", "")

        # Health endpoint
        if scope.get("method", "") == "GET" and path == "/health":
            checks: dict[str, Any] = {}
            overall = "ok"

            # Verify API credentials by checking if keys are set
            if _api_key and _secret_key:
                checks["credentials"] = {"status": "ok"}
            else:
                checks["credentials"] = {
                    "status": "error",
                    "detail": "API key or secret key not configured",
                }
                overall = "error"

            uptime = int(time.monotonic() - _start_time)
            body = json.dumps({
                "status": overall,
                "checks": checks,
                "uptime_seconds": uptime,
            }).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    [b"content-type", b"application/json"],
                    [b"content-length", str(len(body)).encode()],
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return

        # Auth check — protect MCP endpoints
        if _SIDECAR_AUTH_TOKEN:
            headers_dict = {k.decode(): v.decode() for k, v in scope.get("headers", [])}
            token = headers_dict.get("x-internal-token", "")
            if token != _SIDECAR_AUTH_TOKEN:
                body = json.dumps({"error": "unauthorized"}).encode()
                await send({
                    "type": "http.response.start",
                    "status": 401,
                    "headers": [
                        [b"content-type", b"application/json"],
                        [b"content-length", str(len(body)).encode()],
                    ],
                })
                await send({"type": "http.response.body", "body": body})
                return

        # Buffer full request body
        chunks = []
        while True:
            msg = await receive()
            if msg["type"] == "http.request":
                chunks.append(msg.get("body", b""))
                if not msg.get("more_body", False):
                    break
            elif msg["type"] == "http.disconnect":
                return

        body = b"".join(chunks)

        # Normalize camelCase arguments in tools/call requests
        try:
            data = json.loads(body)
            if isinstance(data, dict) and data.get("method") == "tools/call":
                args = data.get("params", {}).get("arguments", {})
                if args and isinstance(args, dict):
                    normalized = {_camel_to_snake(k): v for k, v in args.items()}
                    if normalized != args:
                        data["params"]["arguments"] = normalized
                        body = json.dumps(data).encode("utf-8")
                        print(f"[NORMALIZE] {list(args)} → {list(normalized)}",
                              flush=True, file=sys.stderr)
        except (json.JSONDecodeError, KeyError, TypeError):
            pass

        # Feed (possibly modified) body to inner app
        fed = False

        async def patched_receive():
            nonlocal fed
            if not fed:
                fed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return await inner(scope, patched_receive, send)

    return asgi


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

# Force JSON responses (not SSE)
try:
    mcp.settings.json_response = True
except Exception:
    pass

# Host allowlist for Railway networking
_ALLOWED_HOST_SUFFIXES = (
    ".railway.internal",
    ".up.railway.app",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
)


def _host_allowlist(self, host: str) -> bool:
    h = (host.split(":")[0] if ":" in host else host).lower()
    return any(h == s or h.endswith(s) for s in _ALLOWED_HOST_SUFFIXES)


TransportSecurityMiddleware._validate_host = _host_allowlist

app = _normalize_args_app(mcp.streamable_http_app())


def _cleanup():
    global _http_client
    if _http_client:
        _http_client.close()
        _http_client = None
    print("[SERVER] Cleanup: closed HTTP client", flush=True, file=sys.stderr)


atexit.register(_cleanup)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"[SERVER] Starting Amplitude MCP on port {port}",
          flush=True, file=sys.stderr)
    uvicorn.run(app, host="0.0.0.0", port=port)
