#!/usr/bin/env python3
"""Generate OAuth tokens for Amplitude's official MCP server.

Usage:
    python scripts/gen_amplitude_token.py

No pip dependencies — uses only Python stdlib.

Flow:
  1. Dynamic Client Registration → POST /register → client_id
  2. PKCE (S256) code challenge generation
  3. Opens browser → user logs in to Amplitude
  4. Local HTTP server catches the callback with ?code=
  5. Exchanges code for tokens → POST /token
  6. Prints client_id, access_token, refresh_token for Railway env vars

OAuth discovery (https://mcp.amplitude.com/.well-known/oauth-authorization-server):
  Authorization: https://mcp.amplitude.com/authorize
  Token:         https://mcp.amplitude.com/token
  Registration:  https://mcp.amplitude.com/register
"""
import hashlib
import base64
import secrets
import json
import sys
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.error import HTTPError

MCP_BASE = "https://mcp.amplitude.com"
REGISTER_URL = f"{MCP_BASE}/register"
AUTHORIZE_URL = f"{MCP_BASE}/authorize"
TOKEN_URL = f"{MCP_BASE}/token"

REDIRECT_PORT = 9876
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}"
SCOPES = "mcp:read offline_access"


def json_post(url: str, data: dict) -> dict:
    """POST JSON and return parsed response."""
    body = json.dumps(data).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        err_body = e.read().decode()
        print(f"HTTP {e.code} from {url}:\n{err_body}", file=sys.stderr)
        raise


def form_post(url: str, data: dict) -> dict:
    """POST form-urlencoded and return parsed response."""
    body = urlencode(data).encode()
    req = Request(url, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded",
    })
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        err_body = e.read().decode()
        print(f"HTTP {e.code} from {url}:\n{err_body}", file=sys.stderr)
        raise


def generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def main():
    print("=== Amplitude MCP OAuth Token Generator ===\n")

    # Step 1: Dynamic Client Registration
    print("[1/5] Registering OAuth client...")
    reg = json_post(REGISTER_URL, {
        "client_name": "OpenClaw Work Agent (CLI setup)",
        "redirect_uris": [REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    })
    client_id = reg["client_id"]
    print(f"      client_id: {client_id}")

    # Step 2: PKCE
    print("[2/5] Generating PKCE challenge...")
    code_verifier, code_challenge = generate_pkce()

    # Step 3: Open browser
    auth_params = urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })
    auth_url = f"{AUTHORIZE_URL}?{auth_params}"

    print("[3/5] Opening browser for authorization...")
    print(f"      If browser doesn't open, visit:\n      {auth_url}\n")
    webbrowser.open(auth_url)

    # Step 4: Local callback server
    print(f"[4/5] Waiting for callback on localhost:{REDIRECT_PORT}...")
    auth_code = None

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal auth_code
            qs = parse_qs(urlparse(self.path).query)
            if "error" in qs:
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                error_msg = qs["error"][0]
                desc = qs.get("error_description", [""])[0]
                self.wfile.write(f"<h2>Error: {error_msg}</h2><p>{desc}</p>".encode())
                print(f"\nError from Amplitude: {error_msg} — {desc}", file=sys.stderr)
                return

            auth_code = qs.get("code", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Success! You can close this tab.</h2>")

        def log_message(self, format, *args):
            pass  # suppress HTTP logs

    server = HTTPServer(("127.0.0.1", REDIRECT_PORT), CallbackHandler)
    server.handle_request()
    server.server_close()

    if not auth_code:
        print("\nFailed to receive authorization code.", file=sys.stderr)
        sys.exit(1)

    print("      Authorization code received.")

    # Step 5: Exchange code for tokens
    print("[5/5] Exchanging code for tokens...")
    tokens = form_post(TOKEN_URL, {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": auth_code,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": code_verifier,
    })

    access_token = tokens.get("access_token", "")
    refresh_token = tokens.get("refresh_token", "")
    expires_in = tokens.get("expires_in", "unknown")

    print("\n" + "=" * 60)
    print("Set these Railway env vars for the gateway service:")
    print("=" * 60)
    print(f"\nAMPLITUDE_OAUTH_CLIENT_ID={client_id}")
    print(f"AMPLITUDE_OAUTH_ACCESS_TOKEN={access_token}")
    print(f"AMPLITUDE_OAUTH_REFRESH_TOKEN={refresh_token}")
    print(f"\n(access_token expires in {expires_in}s — auto-refreshed by gateway)")
    print("=" * 60)


if __name__ == "__main__":
    main()
