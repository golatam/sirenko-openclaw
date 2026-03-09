/**
 * calendar.ts — Google Calendar tool registrations.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { confirmationId } from "./utils.js";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerCalendarTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerTool({
    name: "work_list_calendars",
    label: "List Calendars",
    description: "List available Google Calendars.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
      },
      required: [],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const args: Record<string, unknown> = {};
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await ctx.requireGoogleMcp().call("calendar_list_calendars", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_list_events",
    label: "List Calendar Events",
    description: "List events from a Google Calendar.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: primary)",
        },
        time_min: {
          type: "string",
          description: "Start time (ISO 8601)",
        },
        time_max: {
          type: "string",
          description: "End time (ISO 8601)",
        },
        max_results: {
          type: "number",
          description: "Max events to return (default 10)",
        },
      },
      required: [],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const args: Record<string, unknown> = {
          calendar_id: (param(params, "calendar_id") as string) || "primary",
          max_results: (param(params, "max_results") as number) || 10,
        };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const timeMin = param(params, "time_min") as string | undefined;
        if (timeMin) args.time_min = timeMin;
        const timeMax = param(params, "time_max") as string | undefined;
        if (timeMax) args.time_max = timeMax;

        const result = await ctx.requireGoogleMcp().call("calendar_get_events", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_schedule_meeting",
    label: "Schedule Meeting",
    description:
      "Create a Google Calendar event. " +
      "First call WITHOUT confirmed — returns a preview with confirmation_id. " +
      "Then call again WITH confirmed: true and the same confirmation_id to execute.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time (ISO 8601)" },
        end: { type: "string", description: "End time (ISO 8601)" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses",
        },
        calendar_id: {
          type: "string",
          description: "Calendar ID (default: primary)",
        },
        confirmed: {
          type: "boolean",
          description: "Set to true to execute after user confirmed the preview",
        },
        confirmation_id: {
          type: "string",
          description: "Confirmation ID from the preview response",
        },
      },
      required: ["title", "start", "end"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const title = (param(params, "title") as string) || "";
        const start = (param(params, "start") as string) || "";
        const end = (param(params, "end") as string) || "";
        if (!title || !start || !end) return err("title, start, and end are required");

        const account = param(params, "account") as string | undefined;
        const description = param(params, "description") as string | undefined;
        const location = param(params, "location") as string | undefined;
        const attendees = param(params, "attendees") as string[] | undefined;
        const calendarId = (param(params, "calendar_id") as string) || "primary";

        const payload: Record<string, unknown> = { title, start, end, calendar_id: calendarId };
        if (account) payload.account = account;
        if (description) payload.description = description;
        if (location) payload.location = location;
        if (attendees?.length) payload.attendees = attendees;
        const cid = confirmationId(payload);

        const confirmed = param(params, "confirmed") as boolean | undefined;
        const providedCid = param(params, "confirmation_id") as string | undefined;

        if (!confirmed) {
          return ok({
            preview: true,
            confirmation_id: cid,
            action: "schedule_meeting",
            details: {
              title,
              start,
              end,
              calendar_id: calendarId,
              account: account || "(default account)",
              description: description || undefined,
              location: location || undefined,
              attendees: attendees?.length ? attendees : undefined,
            },
          });
        }

        if (providedCid !== cid) {
          return err("confirmation_id mismatch — parameters changed since preview, please re-preview");
        }

        const args: Record<string, unknown> = {
          summary: title,
          start_time: start,
          end_time: end,
          calendar_id: calendarId,
        };
        if (account) args.account = account;
        if (description) args.description = description;
        if (location) args.location = location;
        if (attendees?.length) args.attendees = attendees;

        const result = await ctx.requireGoogleMcp().call("create_calendar_event", args);
        return ok(result, { action: "event_created" });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
