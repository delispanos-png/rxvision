#!/usr/bin/env bash
# Wait for the Vault container to come up after a (re)boot, then unseal it.
# Invoked by the rxvision.service systemd unit (ExecStartPost).
set -uo pipefail
cd "$(dirname "$0")/../.."

for _ in $(seq 1 30); do
  if docker exec -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/vault.crt rxvision-vault-1 \
       vault status -format=json >/tmp/vstatus.json 2>/dev/null \
     || [ -s /tmp/vstatus.json ]; then
    break
  fi
  sleep 2
done

bash "$(dirname "$0")/vault-unseal.sh" || true
