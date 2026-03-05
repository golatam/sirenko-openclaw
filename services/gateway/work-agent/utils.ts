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
// Confirmation
// ---------------------------------------------------------------------------

/** Deterministic 12-char hex hash from a payload (sorted-key canonical JSON). */
export function confirmationId(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}
