import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// MCP client — lightweight JSON-RPC 2.0 over HTTP (Node.js 22 native fetch)
// ---------------------------------------------------------------------------

const MCP_TIMEOUT_MS = 30_000;

let _mcpUrl: string | undefined;
let _dbUrl: string | undefined;
let _mcpSessionId: string | undefined;
let _mcpInitPromise: Promise<void> | undefined;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = MCP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
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
    _mcpInitPromise = mcpInit().catch((e) => {
      _mcpInitPromise = undefined;
      throw e;
    });
  }
  await _mcpInitPromise;
}

async function mcpCall(toolName: string, args: Record<string, unknown> = {}) {
  await ensureMcpSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (_mcpSessionId) headers["Mcp-Session-Id"] = _mcpSessionId;

  const res = await fetchWithTimeout(`${mcpUrl()}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!res.ok) {
    // Session expired — reset and retry once
    if (res.status === 404 || res.status === 400) {
      _mcpSessionId = undefined;
      _mcpInitPromise = undefined;
      await ensureMcpSession();
      const headers2: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (_mcpSessionId) headers2["Mcp-Session-Id"] = _mcpSessionId;
      const res2 = await fetchWithTimeout(`${mcpUrl()}/mcp`, {
        method: "POST",
        headers: headers2,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      if (!res2.ok) {
        throw new Error(`MCP HTTP ${res2.status}: ${await res2.text()}`);
      }
      const json2 = await parseMcpBody(res2);
      if (json2.error) throw new Error(json2.error.message);
      return json2.result;
    }
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await parseMcpBody(res);
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ---------------------------------------------------------------------------
// Postgres helper — simple query via pg wire protocol isn't practical here,
// so we use a tiny HTTP wrapper. For MVP, we inline a fetch to a pg-rest
// endpoint or fall back to "not configured" when dbUrl is absent.
//
// Since the gateway runs Node.js without a pg driver, Telegram message search
// returns a "db not configured" stub when dbUrl is not set. In production
// the gateway will have DATABASE_URL and we can swap in a proper pg client.
// ---------------------------------------------------------------------------

async function queryTelegramMessages(
  query: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<{ rows: unknown[]; source: string }> {
  if (!_dbUrl) return { rows: [], source: "telegram (db not configured)" };

  // We rely on the sidecar's Postgres being accessible. Since Node.js 22
  // doesn't bundle a pg driver and the plugin can't install npm deps,
  // we use a lightweight approach: if DATABASE_URL looks like a postgres://
  // URL, we note it for future use. For now, return empty.
  return { rows: [], source: "telegram (pg driver pending)" };
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
  description: "Gmail/Calendar/Drive/Telegram — search, send, schedule, report.",
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
      dbUrl: {
        type: "string",
        description: "PostgreSQL connection string for Telegram message index",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = (api as unknown as { config: Record<string, string> })
      .config ?? {};
    _mcpUrl = config.mcpServerUrl || process.env.GOOGLE_MCP_URL;
    _dbUrl = config.dbUrl || process.env.DATABASE_URL;

    // -----------------------------------------------------------------------
    // Gmail tools
    // -----------------------------------------------------------------------

    api.registerTool({
      name: "work_search_messages",
      label: "Search Messages",
      description:
        "Search messages across Gmail and Telegram. Returns combined results.",
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
            description: "Filter by channel: gmail, telegram, or all (default: all)",
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
        const results: { gmail?: unknown; telegram?: unknown } = {};

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
            const tg = await queryTelegramMessages(query, {
              from,
              to,
              limit,
            });
            results.telegram = tg;
          } catch (e) {
            results.telegram = { error: (e as Error).message };
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
          data.telegram = await queryTelegramMessages(project, {
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
            projectData.telegram = await queryTelegramMessages(project, {
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
