import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MCP_TIMEOUT_MS = 30_000;
export const FETCH_MAX_RETRIES = 3;
export const FETCH_RETRY_BASE_MS = 1_000; // 1s, 2s, 4s

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = MCP_TIMEOUT_MS): Promise<Response> {
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

// ---------------------------------------------------------------------------
// OpenClaw SDK helpers
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
// Response builders
// ---------------------------------------------------------------------------

export function ok(data: unknown, details: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
    details: { ok: true, ...details },
  };
}

export function err(message: string) {
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
// Confirmation
// ---------------------------------------------------------------------------

/** Deterministic 12-char hex hash from a payload (sorted-key canonical JSON). */
export function confirmationId(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}
