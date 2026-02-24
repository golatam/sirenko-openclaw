"""HTTP entrypoint for google-workspace-mcp."""
import os
import sys
import uvicorn
from starlette.types import ASGIApp, Receive, Scope, Send
from mcp.server.transport_security import TransportSecurityMiddleware
from google_workspace_mcp import config  # noqa: F401
from google_workspace_mcp.app import mcp

# Import all modules that register components
from google_workspace_mcp.prompts import calendar as _pc  # noqa: F401
from google_workspace_mcp.prompts import drive as _pd  # noqa: F401
from google_workspace_mcp.prompts import gmail as _pg  # noqa: F401
from google_workspace_mcp.prompts import slides as _ps  # noqa: F401
from google_workspace_mcp.resources import calendar as _rc  # noqa: F401
from google_workspace_mcp.resources import drive as _rd  # noqa: F401
from google_workspace_mcp.resources import gmail as _rg  # noqa: F401
from google_workspace_mcp.resources import sheets_resources  # noqa: F401
from google_workspace_mcp.resources import slides as _rs  # noqa: F401
from google_workspace_mcp.tools import calendar as _tc  # noqa: F401
from google_workspace_mcp.tools import docs_tools  # noqa: F401
from google_workspace_mcp.tools import sheets_tools  # noqa: F401
from google_workspace_mcp.tools import drive as _td  # noqa: F401
from google_workspace_mcp.tools import gmail as _tg  # noqa: F401
from google_workspace_mcp.tools import slides as _ts  # noqa: F401

# Bypass MCP DNS rebinding Host validation for Railway internal networking.
# Monkey-patch at class level before streamable_http_app() creates instances.
TransportSecurityMiddleware._validate_host = lambda self, host: True

class DebugHeadersMiddleware:
    """Log incoming request headers for debugging."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] == "http":
            headers = {k.decode(): v.decode() for k, v in scope.get("headers", [])}
            print(f"[DEBUG] {scope['method']} {scope['path']} headers={headers}",
                  flush=True, file=sys.stderr)
        await self.app(scope, receive, send)


app = DebugHeadersMiddleware(mcp.streamable_http_app())

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
