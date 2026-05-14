#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="${1:?archive path is required}"
APP_DIR="${APP_DIR:-/root/crucix}"
ENV_FILE_NAME="${ENV_FILE_NAME:-.env}"
RUNTIME_DIR_NAME="${RUNTIME_DIR_NAME:-runs}"
WEBHOOK_ENV_FILE_NAME="${WEBHOOK_ENV_FILE_NAME:-.deploy-webhook.env}"

STAGING_DIR="$(mktemp -d /tmp/crucix-deploy-XXXXXX)"

cleanup() {
  rm -rf "$STAGING_DIR"
}

trap cleanup EXIT

mkdir -p "$APP_DIR" "$APP_DIR/$RUNTIME_DIR_NAME"

tar -xzf "$ARCHIVE_PATH" -C "$STAGING_DIR"

if [ ! -f "$APP_DIR/$ENV_FILE_NAME" ] && [ -f "$STAGING_DIR/.env.example" ]; then
  cp "$STAGING_DIR/.env.example" "$APP_DIR/$ENV_FILE_NAME"
fi

find "$APP_DIR" -mindepth 1 -maxdepth 1 \
  ! -name "$ENV_FILE_NAME" \
  ! -name "$RUNTIME_DIR_NAME" \
  ! -name "$WEBHOOK_ENV_FILE_NAME" \
  -exec rm -rf {} +

cp -a "$STAGING_DIR"/. "$APP_DIR"/
mkdir -p "$APP_DIR/$RUNTIME_DIR_NAME"

cd "$APP_DIR"
docker compose up -d --build --remove-orphans
