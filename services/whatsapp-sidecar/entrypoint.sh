#!/bin/sh
set -e

# Fix volume permissions — Railway mounts volumes as root,
# but we run as appuser for security.
chown -R appuser:appuser /data

exec gosu appuser node main.js
