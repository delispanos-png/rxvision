#!/usr/bin/env bash
# Unseal the Vault container after a restart/reboot.
# Single-node file storage => Vault starts SEALED and must be unsealed before the
# API can read tenant ΗΔΙΚΑ/ΓΕΣΥ credentials from it.
#
# PRODUCTION: replace this with auto-unseal (cloud KMS / Vault transit) so no human
# or on-disk key is required. The unseal key in secrets/vault-init.json is sensitive.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

INIT_FILE="secrets/vault-init.json"
[ -f "$INIT_FILE" ] || { echo "missing $INIT_FILE"; exit 1; }

UNSEAL=$(python3 -c 'import json;print(json.load(open("secrets/vault-init.json"))["unseal_keys_b64"][0])')
docker exec -e VAULT_ADDR=http://127.0.0.1:8200 rxvision-vault-1 vault operator unseal "$UNSEAL" >/dev/null
echo "vault unsealed:"
docker exec -e VAULT_ADDR=http://127.0.0.1:8200 rxvision-vault-1 vault status -format=json \
  | python3 -c 'import sys,json;print("  sealed =",json.load(sys.stdin)["sealed"])'
