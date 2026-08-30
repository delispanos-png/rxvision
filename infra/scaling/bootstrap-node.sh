#!/bin/bash
set -euo pipefail
# RxVision app node bootstrap (web+api+worker ONLY; DB is the shared node at ${data_ip})
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/rxvision && cd /opt/rxvision
cat > /root/NEXT_STEPS.txt <<TXT
1) git clone <repo> /opt/rxvision   (deploy key)
2) Provide .env from your secret store with:
     # MONGODB_URI seed list = ALL rs0 data-bearing members (so the driver bootstraps even if one
     # DB is down at startup). Keep in sync with rs.conf(): currently DB01 10.0.0.3, MGMT01 10.0.0.2,
     # DB02 10.0.0.8 (SRV01 10.0.0.5 was removed from the set 2026-08-30).
     MONGODB_URI=mongodb://USER:PASS@10.0.0.3:27017,10.0.0.2:27017,10.0.0.8:27017/?replicaSet=rs0&authSource=admin
     REDIS_URL=redis://:PASS@${data_ip}:6379/0
   (DB nodes must allow this private IP through their firewall.)
3) docker compose -f docker-compose.app.yml up -d   (app services only, no mongo/redis)
TXT
