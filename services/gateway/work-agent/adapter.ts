/**
 * adapter.ts — thin abstraction over OpenClaw Plugin SDK internals.
 *
 * Isolates SDK coupling so that OpenClaw version upgrades only require
 * changes here, not across the entire plugin codebase.
 *
 * Everything that "knows" how OpenClaw calls plugins lives here:
 *   - execute() argument layout (toolUseId, params, context, callback)
 *   - camelCase parameter conversion quirk
 *   - plugin config access (.pluginConfig / .config)
 *   - internal module loading (cost/usage)
 *   - response format ({ content: [...], details: {...} })
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkAgentConfig {
  mcpServerUrl?: string;
  amplitudeMcpUrl?: string;
  telegramSidecarUrl?: string;
  tavilyApiKey?: string;
  sidecarAuthToken?: string;
  amplitudeOAuthClientId?: string;
  amplitudeOAuthAccessToken?: string;
  amplitudeOAuthRefreshToken?: string;
  databaseUrl?: string;
  whatsappSidecarUrl?: string;
}

export interface ToolContext {
  channel?: string;
  channelId?: string;
  channelName?: string;
  channelType?: string;
  source?: string;
  userId?: string;
  userName?: string;
  threadId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 1. Plugin config — replaces unsafe `(api as unknown as {...}).config`
// ---------------------------------------------------------------------------

export function getPluginConfig(api: OpenClawPluginApi): WorkAgentConfig {
  // Prefer the documented SDK property; fall back to the legacy cast.
  const raw: Record<string, string> =
    (api as unknown as { pluginConfig?: Record<string, string> }).pluginConfig ??
    (api as unknown as { config?: Record<string, string> }).config ??
    {};

  return {
    mcpServerUrl: raw.mcpServerUrl || process.env.GOOGLE_MCP_URL,
    amplitudeMcpUrl: raw.amplitudeMcpUrl || process.env.AMPLITUDE_MCP_URL || "https://mcp.amplitude.com",
    telegramSidecarUrl: raw.telegramSidecarUrl || process.env.TELEGRAM_SIDECAR_URL,
    tavilyApiKey: raw.tavilyApiKey || process.env.TAVILY_API_KEY,
    sidecarAuthToken: raw.sidecarAuthToken || process.env.SIDECAR_AUTH_TOKEN,
    amplitudeOAuthClientId: raw.amplitudeOAuthClientId || process.env.AMPLITUDE_OAUTH_CLIENT_ID,
    amplitudeOAuthAccessToken: raw.amplitudeOAuthAccessToken || process.env.AMPLITUDE_OAUTH_ACCESS_TOKEN,
    amplitudeOAuthRefreshToken: raw.amplitudeOAuthRefreshToken || process.env.AMPLITUDE_OAUTH_REFRESH_TOKEN,
    databaseUrl: raw.databaseUrl || process.env.DATABASE_URL,
    whatsappSidecarUrl: raw.whatsappSidecarUrl || process.env.WHATSAPP_SIDECAR_URL,
  };
}

// ---------------------------------------------------------------------------
// 2. Context extraction — replaces `rawArgs[2] as Record<string, unknown>`
// ---------------------------------------------------------------------------

export function extractContext(rawArgs: unknown[]): ToolContext | undefined {
  // OpenClaw calls execute(toolUseId, params, context, callback).
  // Context is at index 2 when arg0 is a string (toolUseId).
  if (typeof rawArgs[0] === "string" && rawArgs.length > 2) {
    const ctx = rawArgs[2];
    if (ctx && typeof ctx === "object") return ctx as ToolContext;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. Internal module loader — replaces require.resolve + path manipulation
// ---------------------------------------------------------------------------

type CostUsageFn = (opts: { days: number }) => Promise<{
  totals: Record<string, unknown>;
  daily: Record<string, unknown>[];
}>;

export async function loadCostUsageSummaryFn(): Promise<CostUsageFn | null> {
  try {
    const openclawMain = require.resolve("openclaw");
    const modulePath = openclawMain.replace(
      /dist[/\\]index\.(js|ts)$/,
      "dist/plugin-sdk/infra/session-cost-usage.js",
    );
    const mod = await import(modulePath);
    if (typeof mod.loadCostUsageSummary === "function") {
      return mod.loadCostUsageSummary as CostUsageFn;
    }
    console.error("[adapter] loadCostUsageSummary not found in module");
    return null;
  } catch (e) {
    console.error("[adapter] Failed to load cost/usage module:", (e as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Param extraction — unpacks execute() call convention
// ---------------------------------------------------------------------------

/**
 * Extract the params object from execute() arguments.
 * OpenClaw calls execute(toolUseId, params, context, callback) — 4 args.
 * This helper safely extracts the params object regardless of call convention.
 */
export function extractParams(rawArgs: unknown[]): Record<string, unknown> {
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
export function param(params: Record<string, unknown>, snakeName: string): unknown {
  if (params[snakeName] !== undefined) return params[snakeName];
  const camelName = snakeName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camelName !== snakeName && params[camelName] !== undefined) return params[camelName];
  return undefined;
}

// ---------------------------------------------------------------------------
// 5. Response builders — OpenClaw plugin response format
// ---------------------------------------------------------------------------

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function ok(data: unknown, details: Record<string, unknown> = {}): ToolResponse {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
    details: { ok: true, ...details },
  };
}

export function err(message: string): ToolResponse {
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
