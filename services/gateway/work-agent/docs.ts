/**
 * docs.ts — Google Docs tool registrations.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { extractParams, param, ok, err } from "./adapter.js";
import type { PluginContext } from "./types.js";

export function registerDocsTools(api: OpenClawPluginApi, ctx: PluginContext): void {
  api.registerTool({
    name: "work_docs_create",
    label: "Create Document",
    description:
      "Create a new Google Document, optionally with initial text content. Returns document ID and URL.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Initial text content (optional)" },
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
        const content = param(params, "content") as string | undefined;
        if (content) args.content = content;
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("docs_create", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_docs_read",
    label: "Read Document",
    description:
      "Read the full text content of a Google Document. Returns plain text extracted from the document body.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        document_id: { type: "string", description: "Google Document ID" },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["document_id"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const documentId = param(params, "document_id") as string;
        if (!documentId) return err("document_id is required");
        const args: Record<string, unknown> = { document_id: documentId };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("docs_read", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });

  api.registerTool({
    name: "work_docs_append",
    label: "Append to Document",
    description:
      "Append text to the end of a Google Document.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        document_id: { type: "string", description: "Google Document ID" },
        text: { type: "string", description: "Text to append" },
        account: { type: "string", description: "Gmail account email (optional)" },
      },
      required: ["document_id", "text"],
    },
    async execute(...rawArgs: unknown[]) {
      const params = extractParams(rawArgs);
      try {
        const googleMcp = ctx.requireGoogleMcp();
        const documentId = param(params, "document_id") as string;
        const text = param(params, "text") as string;
        if (!documentId || !text) return err("document_id and text are required");
        const args: Record<string, unknown> = { document_id: documentId, text };
        const account = param(params, "account") as string | undefined;
        if (account) args.account = account;
        const result = await googleMcp.call("docs_append", args);
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    },
  });
}
