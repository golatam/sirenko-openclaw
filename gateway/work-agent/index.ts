import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// MCP client — lightweight JSON-RPC 2.0 over HTTP (Node.js 22 native fetch)
// ---------------------------------------------------------------------------

const MCP_TIMEOUT_MS = 30_000;
const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_BASE_MS = 1_000; // 1s, 2s, 4s

let _mcpUrl: string | undefined;
let _tgSidecarUrl: string | undefined;
let _tavilyApiKey: string | undefined;
let _mcpSessionId: string | undefined;
let _mcpInitPromise: Promise<void> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = MCP_TIMEOUT_MS): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
      return res;
    } catch (e) {
      lastError = e as Error;
      // Only retry on network-level errors (fetch failed, ECONNREFUSED, DNS, abort/timeout)
      // Do NOT retry if we got an HTTP response (that's handled by callers)
      const msg = lastError.message || "";
      const isNetworkError = msg.includes("fetch failed") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("UND_ERR_CONNECT_TIMEOUT") ||
        msg.includes("abort") ||
        lastError.name === "AbortError";
      if (!isNetworkError || attempt === FETCH_MAX_RETRIES) {
        throw lastError;
      }
      const delayMs = FETCH_RETRY_BASE_MS * Math.pow(2, attempt);
      console.error(`[work-agent] fetch attempt ${attempt + 1} failed (${msg}), retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw lastError!;
}

function mcpUrl(): string {
  if (!_mcpUrl) throw new Error("mcpServerUrl is not configured");
  return _mcpUrl;
}

/** Parse MCP response that may be JSON or SSE (text/event-stream). */
async function parseMcpBody(res: Response): Promise<{ result?: unknown; error?: { message: string } }> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    // SSE format: "event: message\ndata: {json}\n\n"
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith("data:")) {
        return JSON.parse(line.slice(5).trim());
      }
    }
    throw new Error("No data in SSE response");
  }
  return res.json();
}

async function mcpInit(): Promise<void> {
  const res = await fetchWithTimeout(`${mcpUrl()}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "work-agent-plugin", version: "1.0.0" },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`MCP init HTTP ${res.status}: ${await res.text()}`);
  }
  const sid = res.headers.get("mcp-session-id");
  if (sid) _mcpSessionId = sid;
  // Read body to completion (may be JSON or SSE)
  await parseMcpBody(res);
}

async function ensureMcpSession(): Promise<void> {
  if (_mcpSessionId) return;
  if (!_mcpInitPromise) {
    _mcpInitPromise = mcpInit()
      .then(() => {
        console.error("[work-agent] MCP session initialized, sessionId:", _mcpSessionId);
      })
      .catch((e) => {
        console.error("[work-agent] MCP init failed:", (e as Error).message);
        _mcpInitPromise = undefined;
        throw e;
      });
  }
  await _mcpInitPromise;
}

async function mcpCall(toolName: string, args: Record<string, unknown> = {}) {
  await ensureMcpSession();

  const doCall = async (): Promise<Response> => {
    const hdrs: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (_mcpSessionId) hdrs["Mcp-Session-Id"] = _mcpSessionId;
    return fetchWithTimeout(`${mcpUrl()}/mcp`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
  };

  let res = await doCall();
  if (!res.ok) {
    // Session expired — reset and retry once
    if (res.status === 404 || res.status === 400) {
      console.error(`[work-agent] MCP session expired (${res.status}), re-initializing...`);
      _mcpSessionId = undefined;
      _mcpInitPromise = undefined;
      await ensureMcpSession();
      res = await doCall();
      if (!res.ok) {
        throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
      }
    } else {
      throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
    }
  }
  const json = await parseMcpBody(res);
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ---------------------------------------------------------------------------
// Tavily web search — lightweight REST API client
// ---------------------------------------------------------------------------

async function tavilySearch(
  query: string,
  opts: { maxResults?: number; searchDepth?: string; includeAnswer?: boolean } = {},
): Promise<unknown> {
  if (!_tavilyApiKey) throw new Error("TAVILY_API_KEY is not configured");

  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: _tavilyApiKey,
      query,
      max_results: opts.maxResults ?? 5,
      search_depth: opts.searchDepth ?? "basic",
      include_answer: opts.includeAnswer ?? true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Telegram sidecar HTTP client — queries messages via telegram-sidecar's
// /search endpoint (PostgreSQL full-text search under the hood).
// ---------------------------------------------------------------------------

async function queryMessages(
  query: string,
  opts: { source?: string; from?: string; to?: string; limit?: number } = {},
): Promise<{ rows: unknown[]; total: number; source: string }> {
  if (!_tgSidecarUrl) return { rows: [], total: 0, source: "messaging (sidecar not configured)" };

  const body: Record<string, unknown> = { query };
  if (opts.source) body.source = opts.source;
  if (opts.from) body.from = opts.from;
  if (opts.to) body.to = opts.to;
  if (opts.limit) body.limit = opts.limit;

  console.error(`[work-agent] queryMessages: ${_tgSidecarUrl}/search source=${opts.source || "all"}`);
  const res = await fetchWithTimeout(`${_tgSidecarUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Telegram search HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { messages?: unknown[]; total?: number };
  return {
    rows: data.messages || [],
    total: data.total || 0,
    source: opts.source || "all",
  };
}

// ---------------------------------------------------------------------------
// Slack Web API — direct calls for Block Kit interactive messages
// ---------------------------------------------------------------------------

async function slackApi(method: string, body: Record<string, unknown>) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not available to plugin");
  const res = await fetchWithTimeout(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the params object from execute() arguments.
 * OpenClaw calls execute(toolUseId, params, context, callback) — 4 args.
 * This helper safely extracts the params object regardless of call convention.
 */
function extractParams(rawArgs: unknown[]): Record<string, unknown> {
  if (typeof rawArgs[0] === "string" && rawArgs.length > 1 && typeof rawArgs[1] === "object" && rawArgs[1] !== null) {
    return rawArgs[1] as Record<string, unknown>;
  }
  return (rawArgs[0] as Record<string, unknown>) ?? {};
}

/**
 * Resolve a parameter that may arrive as snake_case or camelCase.
 * OpenClaw may convert snake_case param names (e.g. message_id → messageId)
 * when routing tool calls. This helper checks both forms.
 */
function param(params: Record<string, unknown>, snakeName: string): unknown {
  if (params[snakeName] !== undefined) return params[snakeName];
  const camelName = snakeName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camelName !== snakeName && params[camelName] !== undefined) return params[camelName];
  return undefined;
}

function ok(data: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
    details: { ok: true, ...details },
  };
}

function err(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: message }, null, 2),
      },
    ],
    details: { ok: false, error: message },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const WorkAgentPlugin = {
  id: "work-agent",
  name: "Work Agent",
  description: "Gmail/Calendar/Drive/Telegram/Slack — search, send, schedule, report, interactive UI.",
  kind: "tools",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mcpServerUrl: {
        type: "string",
        description:
          "URL of google-mcp-sidecar (e.g. http://google-mcp-sidecar.railway.internal:8000)",
      },
      telegramSidecarUrl: {
        type: "string",
        description:
          "URL of telegram-sidecar HTTP API (e.g. http://telegram-sidecar.railway.internal:8000)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = (api as unknown as { config: Record<string, string> })
      .config ?? {};
    _mcpUrl = config.mcpServerUrl || process.env.GOOGLE_MCP_URL;
    _tgSidecarUrl = config.telegramSidecarUrl || process.env.TELEGRAM_SIDECAR_URL;
    _tavilyApiKey = config.tavilyApiKey || process.env.TAVILY_API_KEY;
    console.error(`[work-agent] mcpUrl=${_mcpUrl} tgSidecarUrl=${_tgSidecarUrl} tavily=${_tavilyApiKey ? "configured" : "not set"}`);

    // -----------------------------------------------------------------------
    // Gmail tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_search_messages",
      label: "Search Messages",
      description:
        "Search messages across Gmail, Telegram, and WhatsApp. Returns combined results.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query" },
          account: {
            type: "string",
            description: "Gmail account email (optional, searches all if omitted)",
          },
          channel: {
            type: "string",
            description: "Filter by channel: gmail, telegram, whatsapp, or all (default: all)",
          },
          from: { type: "string", description: "Start date (ISO 8601)" },
          to: { type: "string", description: "End date (ISO 8601)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["query"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        const query = (param(params, "query") as string) || "";
        const channel = (param(params, "channel") as string) || "all";
        const account = param(params, "account") as string | undefined;
        const from = param(params, "from") as string | undefined;
        const to = param(params, "to") as string | undefined;
        const limit = (param(params, "limit") as number) || 20;
        const results: { gmail?: unknown; telegram?: unknown; whatsapp?: unknown } = {};

        // Gmail search
        if (channel === "all" || channel === "gmail") {
          try {
            const gmailQuery = [
              query,
              from ? `after:${from}` : "",
              to ? `before:${to}` : "",
            ]
              .filter(Boolean)
              .join(" ");

            const gmailArgs: Record<string, unknown> = {
              query: gmailQuery,
              max_results: limit,
            };
            if (account) gmailArgs.account = account;

            results.gmail = await mcpCall("query_gmail_emails", gmailArgs);
          } catch (e) {
            results.gmail = { error: (e as Error).message };
          }
        }

        // Telegram search
        if (channel === "all" || channel === "telegram") {
          try {
            results.telegram = await queryMessages(query, {
              source: "telegram",
              from,
              to,
              limit,
            });
          } catch (e) {
            results.telegram = { error: (e as Error).message };
          }
        }

        // WhatsApp search
        if (channel === "all" || channel === "whatsapp") {
          try {
            results.whatsapp = await queryMessages(query, {
              source: "whatsapp",
              from,
              to,
              limit,
            });
          } catch (e) {
            results.whatsapp = { error: (e as Error).message };
          }
        }

        return ok(results, { channel });
      },
    });

    api.registerTool({
      name: "work_read_email",
      label: "Read Email",
      description: "Read a specific email by message ID.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          message_id: { type: "string", description: "Gmail message ID" },
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
        },
        required: ["message_id"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const messageId = param(params, "message_id") as string;
          if (!messageId) return err("message_id is required");
          const args: Record<string, unknown> = {
            message_id: messageId,
          };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const result = await mcpCall("gmail_get_message_details", args);
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    api.registerTool({
      name: "work_send_email",
      label: "Send Email",
      description:
        "Send an email via a connected Gmail account. Requires user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: {
            type: "string",
            description: "Gmail account email to send from (optional)",
          },
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          message: { type: "string", description: "Email body (plain text or HTML)" },
          cc: { type: "string", description: "CC recipients (comma-separated)" },
          bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        },
        required: ["to", "subject", "message"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const to = param(params, "to") as string;
          const subject = param(params, "subject") as string;
          const message = param(params, "message") as string;
          if (!to || !subject || !message) return err("to, subject, and message are required");

          const args: Record<string, unknown> = { to, subject, body: message };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const cc = param(params, "cc") as string | undefined;
          if (cc) args.cc = cc;
          const bcc = param(params, "bcc") as string | undefined;
          if (bcc) args.bcc = bcc;

          const result = await mcpCall("gmail_send_email", args);
          return ok(result, { action: "email_sent" });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Calendar tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_list_calendars",
      label: "List Calendars",
      description: "List available Google Calendars.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
        },
        required: [],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const args: Record<string, unknown> = {};
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const result = await mcpCall("calendar_get_events", args);
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    api.registerTool({
      name: "work_list_events",
      label: "List Calendar Events",
      description: "List events from a Google Calendar.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
          calendar_id: {
            type: "string",
            description: "Calendar ID (default: primary)",
          },
          time_min: {
            type: "string",
            description: "Start time (ISO 8601)",
          },
          time_max: {
            type: "string",
            description: "End time (ISO 8601)",
          },
          max_results: {
            type: "number",
            description: "Max events to return (default 10)",
          },
        },
        required: [],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const args: Record<string, unknown> = {
            calendar_id: (param(params, "calendar_id") as string) || "primary",
            max_results: (param(params, "max_results") as number) || 10,
          };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const timeMin = param(params, "time_min") as string | undefined;
          if (timeMin) args.time_min = timeMin;
          const timeMax = param(params, "time_max") as string | undefined;
          if (timeMax) args.time_max = timeMax;

          const result = await mcpCall("calendar_get_events", args);
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    api.registerTool({
      name: "work_schedule_meeting",
      label: "Schedule Meeting",
      description:
        "Create a Google Calendar event. Requires user confirmation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
          title: { type: "string", description: "Event title" },
          start: { type: "string", description: "Start time (ISO 8601)" },
          end: { type: "string", description: "End time (ISO 8601)" },
          description: { type: "string", description: "Event description" },
          location: { type: "string", description: "Event location" },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Attendee email addresses",
          },
          calendar_id: {
            type: "string",
            description: "Calendar ID (default: primary)",
          },
        },
        required: ["title", "start", "end"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const title = (param(params, "title") as string) || "";
          const start = (param(params, "start") as string) || "";
          const end = (param(params, "end") as string) || "";
          if (!title || !start || !end) return err("title, start, and end are required");

          const args: Record<string, unknown> = {
            summary: title,
            start_time: start,
            end_time: end,
            calendar_id: (param(params, "calendar_id") as string) || "primary",
          };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const description = param(params, "description") as string | undefined;
          if (description) args.description = description;
          const location = param(params, "location") as string | undefined;
          if (location) args.location = location;
          const attendees = param(params, "attendees") as string[] | undefined;
          if (attendees?.length) args.attendees = attendees;

          const result = await mcpCall("create_calendar_event", args);
          return ok(result, { action: "event_created" });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Drive tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_drive_search",
      label: "Search Drive",
      description: "Search files in Google Drive.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query" },
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
          max_results: {
            type: "number",
            description: "Max results (default 10)",
          },
        },
        required: ["query"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const query = (param(params, "query") as string) || "";
          if (!query) return err("query is required");
          const args: Record<string, unknown> = {
            query,
            max_results: (param(params, "max_results") as number) || 10,
          };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const result = await mcpCall("drive_search_files", args);
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    api.registerTool({
      name: "work_drive_read",
      label: "Read Drive File",
      description: "Read a file from Google Drive by file ID.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_id: { type: "string", description: "Google Drive file ID" },
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
        },
        required: ["file_id"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const fileId = param(params, "file_id") as string;
          if (!fileId) return err("file_id is required");
          const args: Record<string, unknown> = { file_id: fileId };
          const account = param(params, "account") as string | undefined;
          if (account) args.account = account;
          const result = await mcpCall("drive_read_file_content", args);
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Web search (Tavily)
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_web_search",
      label: "Web Search",
      description:
        "Search the web using Tavily. Returns relevant results with snippets and an AI-generated answer summary.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: {
            type: "number",
            description: "Max results to return (default 5, max 20)",
          },
          search_depth: {
            type: "string",
            description: "Search depth: 'basic' (fast) or 'advanced' (thorough, uses more credits). Default: basic",
          },
        },
        required: ["query"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const query = param(params, "query") as string;
          if (!query) return err("query is required");
          const maxResults = Math.min((param(params, "max_results") as number) || 5, 20);
          const searchDepth = (param(params, "search_depth") as string) || "basic";

          const result = await tavilySearch(query, {
            maxResults,
            searchDepth,
            includeAnswer: true,
          });
          return ok(result);
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Context / introspection
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_get_channel_info",
      label: "Get Channel Info",
      description:
        "Returns current conversation context: channel name, channel ID, source (slack/telegram/dm), user info. Call this to know where you are.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(...rawArgs: unknown[]) {
        const context = rawArgs[2] as Record<string, unknown> | undefined;
        console.error("[work_get_channel_info] context:", JSON.stringify(context, null, 2));

        if (!context) return ok({ warning: "No context available" });

        const info: Record<string, unknown> = {};
        for (const key of [
          "channel", "channelId", "channelName", "channelType",
          "conversation", "source", "user", "userId", "userName",
          "threadId", "messageId", "sessionId",
        ]) {
          if (context[key] !== undefined) info[key] = context[key];
        }
        // If no known keys matched — return entire context for diagnostics
        if (Object.keys(info).length === 0) {
          info._raw = context;
          info._keys = Object.keys(context);
        }
        return ok(info);
      },
    });

    // -----------------------------------------------------------------------
    // Usage & cost tracking
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_usage_summary",
      label: "Usage Summary",
      description:
        "Get token usage and cost summary. Returns daily breakdown with input/output tokens and estimated cost in USD.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          days: {
            type: "number",
            description: "Number of days to include (default 7)",
          },
        },
        required: [],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        const days = (param(params, "days") as number) || 7;
        try {
          // Dynamic import of internal OpenClaw module (version pinned to 2026.2.23)
          const openclawMain = require.resolve("openclaw");
          const modulePath = openclawMain.replace(
            /dist[/\\]index\.(js|ts)$/,
            "dist/plugin-sdk/infra/session-cost-usage.js",
          );
          const { loadCostUsageSummary } = await import(modulePath);
          const summary = await loadCostUsageSummary({ days });
          return ok({
            period: `last ${days} days`,
            totals: {
              tokens: summary.totals.totalTokens,
              input: summary.totals.input,
              output: summary.totals.output,
              cacheRead: summary.totals.cacheRead,
              costUsd: Math.round(summary.totals.totalCost * 10000) / 10000,
            },
            daily: summary.daily.map((d: Record<string, unknown>) => ({
              date: d.date,
              tokens: d.totalTokens,
              costUsd: Math.round((d.totalCost as number) * 10000) / 10000,
            })),
          });
        } catch (e) {
          return err(`Usage data unavailable: ${(e as Error).message}`);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Slack interactive (Block Kit)
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_slack_interactive",
      label: "Send Interactive Message",
      description:
        "Send a Slack message with Block Kit interactive elements (buttons, selects, checkboxes). " +
        "Use for confirmations, choices, and checklists. " +
        "All action_id values MUST start with 'openclaw:' prefix for callback routing. " +
        "Returns message ts needed for work_slack_update.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: {
            type: "string",
            description: "Slack channel ID (get from work_get_channel_info)",
          },
          blocks: {
            type: "array",
            description: "Slack Block Kit blocks array (JSON). All action_id must start with 'openclaw:'",
          },
          text: {
            type: "string",
            description: "Fallback text for notifications (shown in mobile push, etc.)",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp to reply in thread (optional)",
          },
        },
        required: ["channel", "blocks", "text"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const channel = param(params, "channel") as string;
          const blocks = param(params, "blocks") as unknown[];
          const text = param(params, "text") as string;
          const threadTs = param(params, "thread_ts") as string | undefined;
          if (!channel) return err("channel is required");
          if (!blocks || !Array.isArray(blocks)) return err("blocks must be an array");
          if (!text) return err("text (fallback) is required");

          const body: Record<string, unknown> = { channel, blocks, text };
          if (threadTs) body.thread_ts = threadTs;
          const result = await slackApi("chat.postMessage", body);
          return ok({ sent: true, ts: result.ts, channel: result.channel });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    api.registerTool({
      name: "work_slack_update",
      label: "Update Slack Message",
      description:
        "Update an existing Slack message (e.g. replace buttons with result after user clicks). " +
        "Use after receiving a Slack interaction callback to remove buttons and show outcome.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string", description: "Slack channel ID" },
          ts: {
            type: "string",
            description: "Message timestamp to update (from work_slack_interactive result or interaction payload)",
          },
          blocks: {
            type: "array",
            description: "New Block Kit blocks (replaces old blocks)",
          },
          text: {
            type: "string",
            description: "New fallback text",
          },
        },
        required: ["channel", "ts", "text"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        try {
          const channel = param(params, "channel") as string;
          const ts = param(params, "ts") as string;
          const text = param(params, "text") as string;
          const blocks = param(params, "blocks") as unknown[] | undefined;
          if (!channel || !ts) return err("channel and ts are required");

          const body: Record<string, unknown> = { channel, ts, text };
          if (blocks && Array.isArray(blocks)) body.blocks = blocks;
          const result = await slackApi("chat.update", body);
          return ok({ updated: true, ts: result.ts, channel: result.channel });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    });

    // -----------------------------------------------------------------------
    // Aggregation tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_summarize_project",
      label: "Summarize Project",
      description:
        "Gather messages from Gmail and Telegram for a project. Returns raw data for the agent to summarize.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          project: { type: "string", description: "Project name or keyword" },
          from: { type: "string", description: "Start date (ISO 8601)" },
          to: { type: "string", description: "End date (ISO 8601)" },
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
        },
        required: ["project"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        const project = (param(params, "project") as string) || "";
        const from = param(params, "from") as string | undefined;
        const to = param(params, "to") as string | undefined;
        const account = param(params, "account") as string | undefined;
        const data: { gmail?: unknown; telegram?: unknown } = {};

        // Gmail
        try {
          const gmailQuery = [
            project,
            from ? `after:${from}` : "",
            to ? `before:${to}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const args: Record<string, unknown> = {
            query: gmailQuery,
            max_results: 50,
          };
          if (account) args.account = account;
          data.gmail = await mcpCall("query_gmail_emails", args);
        } catch (e) {
          data.gmail = { error: (e as Error).message };
        }

        // Telegram
        try {
          data.telegram = await queryMessages(project, {
            from,
            to,
            limit: 50,
          });
        } catch (e) {
          data.telegram = { error: (e as Error).message };
        }

        return ok(data, { project });
      },
    });

    api.registerTool({
      name: "work_weekly_report",
      label: "Weekly Report",
      description:
        "Gather data from all sources (Gmail, Calendar, Telegram) for a weekly report. Returns raw data for the agent to format.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          projects: {
            type: "array",
            items: { type: "string" },
            description: "Project names/keywords to include",
          },
          week_start: {
            type: "string",
            description: "Week start date (ISO 8601, default: last Monday)",
          },
          week_end: {
            type: "string",
            description: "Week end date (ISO 8601, default: this Sunday)",
          },
          account: {
            type: "string",
            description: "Gmail account email (optional)",
          },
        },
        required: ["projects"],
      },
      async execute(...rawArgs: unknown[]) {
        const params = extractParams(rawArgs);
        const projects = (param(params, "projects") as string[]) || [];
        const account = param(params, "account") as string | undefined;

        // Calculate default week boundaries
        const now = new Date();
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(now);
        monday.setDate(now.getDate() + mondayOffset);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        const weekStart = (param(params, "week_start") as string) || monday.toISOString();
        const weekEnd = (param(params, "week_end") as string) || sunday.toISOString();

        const report: {
          period: { start: string; end: string };
          projects: Record<string, { gmail?: unknown; telegram?: unknown }>;
          calendar?: unknown;
        } = {
          period: { start: weekStart, end: weekEnd },
          projects: {},
        };

        // Per-project data
        for (const project of projects) {
          const projectData: { gmail?: unknown; telegram?: unknown } = {};

          try {
            const gmailQuery = `${project} after:${weekStart.slice(0, 10)} before:${weekEnd.slice(0, 10)}`;
            const args: Record<string, unknown> = {
              query: gmailQuery,
              max_results: 50,
            };
            if (account) args.account = account;
            projectData.gmail = await mcpCall("query_gmail_emails", args);
          } catch (e) {
            projectData.gmail = { error: (e as Error).message };
          }

          try {
            projectData.telegram = await queryMessages(project, {
              from: weekStart,
              to: weekEnd,
              limit: 50,
            });
          } catch (e) {
            projectData.telegram = { error: (e as Error).message };
          }

          report.projects[project] = projectData;
        }

        // Calendar events for the week
        try {
          const calArgs: Record<string, unknown> = {
            calendar_id: "primary",
            time_min: weekStart,
            time_max: weekEnd,
            max_results: 50,
          };
          if (account) calArgs.account = account;
          report.calendar = await mcpCall("calendar_get_events", calArgs);
        } catch (e) {
          report.calendar = { error: (e as Error).message };
        }

        return ok(report, { projects });
      },
    });
  },
};

export default WorkAgentPlugin;
