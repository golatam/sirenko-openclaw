import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import pg from "pg";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { readdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Structured JSON logger
// ---------------------------------------------------------------------------

function jlog(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: "whatsapp-sidecar",
    msg,
  };
  if (data) entry.data = data;
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  jlog("error", "DATABASE_URL is required");
  process.exit(1);
}

const AUTH_DIR = process.env.WA_AUTH_DIR || "/data/auth_state";
const ACCOUNT_LABEL = process.env.WA_ACCOUNT_LABEL || "wa1";
const HTTP_PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || "8000", 10);
const SKIP_FROM_ME = process.env.WA_SKIP_FROM_ME !== "0"; // skip own messages by default
const SYNC_HISTORY = process.env.WA_SYNC_HISTORY === "1"; // ingest history sync messages

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// WA_FORCE_REAUTH: set any non-empty value to trigger re-pairing (e.g. "1", a timestamp, etc.)
// Uses a marker file so re-pairing only happens once per unique value — safe across restarts.
const FORCE_REAUTH = process.env.WA_FORCE_REAUTH || "";
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN || "";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";
const GROQ_TIMEOUT_MS = 30_000;

if (!GROQ_API_KEY) {
  jlog("warn", "GROQ_API_KEY not set — voice will not be transcribed");
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

async function ensureSchema() {
  // Schema must match services/telegram-sidecar/schema.sql (canonical source of truth)
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source, label)
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

      DROP INDEX IF EXISTS messages_text_idx;
      CREATE INDEX IF NOT EXISTS messages_text_idx ON messages
        USING GIN (to_tsvector('simple',
          coalesce(text, '') || ' ' || coalesce(sender_name, '') || ' ' || coalesce(metadata_json->>'chat_title', '')
        ));

      CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_idx
        ON messages (source, account_label, thread_id, (metadata_json->>'message_id'))
        WHERE metadata_json->>'message_id' IS NOT NULL;
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
  if (!text && !metadata?.media_type) return; // skip media-only / empty (but keep voice)
  await pool.query(
    `INSERT INTO messages (source, account_label, thread_id, sender_id, sender_name, text, ts, metadata_json)
     VALUES ('whatsapp', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source, account_label, thread_id, (metadata_json->>'message_id'))
       WHERE metadata_json->>'message_id' IS NOT NULL
       DO NOTHING`,
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
// Voice transcription (Groq Whisper)
// ---------------------------------------------------------------------------

function isVoiceMessage(msg) {
  return !!msg.message?.audioMessage;
}

const GROQ_MAX_RETRIES = 3;
const GROQ_BACKOFF_BASE = 3; // seconds: 3, 6, 12

async function transcribeAudio(msg) {
  if (!GROQ_API_KEY) return null;
  try {
    const audioMsg = msg.message.audioMessage;
    const stream = await downloadContentFromMessage(audioMsg, "audio");
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
      form.append("model", GROQ_MODEL);
      form.append("language", "ru");

      const resp = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
      });

      if (resp.status === 429 && attempt < GROQ_MAX_RETRIES) {
        const delay = GROQ_BACKOFF_BASE * (2 ** attempt);
        jlog("warn", "Groq 429 rate limit", { attempt: attempt + 1, max_retries: GROQ_MAX_RETRIES, delay_s: delay });
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text();
        jlog("error", "Groq API error", { status: resp.status, body });
        return null;
      }

      const result = await resp.json();
      const text = (result.text || "").trim();
      return text || null;
    }
    return null;
  } catch (e) {
    jlog("error", "Transcription failed", { error: e.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// QR code text rendering (minimal, no extra deps)
// ---------------------------------------------------------------------------

function renderQrToLog(qrString) {
  // Just log the raw string — user can paste into any QR generator
  jlog("info", "QR code generated — scan or GET /qr", { qr_raw: qrString });
}

// ---------------------------------------------------------------------------
// WhatsApp connection
// ---------------------------------------------------------------------------

let reconnectAttempts = 0;
let isConnected = false;
let messageCount = 0;
let lastQr = null;
let currentSock = null;
let shuttingDown = false;
const startTime = Date.now();

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
    // QR code handled via connection.update event below
    syncFullHistory: SYNC_HISTORY,
  });

  currentSock = sock;
  sock.ev.on("creds.update", saveCreds);

  // --- Connection state ---
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQr = qr;
      renderQrToLog(qr);
    }

    if (connection === "open") {
      isConnected = true;
      reconnectAttempts = 0;
      const me = sock.user?.id || "unknown";
      jlog("info", "Connected", { identity: me });
      ensureAccountRow(me).catch((e) =>
        jlog("error", "Failed to register account", { error: e.message }),
      );
      // Mark force-reauth as completed so it won't repeat on next restart
      if (FORCE_REAUTH) {
        try { writeFileSync(`${AUTH_DIR}/.reauth-done`, FORCE_REAUTH); } catch { /* harmless */ }
      }
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      jlog("info", "Disconnected", { status_code: statusCode, will_reconnect: shouldReconnect });

      if (shouldReconnect && !shuttingDown) {
        reconnectAttempts++;
        const delay = Math.min(60_000, 1000 * Math.pow(2, reconnectAttempts));
        jlog("info", "Reconnecting", { delay_ms: delay, attempt: reconnectAttempts });
        setTimeout(startWhatsApp, delay);
      } else {
        jlog("warn", "Logged out — delete auth state and re-scan QR");
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
        // pushName is self-set by the contact; fall back to readable phone number
        const rawPhone = (senderId || "").replace(/@.*$/, "");
        const senderName = msg.pushName || (rawPhone ? `+${rawPhone}` : null);
        let text = extractText(msg);
        const timestamp = msg.messageTimestamp;
        const ts = new Date(Number(timestamp) * 1000);

        let groupName = null;
        if (isGroup) {
          groupName = await getGroupName(sock, remoteJid);
        }

        const metadata = {
          message_id: msg.key.id,
          is_group: isGroup,
          group_name: groupName,
        };

        if (isVoiceMessage(msg)) {
          metadata.media_type = "voice";
          const transcript = await transcribeAudio(msg);
          if (transcript) {
            text = transcript;
            metadata.transcribed = true;
            jlog("info", "Transcribed voice", { chars: transcript.length });
          } else {
            metadata.transcription_failed = true;
          }
        }

        if (!text && !metadata.media_type) continue; // skip non-voice empty

        await insertMessage({
          threadId: remoteJid,
          senderId,
          senderName,
          text,
          ts,
          metadata,
        });
        messageCount++;
      } catch (e) {
        jlog("error", "Failed to ingest message", { error: e.message });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP health endpoint
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const checks = {};
    let overall = "ok";

    // DB connectivity check
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        checks.db = { status: "ok" };
      } finally {
        client.release();
      }
    } catch (e) {
      checks.db = { status: "error", detail: e.message };
      overall = "error";
    }

    // WhatsApp connection status
    if (isConnected) {
      checks.whatsapp = { status: "ok", account: ACCOUNT_LABEL };
    } else if (lastQr) {
      checks.whatsapp = { status: "degraded", detail: "awaiting QR scan", account: ACCOUNT_LABEL };
      if (overall === "ok") overall = "degraded";
    } else {
      checks.whatsapp = { status: "error", detail: "disconnected", account: ACCOUNT_LABEL };
      overall = "error";
    }

    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: overall,
      checks,
      uptime_seconds: uptimeSeconds,
      messages_ingested: messageCount,
    }));
    return;
  }
  if (req.method === "GET" && (req.url === "/qr" || req.url?.startsWith("/qr?"))) {
    // Auth check — /qr allows device pairing, must be protected
    if (SIDECAR_AUTH_TOKEN) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = req.headers["x-internal-token"] || url.searchParams.get("token") || "";
      if (token !== SIDECAR_AUTH_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    if (isConnected) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h1>WhatsApp Connected</h1><p>Already paired and running.</p></body></html>");
      return;
    }
    if (lastQr) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
</head><body style="font-family:sans-serif;text-align:center;padding:40px">
<h1>WhatsApp QR Code</h1>
<p>Scan with WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>
<canvas id="qr"></canvas>
<p style="color:#888;font-size:12px">Auto-refreshes every 10s</p>
<script>
QRCode.toCanvas(document.getElementById('qr'),${JSON.stringify(lastQr)},{width:400,margin:2});
setTimeout(()=>location.reload(),10000);
</script></body></html>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body style='font-family:sans-serif;text-align:center;padding:40px'><h1>No QR Yet</h1><p>Waiting for QR code generation... Refresh in a few seconds.</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>");
    return;
  }
  // Backup endpoint — returns auth state as base64 tar.gz
  if (req.method === "GET" && req.url === "/backup") {
    if (SIDECAR_AUTH_TOKEN) {
      const token = req.headers["x-internal-token"] || "";
      if (token !== SIDECAR_AUTH_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    try {
      if (!existsSync(AUTH_DIR) || readdirSync(AUTH_DIR).length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content_base64: null, error: "no auth state" }));
        return;
      }
      const buf = execSync(`tar czf - -C "${AUTH_DIR}" .`, { maxBuffer: 50 * 1024 * 1024 });
      const filesCount = readdirSync(AUTH_DIR).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        content_base64: buf.toString("base64"),
        files_count: filesCount,
        size_bytes: buf.length,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
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

  // Clear auth state if force reauth is requested (single-use per unique value)
  const reauthMarker = `${AUTH_DIR}/.reauth-done`;
  if (FORCE_REAUTH && existsSync(AUTH_DIR)) {
    // Check if this reauth value was already processed
    let markerValue = "";
    try { markerValue = existsSync(reauthMarker) ? readFileSync(reauthMarker, "utf-8").trim() : ""; } catch {}
    if (markerValue !== FORCE_REAUTH) {
      jlog("info", "Clearing auth state for re-pairing", { force_reauth: FORCE_REAUTH });
      for (const f of readdirSync(AUTH_DIR)) {
        rmSync(`${AUTH_DIR}/${f}`, { recursive: true, force: true });
      }
      jlog("info", "Auth state cleared — will generate new QR");
    } else {
      jlog("info", "Force reauth already completed — skipping", { force_reauth: FORCE_REAUTH });
    }
  }

  jlog("info", "Starting", {
    account: ACCOUNT_LABEL,
    auth_dir: AUTH_DIR,
    skip_own: SKIP_FROM_ME,
    sync_history: SYNC_HISTORY,
  });

  server.listen(HTTP_PORT, "0.0.0.0", () => {
    jlog("info", "Health endpoint listening", { port: HTTP_PORT });
  });

  await startWhatsApp();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  jlog("info", "Shutdown signal received", { signal: sig });

  // Force exit safety net
  setTimeout(() => {
    jlog("warn", "Force exit after timeout");
    process.exit(1);
  }, 8000).unref();

  server.close(() => jlog("info", "HTTP server closed"));
  if (currentSock) {
    try { currentSock.end(undefined); } catch {}
    jlog("info", "WhatsApp socket closed");
  }
  pool.end()
    .then(() => jlog("info", "DB pool closed"))
    .catch((e) => jlog("error", "DB pool close error", { error: e.message }))
    .finally(() => {
      jlog("info", "Shutdown complete");
      process.exit(0);
    });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main().catch((e) => {
  jlog("error", "Fatal error", { error: e.message, stack: e.stack });
  process.exit(1);
});
