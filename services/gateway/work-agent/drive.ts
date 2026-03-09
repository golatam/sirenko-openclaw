/**
 * drive.ts — Google Drive tool registrations.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerDriveTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerTool({
    name: "work_drive_search",
    label: "Search Drive",
    description: "Search files in Google Drive.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query" },
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
        max_results: {
          type: "number",
          description: "Max results (default 10)",
        },
      },
      required: ["query"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const query = (param(params, "query") as string) || "";
        if (!query) return err("query is required");
        const args: Record<string, unknown> = {
          query,
          max_results: (param(params, "max_results") as number) || 10,
        };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await ctx.requireGoogleMcp().call("drive_search_files", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_drive_read",
    label: "Read Drive File",
    description: "Read a file from Google Drive by file ID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_id: { type: "string", description: "Google Drive file ID" },
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
      },
      required: ["file_id"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const fileId = param(params, "file_id") as string;
        if (!fileId) return err("file_id is required");
        const args: Record<string, unknown> = { file_id: fileId };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await ctx.requireGoogleMcp().call("drive_read_file_content", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
