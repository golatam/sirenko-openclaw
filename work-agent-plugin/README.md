# Work Agent Plugin

Skeleton OpenClaw plugin providing tool entrypoints for:
- `work_search_messages`
- `work_summarize_project`
- `work_send_email`
- `work_schedule_meeting`
- `work_weekly_report`

This plugin is a placeholder: tool bodies return "not configured" until backing services are implemented.

## Configure
Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "load": { "paths": ["/Volumes/Kirill_HDD/_CLAUDE/openclaw/work-agent-plugin"] },
    "entries": {
      "work-agent": {
        "enabled": true,
        "config": {
          "dbUrl": "postgres://...",
          "gmail": {
            "clientId": "...",
            "clientSecret": "...",
            "redirectUri": "...",
            "accounts": [{ "label": "main", "email": "you@gmail.com" }]
          },
          "gcal": {
            "clientId": "...",
            "clientSecret": "...",
            "redirectUri": "...",
            "accounts": [{ "label": "main", "email": "you@gmail.com" }]
          },
          "reports": { "timezone": "Europe/Moscow", "cadence": "weekly" }
        }
      }
    }
  }
}
```

Restart the gateway after config changes.
