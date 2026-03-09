/**
 * analytics.ts — GA4, Tally.so, and Amplitude tool registrations.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { tallyGet } from "./clients.js";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerAnalyticsTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  // -----------------------------------------------------------------------
  // Google Analytics (GA4)
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_analytics_properties",
    label: "GA4 Properties",
    description:
      "List Google Analytics 4 properties accessible to a connected Google account. " +
      "Returns property IDs needed for work_analytics_report. " +
      "When account is empty, lists properties from ALL connected accounts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Gmail account email (optional — empty = all accounts)",
        },
      },
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const args: Record<string, unknown> = {};
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("analytics_list_properties", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_analytics_report",
    label: "GA4 Report",
    description:
      "Run a Google Analytics 4 report. Use work_analytics_properties first to get property IDs. " +
      "Common metrics: activeUsers, sessions, screenPageViews, conversions, totalRevenue. " +
      "Google Ads metrics (requires GA4↔Ads link): advertiserAdClicks, advertiserAdCost, advertiserAdCostPerClick, advertiserAdImpressions. " +
      "Common dimensions: date, country, city, pagePath, sessionSource, deviceCategory. " +
      "Google Ads dimensions: sessionGoogleAdsCampaignName, sessionGoogleAdsAdGroupName, sessionGoogleAdsKeyword, sessionGoogleAdsAdNetworkType.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        property_id: {
          type: "string",
          description: "GA4 property ID (numeric, e.g. \"123456789\")",
        },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "List of metric names (e.g. [\"activeUsers\", \"sessions\"])",
        },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "List of dimension names (optional, e.g. [\"date\", \"country\"])",
        },
        start_date: {
          type: "string",
          description: "Start date — YYYY-MM-DD or relative: \"today\", \"yesterday\", \"7daysAgo\", \"30daysAgo\" (default: \"30daysAgo\")",
        },
        end_date: {
          type: "string",
          description: "End date — YYYY-MM-DD or relative (default: \"today\")",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100)",
        },
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
      },
      required: ["property_id", "metrics"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const propertyId = param(params, "property_id") as string;
        const metrics = param(params, "metrics") as string[];
        if (!propertyId) return err("property_id is required");
        if (!metrics || !metrics.length) return err("metrics is required (array of metric names)");
        const args: Record<string, unknown> = {
          property_id: propertyId,
          metrics,
        };
        const dimensions = param(params, "dimensions") as string[] | undefined;
        if (dimensions?.length) args.dimensions = dimensions;
        const startDate = param(params, "start_date") as string | undefined;
        if (startDate) args.start_date = startDate;
        const endDate = param(params, "end_date") as string | undefined;
        if (endDate) args.end_date = endDate;
        const limit = param(params, "limit") as number | undefined;
        if (limit) args.limit = limit;
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("analytics_run_report", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tally.so
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_tally_forms",
    label: "Tally Forms",
    description:
      "List all Tally forms with submission counts and status. " +
      "Use this to discover form IDs for work_tally_submissions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "number",
          description: "Max forms to return (default 50, max 500)",
        },
        page: {
          type: "number",
          description: "Page number (default 1)",
        },
      },
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const limit = Math.min((param(params, "limit") as number) || 50, 500);
        const page = (param(params, "page") as number) || 1;
        const result = await tallyGet(ctx, "/forms", { limit, page });
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_tally_submissions",
    label: "Tally Submissions",
    description:
      "Get submissions (responses) for a Tally form. Returns questions with field definitions and all answers. " +
      "Use work_tally_forms first to get form IDs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        form_id: {
          type: "string",
          description: "Tally form ID (from work_tally_forms)",
        },
        filter: {
          type: "string",
          description: "Filter: 'all', 'completed', or 'partial' (default: 'completed')",
        },
        start_date: {
          type: "string",
          description: "Start date filter (ISO 8601, e.g. '2026-03-01T00:00:00Z')",
        },
        end_date: {
          type: "string",
          description: "End date filter (ISO 8601)",
        },
        limit: {
          type: "number",
          description: "Max submissions to return (default 50, max 500)",
        },
        page: {
          type: "number",
          description: "Page number (default 1)",
        },
      },
      required: ["form_id"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const formId = param(params, "form_id") as string;
        if (!formId) return err("form_id is required");

        const queryParams: Record<string, string | number> = {};
        const filter = param(params, "filter") as string | undefined;
        if (filter) queryParams.filter = filter;
        const startDate = param(params, "start_date") as string | undefined;
        if (startDate) queryParams.startDate = startDate;
        const endDate = param(params, "end_date") as string | undefined;
        if (endDate) queryParams.endDate = endDate;
        const limit = param(params, "limit") as number | undefined;
        if (limit) queryParams.limit = Math.min(limit, 500);
        const page = param(params, "page") as number | undefined;
        if (page) queryParams.page = page;

        const result = await tallyGet(ctx, `/forms/${formId}/submissions`, queryParams);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  // -----------------------------------------------------------------------
  // Amplitude (official MCP server)
  // -----------------------------------------------------------------------

  api.registerTool({
    name: "work_amplitude_tools",
    label: "Amplitude Tools",
    description:
      "List all available Amplitude MCP tools. Use this first to discover what analytics " +
      "queries, charts, dashboards, and data operations are available. Returns tool names, " +
      "descriptions, and their parameter schemas.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const amplitudeMcp = ctx.requireAmplitudeMcp();
        const result = await amplitudeMcp.listTools();
        return ok(result.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_amplitude_call",
    label: "Amplitude Call",
    description:
      "Call any Amplitude MCP tool by name. Use work_amplitude_tools first to discover " +
      "available tools and their parameters. This is a passthrough to the official " +
      "Amplitude MCP server.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool: {
          type: "string",
          description: "Name of the Amplitude MCP tool to call (from work_amplitude_tools)",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool (see tool's parameter schema)",
        },
      },
      required: ["tool"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const amplitudeMcp = ctx.requireAmplitudeMcp();
        const toolName = param(params, "tool") as string;
        if (!toolName) return err("tool name is required");
        const toolArgs = (param(params, "args") as Record<string, unknown>) || {};
        const result = await amplitudeMcp.call(toolName, toolArgs);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
