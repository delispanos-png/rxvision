#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# RxVisionDB02 (10.0.0.8) — DEDICATED MongoDB replica node, added to rs0 as a
# preferred hot-standby SECONDARY of the primary on RxVisionDB01 (10.0.0.3).
# Provisioned 2026-08-30. VM: Ubuntu 22.04, 4GB RAM, private IP 10.0.0.8.
#
# Final rs0 topology (production-grade HA, odd voting count = 3):
#   DB01  10.0.0.3  priority 3  vote 1   (dedicated, preferred PRIMARY)
#   DB02  10.0.0.8  priority 2  vote 1   (dedicated, preferred STANDBY)
#   SRV01 10.0.0.5  priority 1  vote 1   (app node, last-resort vote)
#   MGMT01 10.0.0.2 priority 0  vote 0   (build node, non-voting data replica)
# → any single node can fail and a primary remains (majority=2); the two dedicated
#   DBs alone (DB01+DB02) form a majority, so shared-node loss never blocks writes.
#
# NOTE: DB02 is a 4GB VM while DB01 is 8GB. Fine for the current ~1.2GB dataset, but
# for a truly equal standby resize DB02 to 8GB when convenient.
#
# ── How it was built (run FROM MGMT01 which holds the rs0 keyfile volume) ────────
# 0) Authorize the deploy key on the new VM (Hetzner injects registered keys only at
#    create/rebuild): add infra/scaling/keys/rxvision_data.pub to 10.0.0.8 authorized_keys.
# 1) Install Docker on DB02:
#      ssh root@10.0.0.8 'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker'
# 2) Seed the SHARED rs0 keyfile onto DB02 (must NOT be auto-generated, or auth fails):
#      docker run --rm -v rxvision_mongo_keyfile:/kf alpine cat /kf/keyfile | \
#        ssh root@10.0.0.8 'docker volume create rxvision_db02_keyfile >/dev/null;
#          docker volume create rxvision_db02_data >/dev/null;
#          docker run --rm -i -v rxvision_db02_keyfile:/kf alpine \
#            sh -c "cat > /kf/keyfile && chmod 400 /kf/keyfile && chown 999:999 /kf/keyfile"'
# 3) Start mongod on DB02 (see the docker run below).
# 4) From the PRIMARY (DB01), add it safely (no quorum change), let it initial-sync:
#      rs.add({host:"10.0.0.8:27017", priority:0, votes:0})   # → wait until SECONDARY
# 5) Two-step reconfig (MongoDB allows changing only 1 voting member per non-force reconfig):
#      step1: DB02 votes 0→1 (+ priorities DB01=3,DB02=2,SRV01=1,MGMT01 priority 0)
#      step2: MGMT01 votes 1→0    # back to 3 voting members (odd)
#
# ── The DB02 mongod container (run ON 10.0.0.8) ─────────────────────────────────
set -euo pipefail

docker run -d --name rxvision-mongo --restart unless-stopped \
  -p 10.0.0.8:27017:27017 \
  -v rxvision_db02_data:/data/db \
  -v rxvision_db02_keyfile:/etc/mongo-keyfile \
  mongo:7 \
  --replSet rs0 --bind_ip_all --keyFile /etc/mongo-keyfile/keyfile --auth
# Dedicated DB node → WiredTiger cache left at default (~50%×(RAM-1GB)); on this 4GB
# VM that is ~1.5GB, which is fine for the current dataset.

echo "started. From the primary (DB01) verify:  rs.status()  → 10.0.0.8:27017 SECONDARY health=1"
