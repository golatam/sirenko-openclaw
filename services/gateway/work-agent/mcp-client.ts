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

// ---------------------------------------------------------------------------
// Auth providers
// ---------------------------------------------------------------------------

export interface McpAuthProvider {
  /** Return auth headers for requests. */
  headers(): Record<string, string>;
  /** Called on 401 — refresh credentials. Return true if refreshed and call should retry. */
  onUnauthorized?(): Promise<boolean>;
}

/** Internal sidecar auth — X-Internal-Token header. */
export class InternalAuthProvider implements McpAuthProvider {
  constructor(private token: string) {}

  headers(): Record<string, string> {
    return { "X-Internal-Token": this.token };
  }
}

/** OAuth Bearer token auth with auto-refresh on 401. */
export interface OAuthBearerOpts {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  tokenEndpoint: string;
  /** Called after a successful token refresh — persist new tokens. */
  onTokenRefreshed?: (newAccessToken: string, newRefreshToken: string) => void;
}

export class OAuthBearerProvider implements McpAuthProvider {
  private accessToken: string;
  private refreshToken: string;
  private clientId: string;
  private tokenEndpoint: string;
  private onTokenRefreshed?: (newAccessToken: string, newRefreshToken: string) => void;
  private refreshPromise?: Promise<boolean>;

  constructor(opts: OAuthBearerOpts) {
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken;
    this.clientId = opts.clientId;
    this.tokenEndpoint = opts.tokenEndpoint;
    this.onTokenRefreshed = opts.onTokenRefreshed;
  }

  headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async onUnauthorized(): Promise<boolean> {
    // Mutex: deduplicate concurrent refresh attempts
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      console.error(`[mcp-client] OAuth refresh: POST ${this.tokenEndpoint}`);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: this.refreshToken,
      });
      const res = await fetchWithTimeout(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!res.ok) {
        console.error(`[mcp-client] OAuth refresh failed: HTTP ${res.status}`);
        return false;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const newToken = data.access_token as string | undefined;
      if (!newToken) {
        console.error("[mcp-client] OAuth refresh: no access_token in response");
        return false;
      }
      this.accessToken = newToken;
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token as string;
      }
      console.error("[mcp-client] OAuth refresh: success, new access_token obtained");
      this.onTokenRefreshed?.(this.accessToken, this.refreshToken);
      return true;
    } catch (e) {
      console.error(`[mcp-client] OAuth refresh error: ${(e as Error).message}`);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  private name: string;
  private url: string;
  private sessionId?: string;
  private initPromise?: Promise<void>;
  private auth?: McpAuthProvider;

  /**
   * @param name — label for logging
   * @param url — base URL of the MCP server
   * @param auth — string (legacy X-Internal-Token) or McpAuthProvider
   */
  constructor(name: string, url: string, auth?: string | McpAuthProvider) {
    this.name = name;
    this.url = url;
    if (typeof auth === "string") {
      this.auth = new InternalAuthProvider(auth);
    } else {
      this.auth = auth;
    }
  }

  getUrl(): string {
    return this.url;
  }

  private requestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.auth) Object.assign(h, this.auth.headers());
    return h;
  }

  private mcpEndpoint(): string {
    // Official MCP servers use the URL as-is (e.g. https://mcp.amplitude.com/mcp)
    // Our sidecars append /mcp to the base URL
    const u = this.url;
    return u.endsWith("/mcp") ? u : `${u}/mcp`;
  }

  private async init(): Promise<void> {
    const doInit = async (): Promise<Response> =>
      fetchWithTimeout(this.mcpEndpoint(), {
        method: "POST",
        headers: this.requestHeaders(),
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

    let res = await doInit();

    // Handle 401 during init — refresh token and retry
    if (res.status === 401 && this.auth?.onUnauthorized) {
      console.error(`[mcp-client] MCP[${this.name}] init got 401, attempting token refresh...`);
      const refreshed = await this.auth.onUnauthorized();
      if (refreshed) {
        res = await doInit();
      }
    }

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

  /** Send a JSON-RPC request and handle session/auth errors. */
  private async jsonRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();

    const doRequest = async (): Promise<Response> => {
      const hdrs = this.requestHeaders();
      if (this.sessionId) hdrs["Mcp-Session-Id"] = this.sessionId;
      return fetchWithTimeout(this.mcpEndpoint(), {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      });
    };

    let res = await doRequest();

    // Handle 401 — try OAuth refresh + retry
    if (res.status === 401 && this.auth?.onUnauthorized) {
      console.error(`[work-agent] MCP[${this.name}] 401, attempting token refresh...`);
      const refreshed = await this.auth.onUnauthorized();
      if (refreshed) {
        // Reset session — new token may need new session
        this.sessionId = undefined;
        this.initPromise = undefined;
        await this.ensureSession();
        res = await doRequest();
      }
    }

    if (!res.ok) {
      // Session expired — reset and retry once
      if (res.status === 404 || res.status === 400) {
        console.error(`[work-agent] MCP[${this.name}] session expired (${res.status}), re-initializing...`);
        this.sessionId = undefined;
        this.initPromise = undefined;
        await this.ensureSession();
        res = await doRequest();
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

  /** Call a tool on the MCP server. */
  async call(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.jsonRpc("tools/call", { name: toolName, arguments: args });
  }

  /** List available tools on the MCP server. */
  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }> {
    const result = await this.jsonRpc("tools/list", {});
    return result as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };
  }
}
