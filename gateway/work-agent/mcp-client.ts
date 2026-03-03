import { fetchWithTimeout, sleep, MCP_TIMEOUT_MS } from "./utils.js";

// ---------------------------------------------------------------------------
// MCP client — lightweight JSON-RPC 2.0 over HTTP (Node.js 22 native fetch)
// ---------------------------------------------------------------------------

let _mcpUrl: string | undefined;
let _mcpSessionId: string | undefined;
let _mcpInitPromise: Promise<void> | undefined;

/** Set the MCP server URL. Must be called before any mcpCall(). */
export function configureMcp(url: string): void {
  _mcpUrl = url;
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

export async function mcpCall(toolName: string, args: Record<string, unknown> = {}) {
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
