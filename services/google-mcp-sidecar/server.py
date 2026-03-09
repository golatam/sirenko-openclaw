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

import atexit
import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Any

import uvicorn
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaInMemoryUpload
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecurityMiddleware

# ---------------------------------------------------------------------------
# Structured JSON logger
# ---------------------------------------------------------------------------

def _jlog(level: str, msg: str, **data):
    """Emit a single JSON log line to stderr."""
    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "level": level,
        "service": "google-mcp-sidecar",
        "msg": msg,
    }
    if data:
        entry["data"] = {k: v for k, v in data.items() if v is not None}
    print(json.dumps(entry, ensure_ascii=False, default=str), file=sys.stderr, flush=True)


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
            _jlog("info", "Accounts loaded", count=len(data), accounts=list(data.keys()))
        except json.JSONDecodeError as e:
            _jlog("error", "Failed to parse GOOGLE_WORKSPACE_ACCOUNTS", error=str(e))

    # Legacy single-account fallback
    legacy_token = os.environ.get("GOOGLE_WORKSPACE_REFRESH_TOKEN")
    if legacy_token and not _accounts:
        _accounts["default"] = legacy_token
        _jlog("info", "Using legacy GOOGLE_WORKSPACE_REFRESH_TOKEN as 'default'")

    if not _accounts:
        _jlog("warn", "No accounts configured")


_load_accounts()

_start_time = time.monotonic()

_SIDECAR_AUTH_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")


def _resolve_account(account: str | None) -> str:
    """Resolve account email to a key in _accounts."""
    if account and account in _accounts:
        return account
    if account and account not in _accounts:
        available = ", ".join(_accounts.keys())
        raise ValueError(f"Account '{account}' not found. Available: {available}")
    # No account specified — return first
    if _accounts:
        return next(iter(_accounts))
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
    _jlog("info", "Credentials OK", account=key)
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
            _jlog("error", "Gmail query error", account=acct, error=str(e))

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
                            time_min: str, time_max: str, max_results: int,
                            q: str = "") -> list[dict]:
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
    if q:
        kwargs["q"] = q

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
def calendar_list_calendars(account: str = "") -> str:
    """List all calendars on the user's calendar list.

    When account is empty, returns calendars from ALL connected accounts.

    Args:
        account: Gmail account email. Empty = all accounts.
    """
    def _list_single(account_key: str) -> list[dict]:
        cal = _get_service(account_key, "calendar", "v3")
        resp = cal.calendarList().list().execute()
        calendars = []
        for item in resp.get("items", []):
            calendars.append({
                "id": item.get("id"),
                "summary": item.get("summary", ""),
                "description": item.get("description", ""),
                "primary": item.get("primary", False),
                "accessRole": item.get("accessRole", ""),
                "backgroundColor": item.get("backgroundColor", ""),
                "timeZone": item.get("timeZone", ""),
                "account": account_key,
            })
        return calendars

    if account:
        results = _list_single(account)
        return json.dumps({"calendars": results, "total": len(results)})

    all_results: list[dict] = []
    for acct in _accounts:
        try:
            all_results.extend(_list_single(acct))
        except Exception as e:
            _jlog("error", "Calendar list error", account=acct, error=str(e))

    return json.dumps({"calendars": all_results, "total": len(all_results)})


@mcp.tool()
def calendar_get_events(calendar_id: str = "primary", time_min: str = "",
                        time_max: str = "", max_results: int = 10,
                        q: str = "", account: str = "") -> str:
    """List events from a Google Calendar.

    When account is empty, returns events from ALL connected accounts.

    Args:
        calendar_id: Calendar ID (default: primary)
        time_min: Start time filter (RFC3339, e.g. 2026-02-25T00:00:00Z)
        time_max: End time filter (RFC3339)
        max_results: Maximum number of events (per account when searching all)
        q: Free-text search (matches summary, description, location, attendees)
        account: Gmail account email. Empty = all accounts.
    """
    if account:
        results = _calendar_events_single(account, calendar_id, time_min, time_max, max_results, q)
        return json.dumps({"events": results, "total": len(results)})

    all_results: list[dict] = []
    for acct in _accounts:
        try:
            all_results.extend(_calendar_events_single(acct, calendar_id, time_min, time_max, max_results, q))
        except Exception as e:
            _jlog("error", "Calendar events error", account=acct, error=str(e))

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
            _jlog("error", "Drive search error", account=acct, error=str(e))

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


@mcp.tool()
def drive_upload(account: str, file_name: str, content_base64: str,
                 mime_type: str = "application/gzip",
                 folder_name: str = "OpenClaw Backups") -> str:
    """Upload a file to Google Drive (base64-encoded content).

    Creates target folder if it doesn't exist. Uploads file into that folder.

    Args:
        account: Gmail account email
        file_name: Name for the uploaded file
        content_base64: File content encoded as base64
        mime_type: MIME type of the file (default: application/gzip)
        folder_name: Drive folder name to upload into (default: OpenClaw Backups)
    """
    drive = _get_service(account, "drive", "v3")

    # Find or create folder
    folder_query = (
        f"name = '{folder_name}' and mimeType = 'application/vnd.google-apps.folder'"
        f" and trashed = false"
    )
    folder_resp = drive.files().list(q=folder_query, pageSize=1,
                                     fields="files(id,name)").execute()
    folders = folder_resp.get("files", [])

    if folders:
        folder_id = folders[0]["id"]
    else:
        folder_meta = {
            "name": folder_name,
            "mimeType": "application/vnd.google-apps.folder",
        }
        folder = drive.files().create(body=folder_meta, fields="id").execute()
        folder_id = folder["id"]
        _jlog("info", "Created Drive folder", folder=folder_name, folder_id=folder_id)

    # Decode and upload
    content = base64.b64decode(content_base64)
    media = MediaInMemoryUpload(content, mimetype=mime_type, resumable=False)
    file_meta = {"name": file_name, "parents": [folder_id]}

    uploaded = drive.files().create(
        body=file_meta, media_body=media,
        fields="id,name,size,webViewLink",
    ).execute()

    _jlog("info", "Uploaded file", file_name=file_name, size_bytes=len(content), file_id=uploaded.get("id"))

    return json.dumps({
        "file_id": uploaded["id"],
        "file_name": uploaded.get("name"),
        "size_bytes": len(content),
        "web_view_link": uploaded.get("webViewLink", ""),
    })


@mcp.tool()
def drive_delete(account: str, file_id: str) -> str:
    """Delete a file from Google Drive by file ID.

    Args:
        account: Gmail account email
        file_id: Google Drive file ID to delete
    """
    drive = _get_service(account, "drive", "v3")
    drive.files().delete(fileId=file_id).execute()
    _jlog("info", "Deleted file", file_id=file_id)
    return json.dumps({"deleted": True, "file_id": file_id})


# ---------------------------------------------------------------------------
# Sheets tools
# ---------------------------------------------------------------------------

@mcp.tool()
def sheets_create(title: str, sheet_names: list[str] | None = None,
                  account: str = "") -> str:
    """Create a new Google Spreadsheet.

    Args:
        title: Spreadsheet title
        sheet_names: Optional list of sheet/tab names to create (default: one "Sheet1")
        account: Gmail account email (optional)
    """
    sheets = _get_service(account or None, "sheets", "v4")
    body: dict[str, Any] = {"properties": {"title": title}}
    if sheet_names:
        body["sheets"] = [{"properties": {"title": name}} for name in sheet_names]

    spreadsheet = sheets.spreadsheets().create(body=body).execute()
    return json.dumps({
        "spreadsheet_id": spreadsheet["spreadsheetId"],
        "title": spreadsheet["properties"]["title"],
        "url": spreadsheet.get("spreadsheetUrl", ""),
        "sheets": [s["properties"]["title"] for s in spreadsheet.get("sheets", [])],
    })


@mcp.tool()
def sheets_read(spreadsheet_id: str, range: str = "Sheet1",
                account: str = "") -> str:
    """Read values from a Google Spreadsheet range.

    Args:
        spreadsheet_id: Google Spreadsheet ID
        range: A1 notation range (e.g. "Sheet1!A1:D10", "Sheet1", "A1:B5")
        account: Gmail account email (optional)
    """
    sheets = _get_service(account or None, "sheets", "v4")
    result = sheets.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=range
    ).execute()
    return json.dumps({
        "range": result.get("range", ""),
        "values": result.get("values", []),
        "total_rows": len(result.get("values", [])),
    })


@mcp.tool()
def sheets_write(spreadsheet_id: str, range: str, values: list,
                 account: str = "") -> str:
    """Write values to a Google Spreadsheet range. Overwrites existing data.

    Args:
        spreadsheet_id: Google Spreadsheet ID
        range: A1 notation range (e.g. "Sheet1!A1")
        values: 2D array of values, e.g. [["Name","Age"],["Alice",30]]
        account: Gmail account email (optional)
    """
    sheets = _get_service(account or None, "sheets", "v4")
    result = sheets.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id, range=range,
        valueInputOption="USER_ENTERED",
        body={"values": values}
    ).execute()
    return json.dumps({
        "updated_range": result.get("updatedRange", ""),
        "updated_rows": result.get("updatedRows", 0),
        "updated_columns": result.get("updatedColumns", 0),
        "updated_cells": result.get("updatedCells", 0),
    })


@mcp.tool()
def sheets_append(spreadsheet_id: str, values: list,
                  range: str = "Sheet1", account: str = "") -> str:
    """Append rows after existing data in a Google Spreadsheet.

    Args:
        spreadsheet_id: Google Spreadsheet ID
        values: 2D array of rows to append, e.g. [["Alice",30],["Bob",25]]
        range: Sheet name or range to append to (default: Sheet1)
        account: Gmail account email (optional)
    """
    sheets = _get_service(account or None, "sheets", "v4")
    result = sheets.spreadsheets().values().append(
        spreadsheetId=spreadsheet_id, range=range,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": values}
    ).execute()
    updates = result.get("updates", {})
    return json.dumps({
        "updated_range": updates.get("updatedRange", ""),
        "updated_rows": updates.get("updatedRows", 0),
        "updated_cells": updates.get("updatedCells", 0),
    })


# ---------------------------------------------------------------------------
# Docs tools
# ---------------------------------------------------------------------------

@mcp.tool()
def docs_create(title: str, content: str = "", account: str = "") -> str:
    """Create a new Google Document, optionally with initial text content.

    Args:
        title: Document title
        content: Initial text content (optional)
        account: Gmail account email (optional)
    """
    docs = _get_service(account or None, "docs", "v1")
    doc = docs.documents().create(body={"title": title}).execute()
    doc_id = doc["documentId"]

    if content:
        docs.documents().batchUpdate(documentId=doc_id, body={
            "requests": [{"insertText": {"location": {"index": 1}, "text": content}}]
        }).execute()

    return json.dumps({
        "document_id": doc_id,
        "title": doc.get("title", title),
        "url": f"https://docs.google.com/document/d/{doc_id}/edit",
    })


@mcp.tool()
def docs_read(document_id: str, account: str = "") -> str:
    """Read the full text content of a Google Document.

    Returns structured text extracted from the document body.

    Args:
        document_id: Google Document ID
        account: Gmail account email (optional)
    """
    docs = _get_service(account or None, "docs", "v1")
    doc = docs.documents().get(documentId=document_id).execute()

    # Extract plain text from structural elements
    text_parts = []
    for element in doc.get("body", {}).get("content", []):
        if "paragraph" in element:
            for pe in element["paragraph"].get("elements", []):
                if "textRun" in pe:
                    text_parts.append(pe["textRun"]["content"])

    return json.dumps({
        "document_id": document_id,
        "title": doc.get("title", ""),
        "content": "".join(text_parts),
        "url": f"https://docs.google.com/document/d/{document_id}/edit",
    })


@mcp.tool()
def docs_append(document_id: str, text: str, account: str = "") -> str:
    """Append text to the end of a Google Document.

    Args:
        document_id: Google Document ID
        text: Text to append
        account: Gmail account email (optional)
    """
    docs = _get_service(account or None, "docs", "v1")

    # Get document to find the end index
    doc = docs.documents().get(documentId=document_id).execute()
    body_content = doc.get("body", {}).get("content", [])
    end_index = body_content[-1]["endIndex"] - 1 if body_content else 1

    docs.documents().batchUpdate(documentId=document_id, body={
        "requests": [{"insertText": {"location": {"index": end_index}, "text": text}}]
    }).execute()

    return json.dumps({
        "document_id": document_id,
        "appended_length": len(text),
    })


# ---------------------------------------------------------------------------
# Google Analytics 4 tools
# ---------------------------------------------------------------------------

@mcp.tool()
def analytics_list_properties(account: str = "") -> str:
    """List Google Analytics 4 properties accessible to the account.

    When account is empty, lists properties from ALL connected accounts.

    Args:
        account: Gmail account email. Empty = all accounts.
    """
    accounts_to_query = [account] if account else list(_accounts.keys())

    all_properties: list[dict] = []
    for acct in accounts_to_query:
        try:
            admin = _get_service(acct, "analyticsadmin", "v1beta")
            resp = admin.accountSummaries().list().execute()
            for summary in resp.get("accountSummaries", []):
                ga_account_name = summary.get("displayName", "")
                for prop in summary.get("propertySummaries", []):
                    all_properties.append({
                        "property_id": prop["property"].replace("properties/", ""),
                        "property_name": prop.get("displayName", ""),
                        "ga_account": ga_account_name,
                        "google_account": acct,
                    })
        except Exception as e:
            _jlog("error", "Analytics list error", account=acct, error=str(e))

    return json.dumps({"properties": all_properties, "total": len(all_properties)})


@mcp.tool()
def analytics_run_report(property_id: str, metrics: list[str],
                         dimensions: list[str] | None = None,
                         start_date: str = "30daysAgo", end_date: str = "today",
                         limit: int = 100, account: str = "") -> str:
    """Run a Google Analytics 4 report.

    Common metrics: activeUsers, sessions, screenPageViews, conversions, totalRevenue.
    Google Ads metrics (requires GA4-Ads link): advertiserAdClicks, advertiserAdCost, advertiserAdCostPerClick, advertiserAdImpressions.
    Common dimensions: date, country, city, pagePath, sessionSource, deviceCategory.
    Google Ads dimensions: sessionGoogleAdsCampaignName, sessionGoogleAdsAdGroupName, sessionGoogleAdsKeyword, sessionGoogleAdsAdNetworkType.

    Args:
        property_id: GA4 property ID (numeric, e.g. "123456789")
        metrics: List of metric names (e.g. ["activeUsers", "sessions"])
        dimensions: List of dimension names (optional, e.g. ["date", "country"])
        start_date: Start date — YYYY-MM-DD or relative: "today", "yesterday", "7daysAgo", "30daysAgo"
        end_date: End date — YYYY-MM-DD or relative (default: "today")
        limit: Max rows to return (default: 100)
        account: Gmail account email (optional)
    """
    data = _get_service(account or None, "analyticsdata", "v1beta")

    body: dict[str, Any] = {
        "metrics": [{"name": m} for m in metrics],
        "dateRanges": [{"startDate": start_date, "endDate": end_date}],
        "limit": limit,
    }
    if dimensions:
        body["dimensions"] = [{"name": d} for d in dimensions]

    resp = data.properties().runReport(
        property=f"properties/{property_id}", body=body
    ).execute()

    # Parse structured response into flat rows
    dim_headers = [h["name"] for h in resp.get("dimensionHeaders", [])]
    met_headers = [h["name"] for h in resp.get("metricHeaders", [])]

    rows = []
    for row in resp.get("rows", []):
        r: dict[str, str] = {}
        for i, dv in enumerate(row.get("dimensionValues", [])):
            r[dim_headers[i]] = dv["value"]
        for i, mv in enumerate(row.get("metricValues", [])):
            r[met_headers[i]] = mv["value"]
        rows.append(r)

    return json.dumps({
        "row_count": resp.get("rowCount", 0),
        "rows": rows,
        "dimensions": dim_headers,
        "metrics": met_headers,
    })


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

        # Deep health check endpoint
        path = scope.get("path", "")
        if scope.get("method", "") == "GET" and path == "/health":
            checks: dict[str, Any] = {}
            overall = "ok"

            # Check OAuth validity per account by calling userinfo
            account_details = []
            for acct in _accounts:
                try:
                    creds = _get_credentials(acct)
                    if creds and creds.valid:
                        account_details.append({"account": acct, "status": "ok"})
                    else:
                        account_details.append({"account": acct, "status": "error", "detail": "credentials invalid"})
                        overall = "degraded"
                except Exception as e:
                    account_details.append({"account": acct, "status": "error", "detail": str(e)})
                    overall = "degraded"

            if not _accounts:
                overall = "error"
                checks["accounts"] = {"status": "error", "detail": "no accounts configured"}
            else:
                failed = [a for a in account_details if a["status"] != "ok"]
                if failed:
                    checks["accounts"] = {"status": "degraded", "details": f"{len(failed)}/{len(account_details)} accounts unhealthy", "accounts": account_details}
                else:
                    checks["accounts"] = {"status": "ok", "count": len(account_details), "accounts": account_details}

            uptime = int(time.monotonic() - _start_time)
            # Count registered MCP tools for diagnostics
            tool_count = len(mcp._tool_manager._tools) if hasattr(mcp, '_tool_manager') else -1
            body = json.dumps({
                "status": overall,
                "checks": checks,
                "uptime_seconds": uptime,
                "tools_registered": tool_count,
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

        # Auth check — protect MCP endpoints (health is open for Docker HEALTHCHECK)
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
                        _jlog("info", "Normalized args", component="normalize",
                              original=list(args.keys()), normalized=list(normalized.keys()))
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

# Replace global Host validation bypass with allowlist for Railway networking
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
    n_creds = len(_creds_cache)
    n_svc = len(_service_cache)
    _creds_cache.clear()
    _service_cache.clear()
    _jlog("info", "Cleanup", creds_cleared=n_creds, services_cleared=n_svc)

atexit.register(_cleanup)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    _jlog("info", "Starting server", port=port, accounts=len(_accounts))
    uvicorn.run(app, host="0.0.0.0", port=port)
