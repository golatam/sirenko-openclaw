import asyncio
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import asyncpg
from aiohttp import web
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession

load_dotenv()

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
            accounts.append(
                AccountConfig(
                    label=f"tg{i}",
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
            INSERT INTO accounts (source, label, identity, status)
            VALUES ('telegram', $1, $2, 'active')
            ON CONFLICT DO NOTHING
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
            """,
            account_label,
            thread_id,
            sender_id,
            sender_name,
            text,
            ts,
            json.dumps(metadata),
        )


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
                metadata = {
                    "chat_title": getattr(dialog.entity, "title", None),
                    "chat_username": getattr(dialog.entity, "username", None),
                    "message_id": msg.id,
                }
                await insert_message(
                    pool,
                    account.label,
                    thread_id,
                    sender_id,
                    sender_name,
                    msg.message,
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
    await client.start(phone=account.phone)
    await ensure_account_row(pool, account)

    if account.session is None and os.getenv("PRINT_SESSION_STRING", "0") == "1":
        print(f"{account.label} SESSION_STRING: {client.session.save()}")

    if sync_history_on_start:
        await sync_history(client, pool, account, per_chat)

    @client.on(events.NewMessage)
    async def handle_new_message(event: events.NewMessage.Event) -> None:
        sender = await event.get_sender()
        sender_id = str(getattr(sender, "id", "")) if sender else None
        sender_name = getattr(sender, "first_name", None) or getattr(sender, "title", None)
        chat = await event.get_chat()
        thread_id = str(getattr(chat, "id", "")) if chat else None
        metadata = {
            "chat_title": getattr(chat, "title", None),
            "chat_username": getattr(chat, "username", None),
            "message_id": event.message.id,
        }
        await insert_message(
            pool,
            account.label,
            thread_id,
            sender_id,
            sender_name,
            event.raw_text,
            event.message.date or utc_now(),
            metadata,
        )

    await client.run_until_disconnected()


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
    return web.json_response({
        "status": "ok",
        "accounts": request.app.get("account_count", 0),
    })


def create_search_app(pool: asyncpg.Pool, account_count: int) -> web.Application:
    app = web.Application()
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

    sync_history_on_start = os.getenv("SYNC_HISTORY_ON_START", "0") == "1"
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

    # Start Telethon clients
    print(f"[TG] Starting {len(accounts)} account(s)...", flush=True, file=sys.stderr)
    tasks = [
        asyncio.create_task(run_account(pool, account, sync_history_on_start, per_chat))
        for account in accounts
    ]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
