import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// MCP client — lightweight JSON-RPC 2.0 over HTTP (Node.js 22 native fetch)
// ---------------------------------------------------------------------------

let _mcpUrl: string | undefined;
let _dbUrl: string | undefined;
let _mcpSessionId: string | undefined;
let _mcpInitPromise: Promise<void> | undefined;

function mcpUrl(): string {
  if (!_mcpUrl) throw new Error("mcpServerUrl is not configured");
  return _mcpUrl;
}

async function mcpInit(): Promise<void> {
  const res = await fetch(`${mcpUrl()}/mcp`, {
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
  // Read body to completion
  await res.json();
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

  const res = await fetch(`${mcpUrl()}/mcp`, {
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
      const res2 = await fetch(`${mcpUrl()}/mcp`, {
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
      const json2 = (await res2.json()) as {
        result?: unknown;
        error?: { message: string };
      };
      if (json2.error) throw new Error(json2.error.message);
      return json2.result;
    }
    throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
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
      async execute(params: {
        query: string;
        account?: string;
        channel?: string;
        from?: string;
        to?: string;
        limit?: number;
      }) {
        const channel = params.channel || "all";
        const results: { gmail?: unknown; telegram?: unknown } = {};

        // Gmail search
        if (channel === "all" || channel === "gmail") {
          try {
            const gmailQuery = [
              params.query,
              params.from ? `after:${params.from}` : "",
              params.to ? `before:${params.to}` : "",
            ]
              .filter(Boolean)
              .join(" ");

            const gmailArgs: Record<string, unknown> = {
              query: gmailQuery,
              max_results: params.limit || 20,
            };
            if (params.account) gmailArgs.account = params.account;

            results.gmail = await mcpCall("query_gmail_emails", gmailArgs);
          } catch (e) {
            results.gmail = { error: (e as Error).message };
          }
        }

        // Telegram search
        if (channel === "all" || channel === "telegram") {
          try {
            const tg = await queryTelegramMessages(params.query, {
              from: params.from,
              to: params.to,
              limit: params.limit,
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
      async execute(params: { message_id: string; account?: string }) {
        try {
          const args: Record<string, unknown> = {
            message_id: params.message_id,
          };
          if (params.account) args.account = params.account;
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
          body: { type: "string", description: "Email body (plain text or HTML)" },
          cc: { type: "string", description: "CC recipients (comma-separated)" },
          bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        },
        required: ["to", "subject", "body"],
      },
      async execute(params: {
        account?: string;
        to: string;
        subject: string;
        body: string;
        cc?: string;
        bcc?: string;
      }) {
        try {
          const args: Record<string, unknown> = {
            to: params.to,
            subject: params.subject,
            body: params.body,
          };
          if (params.account) args.account = params.account;
          if (params.cc) args.cc = params.cc;
          if (params.bcc) args.bcc = params.bcc;

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
      async execute(params: { account?: string }) {
        try {
          const args: Record<string, unknown> = {};
          if (params.account) args.account = params.account;
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
      async execute(params: {
        account?: string;
        calendar_id?: string;
        time_min?: string;
        time_max?: string;
        max_results?: number;
      }) {
        try {
          const args: Record<string, unknown> = {
            calendar_id: params.calendar_id || "primary",
            max_results: params.max_results || 10,
          };
          if (params.account) args.account = params.account;
          if (params.time_min) args.time_min = params.time_min;
          if (params.time_max) args.time_max = params.time_max;

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
      async execute(params: {
        account?: string;
        title: string;
        start: string;
        end: string;
        description?: string;
        location?: string;
        attendees?: string[];
        calendar_id?: string;
      }) {
        try {
          const args: Record<string, unknown> = {
            summary: params.title,
            start_time: params.start,
            end_time: params.end,
            calendar_id: params.calendar_id || "primary",
          };
          if (params.account) args.account = params.account;
          if (params.description) args.description = params.description;
          if (params.location) args.location = params.location;
          if (params.attendees?.length) args.attendees = params.attendees;

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
      async execute(params: {
        query: string;
        account?: string;
        max_results?: number;
      }) {
        try {
          const args: Record<string, unknown> = {
            query: params.query,
            max_results: params.max_results || 10,
          };
          if (params.account) args.account = params.account;
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
      async execute(params: { file_id: string; account?: string }) {
        try {
          const args: Record<string, unknown> = { file_id: params.file_id };
          if (params.account) args.account = params.account;
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
      async execute(params: {
        project: string;
        from?: string;
        to?: string;
        account?: string;
      }) {
        const data: { gmail?: unknown; telegram?: unknown } = {};

        // Gmail
        try {
          const gmailQuery = [
            params.project,
            params.from ? `after:${params.from}` : "",
            params.to ? `before:${params.to}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const args: Record<string, unknown> = {
            query: gmailQuery,
            max_results: 50,
          };
          if (params.account) args.account = params.account;
          data.gmail = await mcpCall("query_gmail_emails", args);
        } catch (e) {
          data.gmail = { error: (e as Error).message };
        }

        // Telegram
        try {
          data.telegram = await queryTelegramMessages(params.project, {
            from: params.from,
            to: params.to,
            limit: 50,
          });
        } catch (e) {
          data.telegram = { error: (e as Error).message };
        }

        return ok(data, { project: params.project });
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
      async execute(params: {
        projects: string[];
        week_start?: string;
        week_end?: string;
        account?: string;
      }) {
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

        const weekStart = params.week_start || monday.toISOString();
        const weekEnd = params.week_end || sunday.toISOString();

        const report: {
          period: { start: string; end: string };
          projects: Record<string, { gmail?: unknown; telegram?: unknown }>;
          calendar?: unknown;
        } = {
          period: { start: weekStart, end: weekEnd },
          projects: {},
        };

        // Per-project data
        for (const project of params.projects) {
          const projectData: { gmail?: unknown; telegram?: unknown } = {};

          try {
            const gmailQuery = `${project} after:${weekStart.slice(0, 10)} before:${weekEnd.slice(0, 10)}`;
            const args: Record<string, unknown> = {
              query: gmailQuery,
              max_results: 50,
            };
            if (params.account) args.account = params.account;
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
          if (params.account) calArgs.account = params.account;
          report.calendar = await mcpCall("calendar_get_events", calArgs);
        } catch (e) {
          report.calendar = { error: (e as Error).message };
        }

        return ok(report, { projects: params.projects });
      },
    });
  },
};

export default WorkAgentPlugin;
