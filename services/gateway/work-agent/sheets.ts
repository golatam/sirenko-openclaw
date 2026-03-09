/**
 * sheets.ts — Google Sheets tool registrations.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerSheetsTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerTool({
    name: "work_sheets_create",
    label: "Create Spreadsheet",
    description:
      "Create a new Google Spreadsheet. Returns spreadsheet ID and URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Spreadsheet title" },
        sheet_names: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of sheet/tab names (default: one \"Sheet1\")",
        },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["title"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const title = param(params, "title") as string;
        if (!title) return err("title is required");
        const args: Record<string, unknown> = { title };
        const sheetNames = param(params, "sheet_names") as string[] | undefined;
        if (sheetNames?.length) args.sheet_names = sheetNames;
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("sheets_create", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_sheets_read",
    label: "Read Spreadsheet",
    description:
      "Read values from a Google Spreadsheet range. " +
      "Range uses A1 notation (e.g. \"Sheet1!A1:D10\", \"Sheet1\", \"A1:B5\").",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        spreadsheet_id: { type: "string", description: "Google Spreadsheet ID" },
        range: {
          type: "string",
          description: "A1 notation range (default: \"Sheet1\")",
        },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["spreadsheet_id"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const spreadsheetId = param(params, "spreadsheet_id") as string;
        if (!spreadsheetId) return err("spreadsheet_id is required");
        const args: Record<string, unknown> = { spreadsheet_id: spreadsheetId };
        const range = param(params, "range") as string | undefined;
        if (range) args.range = range;
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("sheets_read", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_sheets_write",
    label: "Write Spreadsheet",
    description:
      "Write values to a Google Spreadsheet range. Overwrites existing data in the range.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        spreadsheet_id: { type: "string", description: "Google Spreadsheet ID" },
        range: {
          type: "string",
          description: "A1 notation range (e.g. \"Sheet1!A1\")",
        },
        values: {
          type: "array",
          description: "2D array of values, e.g. [[\"Name\",\"Age\"],[\"Alice\",30]]",
        },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const spreadsheetId = param(params, "spreadsheet_id") as string;
        const range = param(params, "range") as string;
        const values = param(params, "values") as unknown[];
        if (!spreadsheetId || !range || !values) return err("spreadsheet_id, range, and values are required");
        const args: Record<string, unknown> = {
          spreadsheet_id: spreadsheetId, range, values,
        };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("sheets_write", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_sheets_append",
    label: "Append to Spreadsheet",
    description:
      "Append rows after existing data in a Google Spreadsheet. " +
      "New rows are added below the last row with data.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        spreadsheet_id: { type: "string", description: "Google Spreadsheet ID" },
        values: {
          type: "array",
          description: "2D array of rows to append, e.g. [[\"Alice\",30],[\"Bob\",25]]",
        },
        range: {
          type: "string",
          description: "Sheet name or range to append to (default: \"Sheet1\")",
        },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["spreadsheet_id", "values"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const spreadsheetId = param(params, "spreadsheet_id") as string;
        const values = param(params, "values") as unknown[];
        if (!spreadsheetId || !values) return err("spreadsheet_id and values are required");
        const args: Record<string, unknown> = {
          spreadsheet_id: spreadsheetId, values,
        };
        const range = param(params, "range") as string | undefined;
        if (range) args.range = range;
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("sheets_append", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
