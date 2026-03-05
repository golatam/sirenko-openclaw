import { fetchWithTimeout, MCP_TIMEOUT_MS } from "./utils.js";

// ---------------------------------------------------------------------------
// MCP client — lightweight JSON-RPC 2.0 over HTTP (Node.js 22 native fetch)
// Supports multiple independent MCP server connections via class instances.
// ---------------------------------------------------------------------------

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

export class McpClient {
  private name: string;
  private url: string;
  private sessionId?: string;
  private initPromise?: Promise<void>;
  private authToken?: string;

  constructor(name: string, url: string, authToken?: string) {
    this.name = name;
    this.url = url;
    this.authToken = authToken;
  }

  getUrl(): string {
    return this.url;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.authToken) h["X-Internal-Token"] = this.authToken;
    return h;
  }

  private async init(): Promise<void> {
    const res = await fetchWithTimeout(`${this.url}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: `work-agent-${this.name}`, version: "1.0.0" },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`MCP[${this.name}] init HTTP ${res.status}: ${await res.text()}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    // Read body to completion (may be JSON or SSE)
    await parseMcpBody(res);
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    if (!this.initPromise) {
      this.initPromise = this.init()
        .then(() => {
          console.error(`[work-agent] MCP[${this.name}] session initialized, sessionId: ${this.sessionId}`);
        })
        .catch((e) => {
          console.error(`[work-agent] MCP[${this.name}] init failed: ${(e as Error).message}`);
          this.initPromise = undefined;
          throw e;
        });
    }
    await this.initPromise;
  }

  async call(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureSession();

    const doCall = async (): Promise<Response> => {
      const hdrs = this.headers();
      if (this.sessionId) hdrs["Mcp-Session-Id"] = this.sessionId;
      return fetchWithTimeout(`${this.url}/mcp`, {
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
        console.error(`[work-agent] MCP[${this.name}] session expired (${res.status}), re-initializing...`);
        this.sessionId = undefined;
        this.initPromise = undefined;
        await this.ensureSession();
        res = await doCall();
        if (!res.ok) {
          throw new Error(`MCP[${this.name}] HTTP ${res.status}: ${await res.text()}`);
        }
      } else {
        throw new Error(`MCP[${this.name}] HTTP ${res.status}: ${await res.text()}`);
      }
    }
    const json = await parseMcpBody(res);
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }
}
