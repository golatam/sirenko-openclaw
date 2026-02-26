import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import pg from "pg";
import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[WA] DATABASE_URL is required");
  process.exit(1);
}

const AUTH_DIR = process.env.WA_AUTH_DIR || "/data/auth_state";
const ACCOUNT_LABEL = process.env.WA_ACCOUNT_LABEL || "wa1";
const HTTP_PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || "8000", 10);
const SKIP_FROM_ME = process.env.WA_SKIP_FROM_ME !== "0"; // skip own messages by default
const SYNC_HISTORY = process.env.WA_SYNC_HISTORY === "1"; // ingest history sync messages

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
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
    `);
  } finally {
    client.release();
  }
}

async function ensureAccountRow(identity) {
  await pool.query(
    `INSERT INTO accounts (source, label, identity, status)
     VALUES ('whatsapp', $1, $2, 'active')
     ON CONFLICT DO NOTHING`,
    [ACCOUNT_LABEL, identity],
  );
}

async function insertMessage({ threadId, senderId, senderName, text, ts, metadata }) {
  if (!text) return; // skip media-only / empty messages
  await pool.query(
    `INSERT INTO messages (source, account_label, thread_id, sender_id, sender_name, text, ts, metadata_json)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7)`,
    [ACCOUNT_LABEL, threadId, senderId, senderName, text, ts, JSON.stringify(metadata)],
  );
}

// ---------------------------------------------------------------------------
// Group metadata cache
// ---------------------------------------------------------------------------

const groupCache = new Map();

async function getGroupName(sock, jid) {
  if (groupCache.has(jid)) return groupCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    groupCache.set(jid, meta.subject);
    return meta.subject;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract text from message
// ---------------------------------------------------------------------------

function extractText(msg) {
  if (!msg.message) return null;
  return (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    msg.message.documentMessage?.caption ||
    msg.message.listResponseMessage?.title ||
    msg.message.buttonsResponseMessage?.selectedDisplayText ||
    null
  );
}

// ---------------------------------------------------------------------------
// WhatsApp connection
// ---------------------------------------------------------------------------

let reconnectAttempts = 0;
let isConnected = false;
let messageCount = 0;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    syncFullHistory: SYNC_HISTORY,
  });

  sock.ev.on("creds.update", saveCreds);

  // --- Connection state ---
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.error("[WA] QR code generated — scan with WhatsApp > Linked Devices");
    }

    if (connection === "open") {
      isConnected = true;
      reconnectAttempts = 0;
      const me = sock.user?.id || "unknown";
      console.error(`[WA] Connected as ${me}`);
      ensureAccountRow(me).catch((e) =>
        console.error("[WA] Failed to register account:", e.message),
      );
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.error(`[WA] Disconnected (status=${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        reconnectAttempts++;
        const delay = Math.min(60_000, 1000 * Math.pow(2, reconnectAttempts));
        console.error(`[WA] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(startWhatsApp, delay);
      } else {
        console.error("[WA] Logged out. Delete auth state and re-scan QR.");
      }
    }
  });

  // --- Group metadata updates ---
  sock.ev.on("groups.update", async ([event]) => {
    if (event.subject) groupCache.set(event.id, event.subject);
  });

  // --- Message ingestion ---
  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    // 'notify' = real-time new messages, 'append' = history sync
    if (type !== "notify" && !SYNC_HISTORY) return;

    for (const msg of messages) {
      try {
        if (SKIP_FROM_ME && msg.key.fromMe) continue;
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        // Skip status broadcasts
        if (remoteJid === "status@broadcast") continue;

        const isGroup = remoteJid?.endsWith("@g.us") || false;
        const senderId = msg.key.participant || remoteJid;
        const senderName = msg.pushName || null;
        const text = extractText(msg);
        const timestamp = msg.messageTimestamp;
        const ts = new Date(Number(timestamp) * 1000);

        let groupName = null;
        if (isGroup) {
          groupName = await getGroupName(sock, remoteJid);
        }

        await insertMessage({
          threadId: remoteJid,
          senderId,
          senderName,
          text,
          ts,
          metadata: {
            message_id: msg.key.id,
            is_group: isGroup,
            group_name: groupName,
          },
        });
        messageCount++;
      } catch (e) {
        console.error("[WA] Failed to ingest message:", e.message);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP health endpoint
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: isConnected ? "ok" : "disconnected",
        account: ACCOUNT_LABEL,
        messages_ingested: messageCount,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await ensureSchema();
  console.error(`[WA] Account label: ${ACCOUNT_LABEL}`);
  console.error(`[WA] Auth dir: ${AUTH_DIR}`);
  console.error(`[WA] Skip own messages: ${SKIP_FROM_ME}`);
  console.error(`[WA] Sync history: ${SYNC_HISTORY}`);

  server.listen(HTTP_PORT, "0.0.0.0", () => {
    console.error(`[HTTP] Health endpoint on port ${HTTP_PORT}`);
  });

  await startWhatsApp();
}

main().catch((e) => {
  console.error("[WA] Fatal:", e);
  process.exit(1);
});
