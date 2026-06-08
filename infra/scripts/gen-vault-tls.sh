#!/usr/bin/env bash
# Generate a self-signed TLS cert/key for the in-cluster Vault listener.
# Idempotent: does nothing if a cert already exists. Run before `docker compose up`
# (Makefile `up` and systemd ExecStartPre call this automatically).
#
# The cert is INTERNAL only (Docker network); it is not the public site cert.
# SANs cover how Vault is reached: `vault` (from the API), 127.0.0.1/localhost (CLI
# inside the container during unseal). Files are gitignored (they are secrets).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

TLS_DIR="infra/docker/vault/tls"
CRT="$TLS_DIR/vault.crt"
KEY="$TLS_DIR/vault.key"

if [ -s "$CRT" ] && [ -s "$KEY" ]; then
  echo "vault TLS cert already present at $CRT — skipping."
  exit 0
fi

mkdir -p "$TLS_DIR"
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=vault" \
  -addext "subjectAltName=DNS:vault,DNS:localhost,IP:127.0.0.1"

chmod 644 "$CRT"
# Vault runs as uid 100 in-container. Prefer keeping the key 600 owned by that uid
# (works when run as root, e.g. systemd); otherwise relax so the vault user can read it.
if chown 100:100 "$KEY" 2>/dev/null; then chmod 600 "$KEY"; else chmod 644 "$KEY"; fi

echo "generated self-signed vault TLS cert -> $CRT (valid 10y)"
