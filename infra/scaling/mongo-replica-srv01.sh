#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MongoDB replica-set member (rs0 SECONDARY) that lives on the SRV01 app node
# (10.0.0.5), co-located with the app stack. It provides HA redundancy for the
# primary on RxVisionDB01 (10.0.0.3). The container name is "rxvision-arbiter"
# for historical reasons but it is a FULL data-bearing member (2.2GB, 151 colls),
# NOT a true arbiter.
#
# This member was originally created by an ad-hoc `docker run` that was NOT tracked
# in the repo. This script is the source of truth so it can be re-created correctly.
#
# ★ 2026-08-30: added `--wiredTigerCacheSizeGB 1` so its WiredTiger cache cannot
#   balloon to ~50%×(RAM-1GB) ≈ 3.25GB and starve the app on the shared 8GB node.
#   Cap dropped its RSS from ~1.26GB → ~0.43GB and freed ~780MB on SRV01. The app
#   reads via the primary (readPreference=primary) so this member only replicates
#   → a 1GB cache is ample.
#
# Data lives in the named volume `rxvision_arb_data` (survives recreate). Recreating
# is safe while DB01 (primary) stays up: the app keeps serving, and this member
# rejoins rs0 from its existing volume in seconds (no full resync).
#
# Usage (run ON 10.0.0.5):
#   docker stop  rxvision-arbiter
#   docker rename rxvision-arbiter rxvision-arbiter-old   # keep as rollback (don't rm yet)
#   bash mongo-replica-srv01.sh                            # start fresh with the cap
#   # once verified SECONDARY & healthy:  docker rm rxvision-arbiter-old
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

docker run -d --name rxvision-arbiter --restart unless-stopped \
  -p 10.0.0.5:27017:27017 \
  -v rxvision_arb_data:/data/db \
  -v rxvision_arb_key:/etc/mongo-keyfile \
  mongo:7 \
  --replSet rs0 --bind_ip_all --keyFile /etc/mongo-keyfile/keyfile --auth \
  --wiredTigerCacheSizeGB 1

echo "started. Verify:"
echo "  docker logs rxvision-arbiter 2>&1 | grep newState   # → SECONDARY"
echo "  docker stats --no-stream rxvision-arbiter           # → RAM bounded ≤ ~1.3GB"
