"""Google Workspace MCP Server — own implementation with multi-account.

Replaces workspace-mcp dependency. Uses google-api-python-client directly.
MCP transport: Streamable HTTP via FastMCP.

Env vars:
  GOOGLE_WORKSPACE_ACCOUNTS      — JSON {"email": "refresh_token", ...}
  GOOGLE_WORKSPACE_CLIENT_ID     — OAuth client ID
  GOOGLE_WORKSPACE_CLIENT_SECRET — OAuth client secret
  GOOGLE_WORKSPACE_REFRESH_TOKEN — (legacy) single-account fallback
  PORT                           — HTTP port (default 8000)
"""

import base64
import json
import os
import re
import sys
from email.mime.text import MIMEText
from typing import Any

import uvicorn
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecurityMiddleware

# ---------------------------------------------------------------------------
# Credentials management
# ---------------------------------------------------------------------------

_client_id = (os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
              or os.environ.get("GOOGLE_WORKSPACE_CLIENT_ID", ""))
_client_secret = (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
                  or os.environ.get("GOOGLE_WORKSPACE_CLIENT_SECRET", ""))

# {email: refresh_token}
_accounts: dict[str, str] = {}

# Cached google.oauth2.credentials.Credentials per email
_creds_cache: dict[str, Credentials] = {}

# Cached API service objects per (email, api, version)
_service_cache: dict[tuple[str, str, str], Any] = {}


def _load_accounts():
    raw = os.environ.get("GOOGLE_WORKSPACE_ACCOUNTS")
    if raw:
        try:
            data = json.loads(raw)
            _accounts.update(data)
            print(f"[ACCOUNTS] Loaded {len(data)} account(s): {', '.join(data.keys())}",
                  flush=True, file=sys.stderr)
        except json.JSONDecodeError as e:
            print(f"[ACCOUNTS] Failed to parse GOOGLE_WORKSPACE_ACCOUNTS: {e}",
                  flush=True, file=sys.stderr)

    # Legacy single-account fallback
    legacy_token = os.environ.get("GOOGLE_WORKSPACE_REFRESH_TOKEN")
    if legacy_token and not _accounts:
        _accounts["default"] = legacy_token
        print("[ACCOUNTS] Using legacy GOOGLE_WORKSPACE_REFRESH_TOKEN as 'default'",
              flush=True, file=sys.stderr)

    if not _accounts:
        print("[ACCOUNTS] WARNING: No accounts configured!", flush=True, file=sys.stderr)


_load_accounts()


def _resolve_account(account: str | None) -> str:
    """Resolve account email to a key in _accounts."""
    if account and account in _accounts:
        return account
    # Return first account if none specified or account not found
    if _accounts:
        first = next(iter(_accounts))
        if account and account not in _accounts:
            print(f"[AUTH] Account '{account}' not found, falling back to '{first}'",
                  flush=True, file=sys.stderr)
        return first
    raise ValueError("No Google accounts configured")


def _get_credentials(account: str | None) -> Credentials:
    """Get (cached) OAuth credentials for an account."""
    key = _resolve_account(account)

    cached = _creds_cache.get(key)
    if cached and cached.valid:
        return cached

    if cached and cached.expired and cached.refresh_token:
        try:
            cached.refresh(Request())
            return cached
        except Exception:
            pass  # Create fresh below

    creds = Credentials(
        token=None,
        refresh_token=_accounts[key],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=_client_id,
        client_secret=_client_secret,
    )
    creds.refresh(Request())
    _creds_cache[key] = creds
    print(f"[AUTH] Credentials OK for {key}", flush=True, file=sys.stderr)
    return creds


def _get_service(account: str | None, api: str, version: str):
    """Get (cached) Google API service object."""
    key = _resolve_account(account)
    cache_key = (key, api, version)

    if cache_key in _service_cache:
        creds = _get_credentials(key)
        if creds.valid:
            return _service_cache[cache_key]

    creds = _get_credentials(key)
    service = build(api, version, credentials=creds, cache_discovery=False)
    _service_cache[cache_key] = service
    return service


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------

mcp = FastMCP("google-workspace", stateless_http=True)


# ---------------------------------------------------------------------------
# Gmail tools
# ---------------------------------------------------------------------------

def _query_gmail_single(account_key: str, query: str, max_results: int) -> list[dict]:
    """Query Gmail for a single account, return list of message dicts."""
    gmail = _get_service(account_key, "gmail", "v1")
    resp = gmail.users().messages().list(
        userId="me", q=query, maxResults=max_results
    ).execute()

    messages = resp.get("messages", [])
    results = []
    for msg_ref in messages:
        msg = gmail.users().messages().get(
            userId="me", id=msg_ref["id"], format="metadata",
            metadataHeaders=["From", "To", "Subject", "Date"]
        ).execute()

        headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
        results.append({
            "id": msg["id"],
            "threadId": msg.get("threadId"),
            "snippet": msg.get("snippet", ""),
            "from": headers.get("From", ""),
            "to": headers.get("To", ""),
            "subject": headers.get("Subject", ""),
            "date": headers.get("Date", ""),
            "labelIds": msg.get("labelIds", []),
            "account": account_key,
        })
    return results


@mcp.tool()
def query_gmail_emails(query: str, max_results: int = 20, account: str = "") -> str:
    """Search Gmail messages by query string.

    When account is empty, searches ALL connected accounts and merges results.

    Args:
        query: Gmail search query (same syntax as Gmail search box)
        max_results: Maximum number of results to return (per account when searching all)
        account: Gmail account email. Empty = search all accounts.
    """
    if account:
        results = _query_gmail_single(account, query, max_results)
        return json.dumps({"messages": results, "total": len(results)})

    # No account specified — query ALL accounts
    all_results: list[dict] = []
    for acct in _accounts:
        try:
            all_results.extend(_query_gmail_single(acct, query, max_results))
        except Exception as e:
            print(f"[GMAIL] Error querying {acct}: {e}", flush=True, file=sys.stderr)

    # Sort by date descending (newest first)
    all_results.sort(key=lambda m: m.get("date", ""), reverse=True)
    return json.dumps({"messages": all_results, "total": len(all_results)})


@mcp.tool()
def gmail_get_message_details(message_id: str, account: str = "") -> str:
    """Get full details of a Gmail message by ID.

    Args:
        message_id: Gmail message ID
        account: Gmail account email (optional)
    """
    gmail = _get_service(account or None, "gmail", "v1")
    msg = gmail.users().messages().get(userId="me", id=message_id, format="full").execute()

    headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}

    # Extract body text
    body = _extract_body(msg.get("payload", {}))

    return json.dumps({
        "id": msg["id"],
        "threadId": msg.get("threadId"),
        "from": headers.get("From", ""),
        "to": headers.get("To", ""),
        "cc": headers.get("Cc", ""),
        "subject": headers.get("Subject", ""),
        "date": headers.get("Date", ""),
        "body": body,
        "labelIds": msg.get("labelIds", []),
        "snippet": msg.get("snippet", ""),
    })


def _extract_body(payload: dict) -> str:
    """Extract plain text body from Gmail message payload."""
    # Direct body
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")

    # Multipart — look for text/plain first, then text/html
    parts = payload.get("parts", [])
    for mime in ("text/plain", "text/html"):
        for part in parts:
            if part.get("mimeType") == mime and part.get("body", {}).get("data"):
                return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
            # Nested multipart
            for sub in part.get("parts", []):
                if sub.get("mimeType") == mime and sub.get("body", {}).get("data"):
                    return base64.urlsafe_b64decode(sub["body"]["data"]).decode("utf-8", errors="replace")

    return ""


@mcp.tool()
def gmail_send_email(to: str, subject: str, body: str,
                     cc: str = "", bcc: str = "", account: str = "") -> str:
    """Send an email via Gmail.

    Args:
        to: Recipient email address
        subject: Email subject
        body: Email body (plain text)
        cc: CC recipients (comma-separated)
        bcc: BCC recipients (comma-separated)
        account: Gmail account email to send from (optional)
    """
    gmail = _get_service(account or None, "gmail", "v1")

    message = MIMEText(body)
    message["to"] = to
    message["subject"] = subject
    if cc:
        message["cc"] = cc
    if bcc:
        message["bcc"] = bcc

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
    sent = gmail.users().messages().send(userId="me", body={"raw": raw}).execute()

    return json.dumps({"id": sent["id"], "threadId": sent.get("threadId"), "status": "sent"})


# ---------------------------------------------------------------------------
# Calendar tools
# ---------------------------------------------------------------------------

def _calendar_events_single(account_key: str, calendar_id: str,
                            time_min: str, time_max: str, max_results: int) -> list[dict]:
    """Get calendar events for a single account."""
    cal = _get_service(account_key, "calendar", "v3")

    kwargs: dict[str, Any] = {
        "calendarId": calendar_id,
        "maxResults": max_results,
        "singleEvents": True,
        "orderBy": "startTime",
    }
    if time_min:
        kwargs["timeMin"] = time_min
    if time_max:
        kwargs["timeMax"] = time_max

    resp = cal.events().list(**kwargs).execute()
    results = []
    for ev in resp.get("items", []):
        results.append({
            "id": ev.get("id"),
            "summary": ev.get("summary", "(no title)"),
            "start": ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date"),
            "end": ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date"),
            "location": ev.get("location", ""),
            "description": ev.get("description", ""),
            "attendees": [a.get("email") for a in ev.get("attendees", [])],
            "htmlLink": ev.get("htmlLink", ""),
            "status": ev.get("status", ""),
            "account": account_key,
        })
    return results


@mcp.tool()
def calendar_get_events(calendar_id: str = "primary", time_min: str = "",
                        time_max: str = "", max_results: int = 10,
                        account: str = "") -> str:
    """List events from a Google Calendar.

    When account is empty, returns events from ALL connected accounts.

    Args:
        calendar_id: Calendar ID (default: primary)
        time_min: Start time filter (RFC3339, e.g. 2026-02-25T00:00:00Z)
        time_max: End time filter (RFC3339)
        max_results: Maximum number of events (per account when searching all)
        account: Gmail account email. Empty = all accounts.
    """
    if account:
        results = _calendar_events_single(account, calendar_id, time_min, time_max, max_results)
        return json.dumps({"events": results, "total": len(results)})

    all_results: list[dict] = []
    for acct in _accounts:
        try:
            all_results.extend(_calendar_events_single(acct, calendar_id, time_min, time_max, max_results))
        except Exception as e:
            print(f"[CALENDAR] Error for {acct}: {e}", flush=True, file=sys.stderr)

    all_results.sort(key=lambda ev: ev.get("start", ""))
    return json.dumps({"events": all_results, "total": len(all_results)})


@mcp.tool()
def create_calendar_event(summary: str, start_time: str, end_time: str,
                          calendar_id: str = "primary", description: str = "",
                          location: str = "", attendees: list[str] | None = None,
                          account: str = "") -> str:
    """Create a Google Calendar event.

    Args:
        summary: Event title
        start_time: Start time (RFC3339, e.g. 2026-02-25T10:00:00+03:00)
        end_time: End time (RFC3339)
        calendar_id: Calendar ID (default: primary)
        description: Event description
        location: Event location
        attendees: List of attendee email addresses
        account: Gmail account email (optional)
    """
    cal = _get_service(account or None, "calendar", "v3")

    event_body: dict[str, Any] = {
        "summary": summary,
        "start": {"dateTime": start_time},
        "end": {"dateTime": end_time},
    }
    if description:
        event_body["description"] = description
    if location:
        event_body["location"] = location
    if attendees:
        event_body["attendees"] = [{"email": e} for e in attendees]

    created = cal.events().insert(calendarId=calendar_id, body=event_body).execute()

    return json.dumps({
        "id": created["id"],
        "summary": created.get("summary"),
        "htmlLink": created.get("htmlLink"),
        "status": "created",
    })


# ---------------------------------------------------------------------------
# Drive tools
# ---------------------------------------------------------------------------

@mcp.tool()
def drive_search_files(query: str, max_results: int = 10, account: str = "") -> str:
    """Search files in Google Drive.

    When account is empty, searches ALL connected accounts.

    Args:
        query: Search query (supports Drive search syntax, e.g. "name contains 'report'")
        max_results: Maximum number of results (per account when searching all)
        account: Gmail account email. Empty = all accounts.
    """
    accounts_to_query = [account] if account else list(_accounts.keys())

    all_results: list[dict] = []
    for acct in accounts_to_query:
        try:
            drive = _get_service(acct, "drive", "v3")
            resp = drive.files().list(
                q=query,
                pageSize=max_results,
                fields="files(id,name,mimeType,modifiedTime,size,webViewLink,owners)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            ).execute()

            for f in resp.get("files", []):
                all_results.append({
                    "id": f["id"],
                    "name": f.get("name", ""),
                    "mimeType": f.get("mimeType", ""),
                    "modifiedTime": f.get("modifiedTime", ""),
                    "size": f.get("size"),
                    "webViewLink": f.get("webViewLink", ""),
                    "owners": [o.get("emailAddress") for o in f.get("owners", [])],
                    "account": acct,
                })
        except Exception as e:
            print(f"[DRIVE] Error for {acct}: {e}", flush=True, file=sys.stderr)

    return json.dumps({"files": all_results, "total": len(all_results)})


@mcp.tool()
def drive_read_file_content(file_id: str, account: str = "") -> str:
    """Read content of a Google Drive file.

    For Google Docs/Sheets/Slides, exports as plain text.
    For other files, downloads raw content (up to 1MB).

    Args:
        file_id: Google Drive file ID
        account: Gmail account email (optional)
    """
    drive = _get_service(account or None, "drive", "v3")

    # Get file metadata first
    meta = drive.files().get(fileId=file_id, fields="id,name,mimeType,size").execute()
    mime = meta.get("mimeType", "")

    # Google Workspace docs → export
    export_map = {
        "application/vnd.google-apps.document": ("text/plain", "txt"),
        "application/vnd.google-apps.spreadsheet": ("text/csv", "csv"),
        "application/vnd.google-apps.presentation": ("text/plain", "txt"),
    }

    if mime in export_map:
        export_mime, _ = export_map[mime]
        content = drive.files().export(fileId=file_id, mimeType=export_mime).execute()
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        return json.dumps({"id": file_id, "name": meta.get("name"), "mimeType": mime, "content": content})

    # Regular file — download (cap at 1MB)
    size = int(meta.get("size", 0))
    if size > 1_048_576:
        return json.dumps({
            "id": file_id, "name": meta.get("name"), "mimeType": mime,
            "error": f"File too large ({size} bytes). Max 1MB for direct read.",
        })

    content = drive.files().get_media(fileId=file_id).execute()
    if isinstance(content, bytes):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = f"[Binary file, {len(content)} bytes]"
    else:
        text = str(content)

    return json.dumps({"id": file_id, "name": meta.get("name"), "mimeType": mime, "content": text})


# ---------------------------------------------------------------------------
# ASGI middleware: normalize camelCase → snake_case in MCP tool arguments
# ---------------------------------------------------------------------------
#
# OpenClaw converts snake_case parameter names (e.g. message_id, max_results,
# file_id) to camelCase (messageId, maxResults, fileId) when routing MCP tool
# calls. FastMCP binds arguments by Python function parameter names, so the
# camelCase variants don't match. This middleware intercepts the JSON-RPC
# request body and normalizes argument keys back to snake_case before FastMCP
# processes them.

def _camel_to_snake(name: str) -> str:
    """Convert camelCase / PascalCase to snake_case."""
    s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s1).lower()


def _normalize_args_app(inner):
    """ASGI middleware wrapper — normalizes camelCase tool arguments to snake_case."""

    async def asgi(scope, receive, send):
        if scope["type"] != "http":
            return await inner(scope, receive, send)

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

# Force JSON responses (not SSE) for simpler client parsing
try:
    mcp.settings.json_response = True
except Exception:
    pass

# Bypass MCP DNS rebinding Host validation for Railway internal networking
TransportSecurityMiddleware._validate_host = lambda self, host: True

app = _normalize_args_app(mcp.streamable_http_app())

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"[SERVER] Starting on port {port} with {len(_accounts)} account(s)",
          flush=True, file=sys.stderr)
    uvicorn.run(app, host="0.0.0.0", port=port)
