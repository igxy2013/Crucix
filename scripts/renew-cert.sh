#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-crucix.aixopenclaw.com}"
LETSENCRYPT_DIR="${LETSENCRYPT_DIR:-/root/letsencrypt}"
WEBROOT_DIR="${WEBROOT_DIR:-/root/certbot-www}"

docker run --rm \
  -v "$LETSENCRYPT_DIR:/etc/letsencrypt" \
  -v "$WEBROOT_DIR:/var/www/certbot" \
  certbot/certbot renew --webroot -w /var/www/certbot

docker exec crucix-nginx nginx -s reload
