/**
 * slack.ts — Slack tool registrations: interactive messages, updates, send.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { slackApi } from "./clients.js";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerSlackTools(api: OpenClawPluginApi, _ctx: PluginContext): void {
  api.registerTool({
    name: "work_slack_interactive",
    label: "Send Interactive Message",
    description:
      "Send a Slack message with Block Kit interactive elements (buttons, selects, checkboxes). " +
      "Use for confirmations, choices, and checklists. " +
      "All action_id values MUST start with 'openclaw:' prefix for callback routing. " +
      "Returns message ts needed for work_slack_update.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: {
          type: "string",
          description: "Slack channel ID (get from work_get_channel_info)",
        },
        blocks: {
          type: "array",
          description: "Slack Block Kit blocks array (JSON). All action_id must start with 'openclaw:'",
        },
        text: {
          type: "string",
          description: "Fallback text for notifications (shown in mobile push, etc.)",
        },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to reply in thread (optional)",
        },
      },
      required: ["channel", "blocks", "text"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const channel = param(params, "channel") as string;
        const blocks = param(params, "blocks") as unknown[];
        const text = param(params, "text") as string;
        const threadTs = param(params, "thread_ts") as string | undefined;
        if (!channel) return err("channel is required");
        if (!blocks || !Array.isArray(blocks)) return err("blocks must be an array");
        if (!text) return err("text (fallback) is required");

        const body: Record<string, unknown> = { channel, blocks, text };
        if (threadTs) body.thread_ts = threadTs;
        const result = await slackApi("chat.postMessage", body);
        return ok({ sent: true, ts: result.ts, channel: result.channel });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_slack_update",
    label: "Update Slack Message",
    description:
      "Update an existing Slack message (e.g. replace buttons with result after user clicks). " +
      "Use after receiving a Slack interaction callback to remove buttons and show outcome.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        ts: {
          type: "string",
          description: "Message timestamp to update (from work_slack_interactive result or interaction payload)",
        },
        blocks: {
          type: "array",
          description: "New Block Kit blocks (replaces old blocks)",
        },
        text: {
          type: "string",
          description: "New fallback text",
        },
      },
      required: ["channel", "ts", "text"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const channel = param(params, "channel") as string;
        const ts = param(params, "ts") as string;
        const text = param(params, "text") as string;
        const blocks = param(params, "blocks") as unknown[] | undefined;
        if (!channel || !ts) return err("channel and ts are required");

        const body: Record<string, unknown> = { channel, ts, text };
        if (blocks && Array.isArray(blocks)) body.blocks = blocks;
        const result = await slackApi("chat.update", body);
        return ok({ updated: true, ts: result.ts, channel: result.channel });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_slack_send",
    label: "Send Slack Message",
    description:
      "Send a message to a Slack channel or DM. " +
      "For DM: provide user_email — the tool will look up the Slack user and open a DM. " +
      "For channel: provide channel (Slack channel ID). " +
      "At least one of channel or user_email is required.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: {
          type: "string",
          description: "Slack channel ID (e.g. C0123456789). Optional if user_email is provided.",
        },
        user_email: {
          type: "string",
          description: "Email address to send DM to (looks up Slack user). Optional if channel is provided.",
        },
        text: {
          type: "string",
          description: "Message text (Slack mrkdwn format)",
        },
      },
      required: ["text"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const text = param(params, "text") as string;
        if (!text) return err("text is required");

        let channel = param(params, "channel") as string | undefined;
        const userEmail = param(params, "user_email") as string | undefined;

        if (!channel && !userEmail) {
          return err("Either channel or user_email is required");
        }

        if (!channel && userEmail) {
          const userRes = await slackApi("users.lookupByEmail", { email: userEmail });
          const user = userRes.user as Record<string, unknown> | undefined;
          if (!user?.id) return err(`Slack user not found for email: ${userEmail}`);

          const convRes = await slackApi("conversations.open", { users: user.id as string });
          const conv = convRes.channel as Record<string, unknown> | undefined;
          if (!conv?.id) return err("Failed to open DM conversation");
          channel = conv.id as string;
        }

        const result = await slackApi("chat.postMessage", { channel: channel!, text });
        return ok({ sent: true, channel: result.channel, ts: result.ts });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
