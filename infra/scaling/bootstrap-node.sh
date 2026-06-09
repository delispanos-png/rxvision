#!/bin/bash
set -euo pipefail
# RxVision app node bootstrap (web+api+worker ONLY; DB is the shared node at ${data_ip})
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/rxvision && cd /opt/rxvision
cat > /root/NEXT_STEPS.txt <<TXT
1) git clone <repo> /opt/rxvision   (deploy key)
2) Provide .env from your secret store with:
     MONGODB_URI=mongodb://USER:PASS@${data_ip}:27017/rxvision?authSource=admin&replicaSet=rs0
     REDIS_URL=redis://:PASS@${data_ip}:6379/0
   (DB node must allow this private IP through its firewall.)
3) docker compose -f docker-compose.app.yml up -d   (app services only, no mongo/redis)
TXT
