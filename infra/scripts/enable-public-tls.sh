#!/usr/bin/env bash
# Switch Caddy to publicly trusted Let's Encrypt certs (DNS-01 via Cloudflare).
# Run AFTER the registrar nameservers point to Cloudflare (zone "active").
#
# The Cloudflare API token NEVER comes from a CLI argument (that would leak via shell
# history / `ps`). It must live in the server's .env as CF_API_TOKEN; if it is missing,
# this script reads it with a HIDDEN prompt (read -rs) and writes it to .env. The token
# value is never printed.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -f .env ] || { echo "missing .env"; exit 1; }

# Read a var's value from .env (empty if absent) — never echoes it to the terminal.
env_val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

# 1) Ensure CADDY_TLS requests DNS-01 issuance via the cloudflare plugin.
if grep -Eq '^CADDY_TLS=' .env; then
  if ! grep -Eq '^CADDY_TLS=.*dns cloudflare' .env; then
    sed -i 's|^CADDY_TLS=.*|CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}|' .env
    echo "set CADDY_TLS=dns cloudflare {env.CF_API_TOKEN} in .env"
  fi
else
  printf '%s\n' 'CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}' >> .env
  echo "added CADDY_TLS to .env"
fi

# 2) Ensure CF_API_TOKEN is present; if not, read it securely (hidden, never a CLI arg).
tok="$(env_val CF_API_TOKEN)"
if [ -z "${tok//[[:space:]]/}" ]; then
  echo "CF_API_TOKEN is not set in .env."
  read -rsp "Paste Cloudflare API token (scope Zone:DNS:Edit), input hidden: " tok; echo
  [ -n "${tok//[[:space:]]/}" ] || { echo "no token entered — aborting."; exit 1; }
  # Replace any existing (possibly empty) line, then append — avoids sed-escaping the token.
  { grep -v -E '^CF_API_TOKEN=' .env || true; } > .env.tmp
  printf 'CF_API_TOKEN=%s\n' "$tok" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
  unset tok
  echo "stored CF_API_TOKEN in .env (chmod 600)."
fi

echo "Building custom Caddy (caddy-dns/cloudflare) and switching over…"
docker compose -f docker-compose.prod.yml -f infra/compose.tls.yml up -d --build caddy

echo "Done. Caddy will obtain Let's Encrypt certs for app.rxvision.gr &"
echo "adminpanel.rxvision.gr via DNS-01."
echo "Tip: set the Cloudflare SSL/TLS mode to Full (strict)."
