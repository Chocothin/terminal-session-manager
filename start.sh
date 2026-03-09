#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/.tsm-token"
LOG_DIR="$SCRIPT_DIR/logs"

mkdir -p "$LOG_DIR"

if [[ -f "$TOKEN_FILE" ]]; then
  TSM_AUTH_TOKEN="$(cat "$TOKEN_FILE")"
  export TSM_AUTH_TOKEN
elif [[ -z "${TSM_AUTH_TOKEN:-}" ]]; then
  TSM_AUTH_TOKEN="$(openssl rand -hex 24)"
  echo "$TSM_AUTH_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  export TSM_AUTH_TOKEN
  echo "[start] Generated new auth token → $TOKEN_FILE"
  echo "[start] Token: $TSM_AUTH_TOKEN"
  echo "[start] Save this token — you'll need it to authenticate from your phone."
fi

# Resolve node path (LaunchAgent may not have nvm/fnm in PATH)
if command -v node &>/dev/null; then
  NODE_BIN="$(command -v node)"
else
  
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "${NODE_BIN:-}" ]]; then
  echo "[start] ERROR: node not found" >&2
  exit 1
fi

export TSM_HOST="0.0.0.0"

echo "[start] $(date '+%Y-%m-%d %H:%M:%S') Starting TSM server (node: $NODE_BIN, pid: $$)"

cd "$SCRIPT_DIR"
exec "$NODE_BIN" packages/server/dist/index.js
