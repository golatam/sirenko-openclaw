/**
 * ops.ts — Operational and cross-domain tools: unified search, aggregation,
 * health check, backup, usage, web search, channel info, periodic backup.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { queryMessages, tavilySearch, slackApi } from "./clients.js";
import { probeAllSidecars } from "./health.js";
import { runBackup, type BackupConfig, type BackupResult } from "./backup.js";
import { extractParams, extractContext, loadCostUsageSummaryFn, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

// ---------------------------------------------------------------------------
// Backup state persistence
// ---------------------------------------------------------------------------

const BACKUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;
const BACKUP_STARTUP_DELAY_MS = 10 * 60 * 1000;
const BACKUP_STATE_FILE = "/data/openclaw-state/backup-status.json";

function loadLastBackupTime(): number | null {
  try {
    const data = JSON.parse(readFileSync(BACKUP_STATE_FILE, "utf-8"));
    return data.lastSuccessMs || null;
  } catch {
    return null;
  }
}

function saveBackupStatus(result: BackupResult): void {
  try {
    mkdirSync(dirname(BACKUP_STATE_FILE), { recursive: true });
    const prev: Record<string, unknown> = {};
    try {
      Object.assign(prev, JSON.parse(readFileSync(BACKUP_STATE_FILE, "utf-8")));
    } catch {}
    writeFileSync(BACKUP_STATE_FILE, JSON.stringify({
      ...prev,
      ...(result.ok ? { lastSuccessMs: Date.now() } : {}),
      lastAttemptMs: Date.now(),
      lastResult: result,
      updatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error(`[work-agent] failed to save backup status: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export function registerOpsTools(api: OpenClawPluginApi, ctx: PluginContext): void {

  // -----------------------------------------------------------------------
  // Unified search (cross-domain)
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_search",
    label: "Unified Search",
    description:
      "Search across Gmail, Telegram, WhatsApp, Google Drive, and Calendar. " +
      "All sources are queried in parallel. Use `channel` to filter. " +
      "For messaging (Telegram/WhatsApp): FTS searches message text, sender names, and chat titles. " +
      "Use `chat_type` to filter by conversation type (e.g. 'private' for DMs) and `sender` to filter by sender name.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query (searches text, sender names, and chat titles in messaging)" },
        account: {
          type: "string",
          description: "Gmail account email (optional, searches all if omitted)",
        },
        channel: {
          type: "string",
          description:
            "Filter by channel: gmail, telegram, whatsapp, drive, calendar, or all (default: all)",
        },
        from: { type: "string", description: "Start date (ISO 8601)" },
        to: { type: "string", description: "End date (ISO 8601)" },
        limit: { type: "number", description: "Max results per source (default 20)" },
        chat_type: {
          type: "string",
          description: "Filter messaging by chat type: private (DMs), group, supergroup, channel",
        },
        sender: {
          type: "string",
          description: "Filter messaging by sender name (partial match, case-insensitive)",
        },
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
      const chatType = param(params, "chat_type") as string | undefined;
      const sender = param(params, "sender") as string | undefined;

      const tasks: { key: string; promise: Promise<unknown> }[] = [];

      if (channel === "all" || channel === "gmail") {
        const gmailQuery = [query, from ? `after:${from}` : "", to ? `before:${to}` : ""].filter(Boolean).join(" ");
        const gmailArgs: Record<string, unknown> = { query: gmailQuery, max_results: limit };
        if (account) gmailArgs.account = account;
        tasks.push({ key: "gmail", promise: ctx.requireGoogleMcp().call("query_gmail_emails", gmailArgs) });
      }

      if (channel === "all" || channel === "telegram") {
        tasks.push({ key: "telegram", promise: queryMessages(ctx, query, { source: "telegram", from, to, limit, chatType, sender }) });
      }

      if (channel === "all" || channel === "whatsapp") {
        tasks.push({ key: "whatsapp", promise: queryMessages(ctx, query, { source: "whatsapp", from, to, limit, chatType, sender }) });
      }

      if (channel === "all" || channel === "drive") {
        const driveQuery = `fullText contains '${query.replace(/'/g, "\\'")}'`;
        const driveArgs: Record<string, unknown> = { query: driveQuery, max_results: Math.min(limit, 10) };
        if (account) driveArgs.account = account;
        tasks.push({ key: "drive", promise: ctx.requireGoogleMcp().call("drive_search_files", driveArgs) });
      }

      if (channel === "all" || channel === "calendar") {
        const calArgs: Record<string, unknown> = { q: query, calendar_id: "primary", max_results: Math.min(limit, 20) };
        if (from) calArgs.time_min = from.includes("T") ? from : `${from}T00:00:00Z`;
        if (to) calArgs.time_max = to.includes("T") ? to : `${to}T23:59:59Z`;
        if (account) calArgs.account = account;
        tasks.push({ key: "calendar", promise: ctx.requireGoogleMcp().call("calendar_get_events", calArgs) });
      }

      const settled = await Promise.allSettled(tasks.map((t) => t.promise));
      const results: Record<string, unknown> = {};
      for (let i = 0; i < tasks.length; i++) {
        const outcome = settled[i];
        results[tasks[i].key] = outcome.status === "fulfilled" ? outcome.value : { error: (outcome.reason as Error).message };
      }

      return ok(results, { channel });
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
      const context = extractContext(rawArgs);
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
      if (Object.keys(info).length === 0) {
        info._raw = context;
        info._keys = Object.keys(context);
      }
      return ok(info);
    },
  });

  // -----------------------------------------------------------------------
  // Usage & cost
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
        days: { type: "number", description: "Number of days to include (default 7)" },
      },
      required: [],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      const days = (param(params, "days") as number) || 7;
      try {
        const loadCostUsageSummary = await loadCostUsageSummaryFn();
        if (!loadCostUsageSummary) return err("Usage module not available in this OpenClaw version");
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
  // Health check tool
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_health_check",
    label: "System Health Check",
    description:
      "Check health of all system components: Google MCP sidecar, Telegram sidecar, WhatsApp sidecar. " +
      "Returns per-component status (ok/degraded/error) and overall system status. " +
      "Use this from heartbeat or cron to detect outages.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const result = await probeAllSidecars(ctx);
      return ok(result, { status: result.status });
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

        const result = await tavilySearch(ctx, query, { maxResults, searchDepth, includeAnswer: true });
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Backup tool
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_backup",
    label: "System Backup",
    description:
      "Trigger manual backup of PostgreSQL, agent memory, and WhatsApp auth to Google Drive. " +
      "Returns per-component results with Drive file links.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const backupConfig: BackupConfig = {
          dbUrl: ctx.databaseUrl || "",
          workspaceDir: "/data/openclaw-state/workspace",
          waUrl: ctx.whatsappSidecarUrl,
          sidecarAuthToken: ctx.sidecarAuthToken,
          account: ctx.backupAccount,
          retentionDays: ctx.backupRetentionDays,
        };
        if (!backupConfig.dbUrl) return err("DATABASE_URL not configured");

        const result = await runBackup(backupConfig, googleMcp);
        saveBackupStatus(result);
        return ok(result, { status: result.ok ? "complete" : "partial" });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Aggregation: summarize project
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_summarize_project",
    label: "Summarize Project",
    description:
      "Gather messages from Gmail, Telegram, and Drive for a project. Returns raw data for the agent to summarize.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "Project name or keyword" },
        from: { type: "string", description: "Start date (ISO 8601)" },
        to: { type: "string", description: "End date (ISO 8601)" },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["project"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      const project = (param(params, "project") as string) || "";
      const from = param(params, "from") as string | undefined;
      const to = param(params, "to") as string | undefined;
      const account = param(params, "account") as string | undefined;

      const gmailQuery = [project, from ? `after:${from}` : "", to ? `before:${to}` : ""].filter(Boolean).join(" ");
      const gmailArgs: Record<string, unknown> = { query: gmailQuery, max_results: 50 };
      if (account) gmailArgs.account = account;

      const driveQuery = `fullText contains '${project.replace(/'/g, "\\'")}'${from ? ` and modifiedTime > '${from.slice(0, 10)}T00:00:00'` : ""}`;
      const driveArgs: Record<string, unknown> = { query: driveQuery, max_results: 10 };
      if (account) driveArgs.account = account;

      const [gmailResult, telegramResult, driveResult] = await Promise.allSettled([
        ctx.requireGoogleMcp().call("query_gmail_emails", gmailArgs),
        queryMessages(ctx, project, { from, to, limit: 50 }),
        ctx.requireGoogleMcp().call("drive_search_files", driveArgs),
      ]);

      const data: { gmail?: unknown; telegram?: unknown; drive?: unknown } = {
        gmail: gmailResult.status === "fulfilled" ? gmailResult.value : { error: (gmailResult.reason as Error).message },
        telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { error: (telegramResult.reason as Error).message },
        drive: driveResult.status === "fulfilled" ? driveResult.value : { error: (driveResult.reason as Error).message },
      };

      return ok(data, { project });
    },
  });

  // -----------------------------------------------------------------------
  // Aggregation: weekly report
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_weekly_report",
    label: "Weekly Report",
    description:
      "Gather data from all sources (Gmail, Calendar, Telegram, Drive) for a weekly report. Returns raw data for the agent to format.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projects: {
          type: "array",
          items: { type: "string" },
          description: "Project names/keywords to include",
        },
        week_start: { type: "string", description: "Week start date (ISO 8601, default: last Monday)" },
        week_end: { type: "string", description: "Week end date (ISO 8601, default: this Sunday)" },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["projects"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      const projects = (param(params, "projects") as string[]) || [];
      const account = param(params, "account") as string | undefined;

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
        projects: Record<string, { gmail?: unknown; telegram?: unknown; drive?: unknown }>;
        calendar?: unknown;
      } = {
        period: { start: weekStart, end: weekEnd },
        projects: {},
      };

      for (const project of projects) {
        const gmailQuery = `${project} after:${weekStart.slice(0, 10)} before:${weekEnd.slice(0, 10)}`;
        const gmailArgs: Record<string, unknown> = { query: gmailQuery, max_results: 50 };
        if (account) gmailArgs.account = account;

        const driveQuery = `fullText contains '${project.replace(/'/g, "\\'")}' and modifiedTime > '${weekStart.slice(0, 10)}T00:00:00'`;
        const driveArgs: Record<string, unknown> = { query: driveQuery, max_results: 10 };
        if (account) driveArgs.account = account;

        const [gmailResult, telegramResult, driveResult] = await Promise.allSettled([
          ctx.requireGoogleMcp().call("query_gmail_emails", gmailArgs),
          queryMessages(ctx, project, { from: weekStart, to: weekEnd, limit: 50 }),
          ctx.requireGoogleMcp().call("drive_search_files", driveArgs),
        ]);

        report.projects[project] = {
          gmail: gmailResult.status === "fulfilled" ? gmailResult.value : { error: (gmailResult.reason as Error).message },
          telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { error: (telegramResult.reason as Error).message },
          drive: driveResult.status === "fulfilled" ? driveResult.value : { error: (driveResult.reason as Error).message },
        };
      }

      try {
        const calArgs: Record<string, unknown> = {
          calendar_id: "primary",
          time_min: weekStart,
          time_max: weekEnd,
          max_results: 50,
        };
        if (account) calArgs.account = account;
        report.calendar = await ctx.requireGoogleMcp().call("calendar_get_events", calArgs);
      } catch (e) {
        report.calendar = { error: (e as Error).message };
      }

      return ok(report, { projects });
    },
  });
}

// ---------------------------------------------------------------------------
// Periodic backup (called once from index.ts register())
// ---------------------------------------------------------------------------

export function startPeriodicBackup(ctx: PluginContext): void {
  const checkAndRunBackup = async () => {
    try {
      const lastMs = loadLastBackupTime();
      const elapsed = lastMs ? Date.now() - lastMs : Infinity;

      if (elapsed < BACKUP_MIN_INTERVAL_MS) {
        console.error(`[work-agent] backup: skipping, last backup ${Math.floor(elapsed / 3600000)}h ago`);
        return;
      }

      if (!ctx.databaseUrl) {
        console.error("[work-agent] backup: DATABASE_URL not set, skipping");
        return;
      }
      if (!ctx.googleMcp) {
        console.error("[work-agent] backup: Google MCP not configured, skipping");
        return;
      }

      console.error("[work-agent] backup: starting scheduled backup...");
      const backupConfig: BackupConfig = {
        dbUrl: ctx.databaseUrl,
        workspaceDir: "/data/openclaw-state/workspace",
        waUrl: ctx.whatsappSidecarUrl,
        sidecarAuthToken: ctx.sidecarAuthToken,
        account: ctx.backupAccount,
        retentionDays: ctx.backupRetentionDays,
      };

      const result = await runBackup(backupConfig, ctx.googleMcp);
      saveBackupStatus(result);

      if (!result.ok) {
        try {
          await slackApi("chat.postMessage", {
            channel: ctx.slackAlertChannel,
            text: `:warning: *Backup completed with errors*\n${result.errors.join("\n")}\n_${result.timestamp}_`,
          });
        } catch {}
      } else {
        try {
          const parts: string[] = [];
          for (const [key, step] of Object.entries({ pg: result.postgres, mem: result.memory, wa: result.whatsapp })) {
            if (step?.ok && step.size_bytes) {
              const kb = Math.round(step.size_bytes / 1024);
              parts.push(`${key}: ${kb} KB`);
            }
          }
          const cleaned = result.cleanup?.deleted ? `, cleaned ${result.cleanup.deleted} old` : "";
          await slackApi("chat.postMessage", {
            channel: ctx.slackAlertChannel,
            text: `:white_check_mark: *Backup OK* — ${parts.join(", ")}${cleaned}\n_${result.timestamp}_`,
          });
        } catch {}
      }

      console.error(`[work-agent] backup: done, ok=${result.ok}, errors=${result.errors.length}`);
    } catch (e) {
      console.error(`[work-agent] backup error: ${(e as Error).message}`);
      try {
        await slackApi("chat.postMessage", {
          channel: ctx.slackAlertChannel,
          text: `:x: *Backup failed*\n${(e as Error).message}\n_${new Date().toISOString()}_`,
        });
      } catch {}
    }
  };

  setTimeout(async () => {
    await checkAndRunBackup();
    setInterval(() => checkAndRunBackup(), BACKUP_CHECK_INTERVAL_MS);
  }, BACKUP_STARTUP_DELAY_MS);
}
