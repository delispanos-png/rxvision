#!/usr/bin/env bash
# Switch Caddy to publicly trusted Let's Encrypt certs (DNS-01 via Cloudflare).
# Run AFTER the registrar nameservers point to Cloudflare (zone "active").
#   bash infra/scripts/enable-public-tls.sh <CLOUDFLARE_API_TOKEN>
set -euo pipefail
cd "$(dirname "$0")/../.."

TOKEN="${1:-}"
[ -n "$TOKEN" ] || { echo "usage: $0 <CLOUDFLARE_API_TOKEN>"; exit 1; }

# .env: enable DNS-01 issuance and provide the token
sed -i "s|^CADDY_TLS=.*|CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}|" .env
sed -i "s|^CF_API_TOKEN=.*|CF_API_TOKEN=${TOKEN}|" .env

echo "Building custom Caddy (caddy-dns/cloudflare) and switching over…"
docker compose -f docker-compose.prod.yml -f infra/compose.tls.yml up -d --build caddy

echo "Done. Caddy will obtain certs for app.rxvision.gr & adminpanel.rxvision.gr via DNS-01."
echo "Tip: set Cloudflare SSL/TLS mode to Full (or Full strict)."
