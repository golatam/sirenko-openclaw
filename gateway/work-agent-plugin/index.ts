import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const notConfigured = (tool: string) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(
        {
          ok: false,
          error: `Tool ${tool} is not configured yet. Populate plugins.entries.work-agent.config in ~/.openclaw/openclaw.json.`,
        },
        null,
        2,
      ),
    },
  ],
  details: { ok: false, error: `Tool ${tool} is not configured yet.` },
});

const WorkAgentPlugin = {
  id: "work-agent",
  name: "Work Agent",
  description: "Gmail/Calendar/WhatsApp/Telegram indexing + reports.",
  kind: "tools",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool({
      name: "work_search_messages",
      label: "Work Search Messages",
      description: "Search indexed messages across email, WhatsApp, and Telegram.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          project: { type: "string" },
          channel: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute() {
        return notConfigured("work_search_messages");
      },
    });

    api.registerTool({
      name: "work_summarize_project",
      label: "Work Summarize Project",
      description: "Summarize a project from indexed messages.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          project: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["project"],
      },
      async execute() {
        return notConfigured("work_summarize_project");
      },
    });

    api.registerTool({
      name: "work_send_email",
      label: "Work Send Email",
      description: "Send email via connected Gmail account(s).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: { type: "string" },
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
      async execute() {
        return notConfigured("work_send_email");
      },
    });

    api.registerTool({
      name: "work_schedule_meeting",
      label: "Work Schedule Meeting",
      description: "Create a Google Calendar event.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          attendees: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "start", "end"],
      },
      async execute() {
        return notConfigured("work_schedule_meeting");
      },
    });

    api.registerTool({
      name: "work_weekly_report",
      label: "Work Weekly Report",
      description: "Generate a weekly report for one or more projects.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          projects: {
            type: "array",
            items: { type: "string" },
          },
          weekStart: { type: "string" },
          weekEnd: { type: "string" },
        },
        required: ["projects"],
      },
      async execute() {
        return notConfigured("work_weekly_report");
      },
    });
  },
};

export default WorkAgentPlugin;
