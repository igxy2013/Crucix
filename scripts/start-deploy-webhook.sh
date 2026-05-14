#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/root/crucix}"
PID_FILE="${PID_FILE:-$ROOT_DIR/runs/deploy-webhook.pid}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/runs/deploy-webhook.log}"

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID"
    sleep 1
  fi
fi

nohup node "$ROOT_DIR/scripts/deploy-webhook.mjs" >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "deploy webhook started with pid $(cat "$PID_FILE")"
