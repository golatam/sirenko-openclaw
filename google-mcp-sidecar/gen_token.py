#!/usr/bin/env python3
"""Generate a Google OAuth refresh token for multi-account setup.

Usage:
    python gen_token.py

Requirements:
    pip install google-auth-oauthlib

The script uses GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars
(or prompts interactively). It opens a browser for OAuth consent and prints
the refresh_token to copy into Railway's GOOGLE_WORKSPACE_ACCOUNTS JSON.
"""
import os
import sys
import json

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print("Install google-auth-oauthlib first:  pip install google-auth-oauthlib")
    sys.exit(1)

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.email",
]

def main():
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or input("Client ID: ").strip()
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or input("Client Secret: ").strip()

    if not client_id or not client_secret:
        print("Error: client_id and client_secret are required")
        sys.exit(1)

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost:8080"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
    creds = flow.run_local_server(port=8080, prompt="consent", access_type="offline")

    print("\n" + "=" * 60)
    print("Refresh Token (copy this):")
    print("=" * 60)
    print(creds.refresh_token)
    print("=" * 60)

    # Try to get the user email
    try:
        import google.auth.transport.requests
        from googleapiclient.discovery import build
        session = google.auth.transport.requests.Request()
        creds.refresh(session)
        service = build("oauth2", "v2", credentials=creds)
        info = service.userinfo().get().execute()
        email = info.get("email", "unknown")
        print(f"\nAccount: {email}")
        print(f'\nAdd to GOOGLE_WORKSPACE_ACCOUNTS:')
        print(f'  "{email}": "{creds.refresh_token}"')
    except Exception:
        print("\nCould not fetch account email. Add the token manually.")

if __name__ == "__main__":
    main()
