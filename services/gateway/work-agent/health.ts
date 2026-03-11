/**
 * health.ts — Health monitoring: probing sidecars, formatting alerts,
 * state persistence, and periodic check scheduling.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { slackApi } from "./clients.js";
import type { PluginContext } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthResult {
  status: string;
  components: Record<string, unknown>;
}

type AlertKind = "post-deploy" | "alert" | "recovery";

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export async function probeAllSidecars(ctx: PluginContext): Promise<HealthResult> {
  const components: Record<string, unknown> = {};
  let overall = "ok";

  const setWorst = (status: string) => {
    if (status === "error") overall = "error";
    else if (status === "degraded" && overall !== "error") overall = "degraded";
  };

  const probeHealth = async (url: string, name: string) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${url}/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        components[name] = { status: "error", detail: `HTTP ${res.status}` };
        setWorst("error");
        return;
      }
      const data = (await res.json()) as Record<string, unknown>;
      components[name] = data;
      setWorst((data.status as string) || "ok");
    } catch (e) {
      components[name] = { status: "error", detail: (e as Error).message };
      setWorst("error");
    }
  };

  const probes: Promise<void>[] = [];

  if (ctx.googleMcp) {
    probes.push(probeHealth(ctx.googleMcp.getUrl(), "google_mcp_sidecar"));
  } else {
    components.google_mcp_sidecar = { status: "error", detail: "not configured" };
    setWorst("error");
  }

  if (ctx.tgSidecarUrl) {
    probes.push(probeHealth(ctx.tgSidecarUrl, "telegram_sidecar"));
  } else {
    components.telegram_sidecar = { status: "error", detail: "not configured" };
    setWorst("error");
  }

  if (ctx.whatsappSidecarUrl) {
    probes.push(probeHealth(ctx.whatsappSidecarUrl, "whatsapp_sidecar"));
  } else {
    components.whatsapp_sidecar = { status: "degraded", detail: "URL not configured (optional)" };
  }

  if (ctx.amplitudeMcp) {
    probes.push((async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const result = await ctx.requireAmplitudeMcp().listTools();
          components.amplitude_mcp = { status: "ok", tools_count: result.tools?.length ?? 0 };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        components.amplitude_mcp = { status: "error", detail: (e as Error).message };
        setWorst("error");
      }
    })());
  } else {
    components.amplitude_mcp = { status: "degraded", detail: "not configured (optional)" };
  }

  await Promise.allSettled(probes);

  return { status: overall, components };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHealthMessage(result: HealthResult, kind: AlertKind, persistent = false): string {
  const headers: Record<AlertKind, string> = {
    "post-deploy": ":rocket: *Post-Deploy Health Check*",
    "alert": result.status === "error" ? ":red_circle: *System Health Alert*" : ":warning: *System Health Alert*",
    "recovery": ":white_check_mark: *System Recovered*",
  };
  const header = persistent ? `${headers[kind]} (persistent)` : headers[kind];
  const lines = [header, `Status: *${result.status}*`, ""];

  for (const [name, raw] of Object.entries(result.components)) {
    const comp = raw as Record<string, unknown>;
    const label = name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const checks = comp.checks as Record<string, Record<string, unknown>> | undefined;
    const statusIcon = comp.status === "ok" ? ":white_check_mark:" : comp.status === "degraded" ? ":warning:" : ":x:";
    let detail = "";

    if (checks?.accounts) {
      const accts = checks.accounts;
      const list = accts.accounts as Array<Record<string, string>> | undefined;
      if (list) {
        detail = list.map(a => `${a.status === "connected" ? "\u2713" : "\u2717"} ${a.account}`).join(", ");
      } else if (accts.connected !== undefined) {
        detail = `${accts.connected}/${accts.total} connected`;
      }
      if (accts.detail || accts.details) detail += ` (${accts.detail || accts.details})`;
    } else if (comp.detail) {
      detail = String(comp.detail);
    }
    if (checks?.whatsapp) {
      const wa = checks.whatsapp;
      detail = `${wa.account || ""}`;
      if (wa.detail) detail += ` (${wa.detail})`;
    }

    lines.push(`${statusIcon} *${label}:* ${comp.status}${detail ? " — " + detail : ""}`);
    if (comp.uptime_seconds !== undefined) {
      lines.push(`    uptime: ${Math.floor(Number(comp.uptime_seconds) / 60)}m`);
    }
  }

  lines.push("", `_${new Date().toISOString()}_`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

const HEALTH_STATE_FILE = "/data/openclaw-state/health-status.json";
const REPEAT_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-alert every 6h while in error

interface HealthState {
  status: string;
  updatedAt: string;
  lastAlertAt?: string;
}

function loadHealthState(): HealthState | null {
  try {
    return JSON.parse(readFileSync(HEALTH_STATE_FILE, "utf-8")) as HealthState;
  } catch {
    return null;
  }
}

function saveHealthState(status: string, lastAlertAt?: string): void {
  try {
    mkdirSync(dirname(HEALTH_STATE_FILE), { recursive: true });
    const prev = loadHealthState();
    const state: HealthState = {
      status,
      updatedAt: new Date().toISOString(),
      lastAlertAt: lastAlertAt ?? prev?.lastAlertAt,
    };
    writeFileSync(HEALTH_STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.error(`[work-agent] failed to save health status: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function sendHealthNotification(ctx: PluginContext, result: HealthResult, kind: AlertKind, persistent = false): Promise<void> {
  try {
    const text = formatHealthMessage(result, kind, persistent);
    await slackApi("chat.postMessage", { channel: ctx.slackAlertChannel, text });
  } catch (e) {
    console.error(`[work-agent] health notification failed: ${(e as Error).message}`);
  }
}

async function runPeriodicHealthCheck(ctx: PluginContext): Promise<void> {
  const result = await probeAllSidecars(ctx);
  const state = loadHealthState();
  const prev = state?.status ?? null;

  let shouldAlert = false;
  let isPersistent = false;
  let alertKind: AlertKind = "alert";

  if (prev === null) {
    // First check ever
    shouldAlert = result.status !== "ok";
  } else if (prev !== "ok" && result.status === "ok") {
    // Recovery
    shouldAlert = true;
    alertKind = "recovery";
  } else if (prev === "ok" && result.status !== "ok") {
    // New failure
    shouldAlert = true;
  } else if (prev !== "ok" && result.status !== "ok") {
    // Persistent error — repeat alert every REPEAT_ALERT_INTERVAL_MS
    const lastAlert = state?.lastAlertAt ? new Date(state.lastAlertAt).getTime() : 0;
    const elapsed = Date.now() - lastAlert;
    if (elapsed >= REPEAT_ALERT_INTERVAL_MS) {
      shouldAlert = true;
      isPersistent = true;
    }
  }

  if (shouldAlert) {
    await sendHealthNotification(ctx, result, alertKind, isPersistent);
    saveHealthState(result.status, new Date().toISOString());
    console.error(`[work-agent] periodic health: ${result.status} (prev: ${prev || "none"}) — ${alertKind} sent`);
  } else {
    saveHealthState(result.status);
    console.error(`[work-agent] periodic health: ${result.status} (prev: ${prev || "none"})`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle — start monitoring (called once from index.ts register())
// ---------------------------------------------------------------------------

const STARTUP_HEALTH_DELAY_MS = 3 * 60 * 1000;
const PERIODIC_HEALTH_INTERVAL_MS = 30 * 60 * 1000;

export function startHealthMonitoring(ctx: PluginContext): void {
  setTimeout(async () => {
    try {
      const result = await probeAllSidecars(ctx);
      await sendHealthNotification(ctx, result, "post-deploy");
      saveHealthState(result.status, new Date().toISOString());
      console.error(`[work-agent] post-deploy health: ${result.status}`);
    } catch (e) {
      console.error(`[work-agent] post-deploy health check failed: ${(e as Error).message}`);
    }

    setInterval(async () => {
      try {
        await runPeriodicHealthCheck(ctx);
      } catch (e) {
        console.error(`[work-agent] periodic health check error: ${(e as Error).message}`);
      }
    }, PERIODIC_HEALTH_INTERVAL_MS);
  }, STARTUP_HEALTH_DELAY_MS);
}
