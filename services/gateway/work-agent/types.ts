/**
 * types.ts — Shared types for the work-agent plugin modules.
 *
 * PluginContext is the dependency-injection container passed to every
 * domain module's register function, replacing module-level globals.
 */

import type { McpClient } from "./mcp-client.js";

export interface PluginContext {
  googleMcp?: McpClient;
  amplitudeMcp?: McpClient;
  tgSidecarUrl?: string;
  tavilyApiKey?: string;
  sidecarAuthToken?: string;
  databaseUrl?: string;
  whatsappSidecarUrl?: string;
  tallyApiKey?: string;
  slackAlertChannel: string;
  backupAccount: string;
  backupRetentionDays: number;

  /** Throws with a descriptive error if Google MCP is not configured. */
  requireGoogleMcp(): McpClient;
  /** Throws with a descriptive error if Amplitude MCP is not configured. */
  requireAmplitudeMcp(): McpClient;
}
