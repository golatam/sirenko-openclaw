/**
 * index.ts — Work Agent plugin entry point.
 *
 * Thin orchestrator: initializes config, creates PluginContext, and
 * delegates tool registration to domain modules. All tool logic lives
 * in the domain files (gmail.ts, calendar.ts, etc.).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { McpClient, OAuthBearerProvider } from "./mcp-client.js";
import { getPluginConfig } from "./adapter.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { PluginContext } from "./types.js";

// Domain modules
import { registerGmailTools } from "./gmail.js";
import { registerCalendarTools } from "./calendar.js";
import { registerDriveTools } from "./drive.js";
import { registerSheetsTools } from "./sheets.js";
import { registerDocsTools } from "./docs.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerSlackTools } from "./slack.js";
import { registerOpsTools, startPeriodicBackup } from "./ops.js";
import { startHealthMonitoring } from "./health.js";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const WorkAgentPlugin = {
  id: "work-agent",
  name: "Work Agent",
  description: "Unified search across Gmail/Calendar/Drive/Telegram/WhatsApp — plus send, schedule, report, interactive UI.",
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
      telegramSidecarUrl: {
        type: "string",
        description:
          "URL of telegram-sidecar HTTP API (e.g. http://telegram-sidecar.railway.internal:8000)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = getPluginConfig(api);

    // -----------------------------------------------------------------------
    // Initialize MCP clients
    // -----------------------------------------------------------------------

    let googleMcp: McpClient | undefined;
    if (config.mcpServerUrl) {
      googleMcp = new McpClient("google", config.mcpServerUrl, config.sidecarAuthToken);
    }

    let amplitudeMcp: McpClient | undefined;
    const ampOAuthStateFile = "/data/openclaw-state/amplitude-oauth.json";
    if (config.amplitudeOAuthRefreshToken && config.amplitudeOAuthClientId) {
      let accessToken = config.amplitudeOAuthAccessToken || "";
      let refreshToken = config.amplitudeOAuthRefreshToken;
      try {
        const state = JSON.parse(readFileSync(ampOAuthStateFile, "utf-8"));
        if (state.accessToken) accessToken = state.accessToken;
        if (state.refreshToken) refreshToken = state.refreshToken;
      } catch {
        // no state file yet — use env vars
      }

      const ampUrl = (config.amplitudeMcpUrl || "https://mcp.amplitude.com") + "/mcp";
      const oauthProvider = new OAuthBearerProvider({
        accessToken,
        refreshToken,
        clientId: config.amplitudeOAuthClientId,
        tokenEndpoint: "https://mcp.amplitude.com/token",
        onTokenRefreshed: (newAccessToken: string, newRefreshToken: string) => {
          try {
            mkdirSync(dirname(ampOAuthStateFile), { recursive: true });
            writeFileSync(ampOAuthStateFile, JSON.stringify({
              accessToken: newAccessToken,
              refreshToken: newRefreshToken,
              updatedAt: new Date().toISOString(),
            }));
          } catch (e) {
            console.error(`[work-agent] failed to persist amplitude token: ${(e as Error).message}`);
          }
        },
      });
      amplitudeMcp = new McpClient("amplitude", ampUrl, oauthProvider);
      console.error("[work-agent] Amplitude: OAuth (official MCP server)");
    } else if (config.amplitudeMcpUrl && !config.amplitudeMcpUrl.includes("mcp.amplitude.com") && config.sidecarAuthToken) {
      amplitudeMcp = new McpClient("amplitude", config.amplitudeMcpUrl, config.sidecarAuthToken);
      console.error("[work-agent] Amplitude: legacy sidecar auth");
    }

    console.error(`[work-agent] googleMcp=${config.mcpServerUrl} amplitudeMcp=${amplitudeMcp ? "configured" : "not set"} tgSidecarUrl=${config.telegramSidecarUrl} tavily=${config.tavilyApiKey ? "configured" : "not set"} tally=${config.tallyApiKey ? "configured" : "not set"} sidecarAuth=${config.sidecarAuthToken ? "configured" : "not set"} dbUrl=${config.databaseUrl ? "configured" : "not set"} waUrl=${config.whatsappSidecarUrl ? "configured" : "not set"}`);

    // -----------------------------------------------------------------------
    // Build PluginContext — shared dependency container for all modules
    // -----------------------------------------------------------------------

    const ctx: PluginContext = {
      googleMcp,
      amplitudeMcp,
      tgSidecarUrl: config.telegramSidecarUrl,
      tavilyApiKey: config.tavilyApiKey,
      sidecarAuthToken: config.sidecarAuthToken,
      databaseUrl: config.databaseUrl,
      whatsappSidecarUrl: config.whatsappSidecarUrl,
      tallyApiKey: config.tallyApiKey,
      slackAlertChannel: config.slackAlertChannel || "U0AH7S5AG91",
      backupAccount: config.backupAccount || "kirill@sirenko.ru",
      backupRetentionDays: config.backupRetentionDays || 14,

      requireGoogleMcp() {
        if (!googleMcp) throw new Error("Google MCP sidecar is not configured (mcpServerUrl missing)");
        return googleMcp;
      },
      requireAmplitudeMcp() {
        if (!amplitudeMcp) throw new Error("Amplitude MCP is not configured (OAuth credentials missing)");
        return amplitudeMcp;
      },
    };

    // -----------------------------------------------------------------------
    // Register all domain tools
    // -----------------------------------------------------------------------

    registerGmailTools(api, ctx);
    registerCalendarTools(api, ctx);
    registerDriveTools(api, ctx);
    registerSheetsTools(api, ctx);
    registerDocsTools(api, ctx);
    registerAnalyticsTools(api, ctx);
    registerSlackTools(api, ctx);
    registerOpsTools(api, ctx);

    // -----------------------------------------------------------------------
    // Start background tasks
    // -----------------------------------------------------------------------

    startHealthMonitoring(ctx);
    startPeriodicBackup(ctx);
  },
};

export default WorkAgentPlugin;
