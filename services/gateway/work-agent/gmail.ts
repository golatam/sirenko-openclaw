/**
 * gmail.ts — Gmail tool registrations: read email, send email.
 * (Unified search is in ops.ts since it's cross-domain.)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { confirmationId } from "./utils.js";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerGmailTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerTool({
    name: "work_read_email",
    label: "Read Email",
    description: "Read a specific email by message ID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        message_id: { type: "string", description: "Gmail message ID" },
        account: {
          type: "string",
          description: "Gmail account email (optional)",
        },
      },
      required: ["message_id"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const messageId = param(params, "message_id") as string;
        if (!messageId) return err("message_id is required");
        const args: Record<string, unknown> = { message_id: messageId };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await ctx.requireGoogleMcp().call("gmail_get_message_details", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_send_email",
    label: "Send Email",
    description:
      "Send an email via a connected Gmail account. " +
      "First call WITHOUT confirmed — returns a preview with confirmation_id. " +
      "Then call again WITH confirmed: true and the same confirmation_id to execute.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account: {
          type: "string",
          description: "Gmail account email to send from (optional)",
        },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        message: { type: "string", description: "Email body (plain text or HTML)" },
        cc: { type: "string", description: "CC recipients (comma-separated)" },
        bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        confirmed: {
          type: "boolean",
          description: "Set to true to execute after user confirmed the preview",
        },
        confirmation_id: {
          type: "string",
          description: "Confirmation ID from the preview response",
        },
      },
      required: ["to", "subject", "message"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const to = param(params, "to") as string;
        const subject = param(params, "subject") as string;
        const message = param(params, "message") as string;
        if (!to || !subject || !message) return err("to, subject, and message are required");

        const account = param(params, "account") as string | undefined;
        const cc = param(params, "cc") as string | undefined;
        const bcc = param(params, "bcc") as string | undefined;

        const payload: Record<string, unknown> = { to, subject, message };
        if (account) payload.account = account;
        if (cc) payload.cc = cc;
        if (bcc) payload.bcc = bcc;
        const cid = confirmationId(payload);

        const confirmed = param(params, "confirmed") as boolean | undefined;
        const providedCid = param(params, "confirmation_id") as string | undefined;

        if (!confirmed) {
          return ok({
            preview: true,
            confirmation_id: cid,
            action: "send_email",
            details: {
              from: account || "(default account)",
              to,
              subject,
              message_preview: message.length > 200 ? message.slice(0, 200) + "…" : message,
              cc: cc || undefined,
              bcc: bcc || undefined,
            },
          });
        }

        if (providedCid !== cid) {
          return err("confirmation_id mismatch — parameters changed since preview, please re-preview");
        }

        const args: Record<string, unknown> = { to, subject, body: message };
        if (account) args.account = account;
        if (cc) args.cc = cc;
        if (bcc) args.bcc = bcc;

        const result = await ctx.requireGoogleMcp().call("gmail_send_email", args);
        return ok(result, { action: "email_sent" });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
