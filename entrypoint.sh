#!/bin/bash
# Ensure auth home exists, then start the HTTP proxy.
set -euo pipefail

mkdir -p /root/.grok /app/data /app/logs

if [ ! -x /usr/local/bin/grok ]; then
  echo "[entrypoint] ERROR: /usr/local/bin/grok missing — rebuild image" >&2
  exit 1
fi

echo "[entrypoint] GROK_BIN=${GROK_BIN:-/usr/local/bin/grok}"
/usr/local/bin/grok --version 2>/dev/null || true

exec node /app/server.js
