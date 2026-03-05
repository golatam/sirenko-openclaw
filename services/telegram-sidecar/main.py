import asyncio
import json
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import asyncpg
from aiohttp import web, ClientSession, ClientTimeout, FormData
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import User, Chat, Channel

load_dotenv()

_start_time = time.monotonic()
_client_status: dict[str, str] = {}  # label -> "connected" | "disconnected" | "failed"
_shutdown_event = asyncio.Event()
_active_clients: dict[str, TelegramClient] = {}  # label -> client (for disconnect on shutdown)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3"
GROQ_TIMEOUT = ClientTimeout(total=30)

if not GROQ_API_KEY:
    print("[TG] WARNING: GROQ_API_KEY not set — voice will not be transcribed", flush=True, file=sys.stderr)

@dataclass
class AccountConfig:
    label: str
    api_id: int
    api_hash: str
    phone: str
    session: Optional[str] = None


def getenv_int(name: str, default: Optional[int] = None) -> Optional[int]:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def get_accounts() -> list[AccountConfig]:
    accounts: list[AccountConfig] = []
    for i in range(1, 4):
        api_id = getenv_int(f"TG{i}_API_ID")
        api_hash = os.getenv(f"TG{i}_API_HASH")
        phone = os.getenv(f"TG{i}_PHONE")
        session = os.getenv(f"TG{i}_SESSION")
        if api_id and api_hash and phone:
            label = os.getenv(f"TG{i}_LABEL", f"tg{i}")
            accounts.append(
                AccountConfig(
                    label=label,
                    api_id=api_id,
                    api_hash=api_hash,
                    phone=phone,
                    session=session if session and session.strip() else None,
                )
            )
    return accounts


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_account_row(pool: asyncpg.Pool, account: AccountConfig) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO accounts (source, label, identity, status, updated_at)
            VALUES ('telegram', $1, $2, 'active', NOW())
            ON CONFLICT (source, label) DO UPDATE
              SET identity = EXCLUDED.identity, status = 'active', updated_at = NOW()
            """,
            account.label,
            account.phone,
        )


async def insert_message(
    pool: asyncpg.Pool,
    account_label: str,
    thread_id: Optional[str],
    sender_id: Optional[str],
    sender_name: Optional[str],
    text: Optional[str],
    ts: datetime,
    metadata: dict,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO messages
              (source, account_label, thread_id, sender_id, sender_name, text, ts, metadata_json)
            VALUES
              ('telegram', $1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (source, account_label, thread_id, (metadata_json->>'message_id'))
              WHERE metadata_json->>'message_id' IS NOT NULL
              DO NOTHING
            """,
            account_label,
            thread_id,
            sender_id,
            sender_name,
            text,
            ts,
            json.dumps(metadata),
        )


def classify_chat(entity) -> tuple[str, Optional[str]]:
    """Return (chat_type, chat_title) for a Telethon entity."""
    if isinstance(entity, User):
        parts = [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]
        name = " ".join(p for p in parts if p) or None
        return ("private", name)
    elif isinstance(entity, Channel):
        kind = "channel" if entity.broadcast else "supergroup"
        return (kind, getattr(entity, "title", None))
    elif isinstance(entity, Chat):
        return ("group", getattr(entity, "title", None))
    else:
        return ("unknown", getattr(entity, "title", None) or getattr(entity, "first_name", None))


def is_voice_message(message) -> bool:
    """Check if a Telethon message is a voice note (not music/audio file)."""
    from telethon.tl.types import MessageMediaDocument, DocumentAttributeAudio
    media = message.media
    if not isinstance(media, MessageMediaDocument) or not media.document:
        return False
    for attr in media.document.attributes:
        if isinstance(attr, DocumentAttributeAudio) and attr.voice:
            return True
    return False


GROQ_MAX_RETRIES = 3
GROQ_BACKOFF_BASE = 3  # seconds: 3, 6, 12


async def transcribe_audio(audio_bytes: bytes) -> Optional[str]:
    """Send audio bytes to Groq Whisper API, return transcript or None.

    Retries up to GROQ_MAX_RETRIES times on 429 (rate limit) with exponential backoff.
    """
    if not GROQ_API_KEY:
        return None
    for attempt in range(GROQ_MAX_RETRIES + 1):
        try:
            form = FormData()
            form.add_field("file", audio_bytes, filename="voice.ogg", content_type="audio/ogg")
            form.add_field("model", GROQ_MODEL)
            form.add_field("language", "ru")
            async with ClientSession(timeout=GROQ_TIMEOUT) as session:
                async with session.post(
                    GROQ_URL,
                    data=form,
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                ) as resp:
                    if resp.status == 429 and attempt < GROQ_MAX_RETRIES:
                        delay = GROQ_BACKOFF_BASE * (2 ** attempt)
                        print(f"[TG] Groq 429 rate limit, retry {attempt + 1}/{GROQ_MAX_RETRIES} in {delay}s", flush=True, file=sys.stderr)
                        await asyncio.sleep(delay)
                        continue
                    if resp.status != 200:
                        body = await resp.text()
                        print(f"[TG] Groq API error {resp.status}: {body}", flush=True, file=sys.stderr)
                        return None
                    result = await resp.json()
                    text = result.get("text", "").strip()
                    return text if text else None
        except Exception as e:
            print(f"[TG] Transcription failed: {e}", flush=True, file=sys.stderr)
            return None
    return None


async def sync_history(client: TelegramClient, pool: asyncpg.Pool, account: AccountConfig, per_chat: int) -> None:
    async for dialog in client.iter_dialogs():
        try:
            async for msg in client.iter_messages(dialog.entity, limit=per_chat):
                if not msg.date:
                    continue
                sender = await msg.get_sender()
                sender_id = str(getattr(sender, "id", "")) if sender else None
                sender_name = getattr(sender, "first_name", None) or getattr(sender, "title", None)
                thread_id = str(getattr(dialog.entity, "id", ""))
                text = msg.message
                chat_type, chat_title = classify_chat(dialog.entity)
                metadata = {
                    "chat_title": chat_title,
                    "chat_username": getattr(dialog.entity, "username", None),
                    "chat_type": chat_type,
                    "message_id": msg.id,
                }

                if is_voice_message(msg):
                    metadata["media_type"] = "voice"
                    try:
                        audio_bytes = await msg.download_media(file=bytes)
                        if audio_bytes:
                            transcript = await transcribe_audio(audio_bytes)
                            if transcript:
                                text = transcript
                                metadata["transcribed"] = True
                            else:
                                metadata["transcription_failed"] = True
                        else:
                            metadata["transcription_failed"] = True
                    except Exception:
                        metadata["transcription_failed"] = True

                await insert_message(
                    pool,
                    account.label,
                    thread_id,
                    sender_id,
                    sender_name,
                    text,
                    msg.date,
                    metadata,
                )
        except Exception:
            continue


async def run_account(pool: asyncpg.Pool, account: AccountConfig, sync_history_on_start: bool, per_chat: int) -> None:
    session_dir = os.getenv("TG_SESSION_DIR")
    session_name = f"{account.label}_session"
    if session_dir:
        session_name = os.path.join(session_dir, session_name)
    session = StringSession(account.session) if account.session else session_name
    client = TelegramClient(session, account.api_id, account.api_hash)

    def _code_callback():
        msg = (
            f"[TG] {account.label} ({account.phone}) requires re-authorization! "
            "Run gen_session.py locally to generate a new StringSession, "
            f"then update the corresponding TGx_SESSION in Railway env vars."
        )
        print(msg, flush=True, file=sys.stderr)
        raise RuntimeError(f"{account.label} session expired — re-auth needed (see logs)")

    try:
        print(f"[TG] {account.label} connecting...", flush=True, file=sys.stderr)
        await asyncio.wait_for(
            client.start(phone=account.phone, code_callback=_code_callback),
            timeout=60,
        )
    except asyncio.TimeoutError:
        print(f"[TG] FAILED to start {account.label} ({account.phone}): connection timeout (60s)", flush=True, file=sys.stderr)
        _client_status[account.label] = "failed"
        return
    except Exception as e:
        print(f"[TG] FAILED to start {account.label} ({account.phone}): {e}", flush=True, file=sys.stderr)
        _client_status[account.label] = "failed"
        return
    _client_status[account.label] = "connected"
    print(f"[TG] {account.label} connected", flush=True, file=sys.stderr)
    await ensure_account_row(pool, account)

    if account.session is None and os.getenv("PRINT_SESSION_STRING", "0") == "1":
        print(f"{account.label} SESSION_STRING: {client.session.save()}")

    if sync_history_on_start:
        await sync_history(client, pool, account, per_chat)

    _active_clients[account.label] = client

    @client.on(events.NewMessage)
    async def handle_new_message(event: events.NewMessage.Event) -> None:
        try:
            sender = await event.get_sender()
            sender_id = str(getattr(sender, "id", "")) if sender else None
            sender_name = getattr(sender, "first_name", None) or getattr(sender, "title", None)
            chat = await event.get_chat()
            thread_id = str(getattr(chat, "id", "")) if chat else None
            text = event.raw_text
            chat_type, chat_title = classify_chat(chat) if chat else ("unknown", None)
            metadata = {
                "chat_title": chat_title,
                "chat_username": getattr(chat, "username", None),
                "chat_type": chat_type,
                "message_id": event.message.id,
            }

            if is_voice_message(event.message):
                metadata["media_type"] = "voice"
                try:
                    audio_bytes = await event.message.download_media(file=bytes)
                    if audio_bytes:
                        transcript = await transcribe_audio(audio_bytes)
                        if transcript:
                            text = transcript
                            metadata["transcribed"] = True
                            print(f"[TG] Transcribed voice ({len(audio_bytes)} bytes) → {len(transcript)} chars", flush=True, file=sys.stderr)
                        else:
                            metadata["transcription_failed"] = True
                    else:
                        metadata["transcription_failed"] = True
                except Exception as e:
                    print(f"[TG] Voice download failed: {e}", flush=True, file=sys.stderr)
                    metadata["transcription_failed"] = True

            await insert_message(
                pool,
                account.label,
                thread_id,
                sender_id,
                sender_name,
                text,
                event.message.date or utc_now(),
                metadata,
            )
        except Exception as e:
            print(f"[TG] {account.label} handler error: {e}", flush=True, file=sys.stderr)

    try:
        await client.run_until_disconnected()
    finally:
        _client_status[account.label] = "disconnected"
        _active_clients.pop(account.label, None)


async def supervise_account(pool: asyncpg.Pool, account: AccountConfig, sync_history_on_start: bool, per_chat: int) -> None:
    """Supervisor loop: restart run_account() with exponential backoff on failure."""
    delay = 5
    max_delay = 300

    while not _shutdown_event.is_set():
        started_at = time.monotonic()
        try:
            await run_account(pool, account, sync_history_on_start, per_chat)
        except Exception as e:
            print(f"[TG] {account.label} crashed: {e}", flush=True, file=sys.stderr)

        if _shutdown_event.is_set():
            break

        # Reset backoff if the account ran stably (>60s)
        elapsed = time.monotonic() - started_at
        if elapsed > 60:
            delay = 5

        print(f"[TG] {account.label} will restart in {delay}s", flush=True, file=sys.stderr)
        try:
            await asyncio.wait_for(_shutdown_event.wait(), timeout=delay)
            break  # shutdown signalled during wait
        except asyncio.TimeoutError:
            pass  # delay elapsed, retry

        delay = min(delay * 2, max_delay)


## ---------------------------------------------------------------------------
## HTTP search API (aiohttp)
## ---------------------------------------------------------------------------

SEARCH_SQL = """
SELECT id, source, account_label, thread_id, sender_id, sender_name,
       text, ts, metadata_json
FROM messages
WHERE ($1::text IS NULL OR source = $1)
  AND ($2::text = '' OR plainto_tsquery('simple', $2)::text = ''
       OR to_tsvector('simple', coalesce(text, '')) @@ plainto_tsquery('simple', $2))
  AND ($3::text IS NULL OR account_label = $3)
  AND ($4::text IS NULL OR thread_id = $4)
  AND ($5::timestamptz IS NULL OR ts >= $5)
  AND ($6::timestamptz IS NULL OR ts <= $6)
ORDER BY ts DESC
LIMIT $7 OFFSET $8
"""

COUNT_SQL = """
SELECT COUNT(*) FROM messages
WHERE ($1::text IS NULL OR source = $1)
  AND ($2::text = '' OR plainto_tsquery('simple', $2)::text = ''
       OR to_tsvector('simple', coalesce(text, '')) @@ plainto_tsquery('simple', $2))
  AND ($3::text IS NULL OR account_label = $3)
  AND ($4::text IS NULL OR thread_id = $4)
  AND ($5::timestamptz IS NULL OR ts >= $5)
  AND ($6::timestamptz IS NULL OR ts <= $6)
"""


def _clamp(val: Optional[int], lo: int, hi: int, default: int) -> int:
    if val is None:
        return default
    return max(lo, min(hi, val))


async def handle_search(request: web.Request) -> web.Response:
    pool: asyncpg.Pool = request.app["pool"]
    try:
        body = await request.json()
    except Exception as e:
        print(f"[SEARCH] invalid JSON: {e}", flush=True, file=sys.stderr)
        return web.json_response({"error": "invalid JSON body"}, status=400)

    source = body.get("source") or None  # None = all sources
    query = body.get("query", "")
    account = body.get("account") or None
    thread_id = body.get("thread_id") or None
    from_ts = body.get("from") or None
    to_ts = body.get("to") or None
    limit = _clamp(body.get("limit"), 1, 100, 20)
    offset = _clamp(body.get("offset"), 0, 10000, 0)

    print(f"[SEARCH] source={source} query={query!r} account={account} thread={thread_id} from={from_ts} to={to_ts} limit={limit}", flush=True, file=sys.stderr)

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                SEARCH_SQL, source, query, account, thread_id, from_ts, to_ts, limit, offset
            )
            total_row = await conn.fetchval(
                COUNT_SQL, source, query, account, thread_id, from_ts, to_ts
            )
    except Exception as e:
        print(f"[SEARCH] DB error: {e}", flush=True, file=sys.stderr)
        return web.json_response({"error": f"db error: {e}"}, status=500)

    messages = []
    for r in rows:
        messages.append({
            "id": r["id"],
            "source": r["source"],
            "account_label": r["account_label"],
            "thread_id": r["thread_id"],
            "sender_id": r["sender_id"],
            "sender_name": r["sender_name"],
            "text": r["text"],
            "ts": r["ts"].isoformat() if r["ts"] else None,
            "metadata": r["metadata_json"] if isinstance(r["metadata_json"], dict) else json.loads(r["metadata_json"] or "{}"),
        })

    print(f"[SEARCH] found {len(messages)}/{total_row or 0} results", flush=True, file=sys.stderr)

    return web.json_response({
        "messages": messages,
        "total": total_row or 0,
        "query": query,
        "source": source or "all",
    })


async def handle_health(request: web.Request) -> web.Response:
    checks: dict[str, dict] = {}
    overall = "ok"

    # DB connectivity check
    pool: asyncpg.Pool = request.app["pool"]
    try:
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        checks["db"] = {"status": "ok"}
    except Exception as e:
        checks["db"] = {"status": "error", "detail": str(e)}
        overall = "error"

    # Telethon client status
    total = request.app.get("account_count", 0)
    connected = sum(1 for s in _client_status.values() if s == "connected")
    if total == 0:
        checks["accounts"] = {"status": "error", "detail": "no accounts configured"}
        overall = "error"
    elif connected < total:
        disconnected = [label for label, s in _client_status.items() if s != "connected"]
        accounts_list = [{"account": label, "status": s} for label, s in _client_status.items()]
        checks["accounts"] = {"status": "degraded", "details": f"{disconnected} not connected", "connected": connected, "total": total, "accounts": accounts_list}
        if overall == "ok":
            overall = "degraded"
    else:
        accounts_list = [{"account": label, "status": s} for label, s in _client_status.items()]
        checks["accounts"] = {"status": "ok", "connected": connected, "total": total, "accounts": accounts_list}

    uptime = int(time.monotonic() - _start_time)
    return web.json_response({
        "status": overall,
        "checks": checks,
        "uptime_seconds": uptime,
    })


_SIDECAR_AUTH_TOKEN = os.getenv("SIDECAR_AUTH_TOKEN", "")

@web.middleware
async def auth_middleware(request: web.Request, handler):
    # /health stays open for Docker HEALTHCHECK
    if _SIDECAR_AUTH_TOKEN and request.path != "/health":
        token = request.headers.get("X-Internal-Token", "")
        if token != _SIDECAR_AUTH_TOKEN:
            return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(request)


def create_search_app(pool: asyncpg.Pool, account_count: int) -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    app["pool"] = pool
    app["account_count"] = account_count
    app.router.add_post("/search", handle_search)
    app.router.add_get("/health", handle_health)
    return app


## ---------------------------------------------------------------------------
## Main
## ---------------------------------------------------------------------------

async def main() -> None:
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL is required")

    accounts = get_accounts()
    if not accounts:
        raise SystemExit("No Telegram accounts configured")

    sync_history_on_start = os.getenv("SYNC_HISTORY_ON_START", "1") == "1"
    per_chat = getenv_int("HISTORY_PER_CHAT", 50) or 50

    pool = await asyncpg.create_pool(dsn=db_url, min_size=1, max_size=5)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
              id SERIAL PRIMARY KEY,
              source TEXT NOT NULL,
              label TEXT NOT NULL,
              identity TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS messages (
              id BIGSERIAL PRIMARY KEY,
              source TEXT NOT NULL,
              account_label TEXT NOT NULL,
              thread_id TEXT,
              sender_id TEXT,
              sender_name TEXT,
              text TEXT,
              ts TIMESTAMPTZ NOT NULL,
              metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS messages_source_ts_idx ON messages (source, ts DESC);
            CREATE INDEX IF NOT EXISTS messages_account_ts_idx ON messages (account_label, ts DESC);
            CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING GIN (to_tsvector('simple', coalesce(text, '')));

            CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_idx
              ON messages (source, account_label, thread_id, (metadata_json->>'message_id'))
              WHERE metadata_json->>'message_id' IS NOT NULL;
            """
        )

    # Start HTTP search API
    http_port = int(os.getenv("HTTP_PORT", os.getenv("PORT", "8000")))
    search_app = create_search_app(pool, len(accounts))
    runner = web.AppRunner(search_app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", http_port)
    await site.start()
    print(f"[HTTP] Search API listening on port {http_port}", flush=True, file=sys.stderr)

    # Start supervised Telethon clients
    print(f"[TG] Starting {len(accounts)} account(s)...", flush=True, file=sys.stderr)
    tasks = []
    for account in accounts:
        tasks.append(asyncio.create_task(
            supervise_account(pool, account, sync_history_on_start, per_chat),
            name=f"supervisor-{account.label}",
        ))

    # Register SIGTERM/SIGINT handlers
    loop = asyncio.get_running_loop()
    def _signal_handler():
        if not _shutdown_event.is_set():
            print("[TG] Shutdown signal received", flush=True, file=sys.stderr)
            _shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _signal_handler)

    # Wait for shutdown signal
    await _shutdown_event.wait()

    # Graceful shutdown sequence
    print("[TG] Disconnecting clients...", flush=True, file=sys.stderr)
    for label, client in list(_active_clients.items()):
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
            print(f"[TG] {label} disconnected", flush=True, file=sys.stderr)
        except Exception as e:
            print(f"[TG] {label} disconnect error: {e}", flush=True, file=sys.stderr)

    # Cancel and await supervisor tasks
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    # Cleanup HTTP server
    await runner.cleanup()
    print("[TG] HTTP server stopped", flush=True, file=sys.stderr)

    # Close DB pool
    await pool.close()
    print("[TG] DB pool closed", flush=True, file=sys.stderr)
    print("[TG] Shutdown complete", flush=True, file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
