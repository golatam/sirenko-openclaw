/**
 * clients.ts — Shared HTTP clients used by multiple domain modules.
 *
 * Each function takes a PluginContext (or specific fields) so there's
 * no module-level mutable state.
 */

import { fetchWithTimeout } from "./utils.js";
import type { PluginContext } from "./types.js";

// ---------------------------------------------------------------------------
// Tavily web search
// ---------------------------------------------------------------------------

export async function tavilySearch(
  ctx: PluginContext,
  query: string,
  opts: { maxResults?: number; searchDepth?: string; includeAnswer?: boolean } = {},
): Promise<unknown> {
  if (!ctx.tavilyApiKey) throw new Error("TAVILY_API_KEY is not configured");

  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: ctx.tavilyApiKey,
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
// Tally.so REST API
// ---------------------------------------------------------------------------

const TALLY_BASE = "https://api.tally.so";

export async function tallyGet(
  ctx: PluginContext,
  path: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  if (!ctx.tallyApiKey) throw new Error("TALLY_API_KEY is not configured");

  const url = new URL(path, TALLY_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetchWithTimeout(url.toString(), {
    headers: { Authorization: `Bearer ${ctx.tallyApiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Tally HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Telegram/WhatsApp message search (via telegram-sidecar)
// ---------------------------------------------------------------------------

export async function queryMessages(
  ctx: PluginContext,
  query: string,
  opts: { source?: string; from?: string; to?: string; limit?: number; chatType?: string; sender?: string } = {},
): Promise<{ rows: unknown[]; total: number; source: string }> {
  if (!ctx.tgSidecarUrl) return { rows: [], total: 0, source: "messaging (sidecar not configured)" };

  const body: Record<string, unknown> = { query };
  if (opts.source) body.source = opts.source;
  if (opts.from) body.from = opts.from;
  if (opts.to) body.to = opts.to;
  if (opts.limit) body.limit = opts.limit;
  if (opts.chatType) body.chat_type = opts.chatType;
  if (opts.sender) body.sender = opts.sender;

  console.error(`[work-agent] queryMessages: ${ctx.tgSidecarUrl}/search source=${opts.source || "all"}`);
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  if (ctx.sidecarAuthToken) hdrs["X-Internal-Token"] = ctx.sidecarAuthToken;
  const res = await fetchWithTimeout(`${ctx.tgSidecarUrl}/search`, {
    method: "POST",
    headers: hdrs,
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
// Slack Web API
// ---------------------------------------------------------------------------

export async function slackApi(method: string, body: Record<string, unknown>) {
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
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}
