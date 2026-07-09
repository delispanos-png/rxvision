#!/usr/bin/env bash
# Full-stack deploy: build ONCE on MGMT01, ship the byte-identical images to every app node
# over the PRIVATE network, recreate (no rebuild), verify. Replaces the web-only deploy-web.sh.
#
# WHY (incidents 2026-06-13 & 2026-06-22):
#   • Building web independently per node → different Next.js chunk hashes → cross-origin 404s.
#     FIX: build once here, ship the SAME image. Never `build web` on an app node.
#   • Deploying to an app node's PUBLIC IP fails: the app firewall allows SSH only from the
#     private net (MGMT). ALWAYS use the private IP (10.0.0.x). Public 62.238.5.78 → timeout.
#
# Topology (2026-06): Cloudflare → Hetzner LB 65.109.43.125 → app node(s). MGMT01 (10.0.0.2)
#   is the build/rollback host and is NOT an LB target (serves 0 traffic). DB on 10.0.0.3.
#
# Usage:  bash infra/scaling/deploy.sh            # deploy api+web+worker
#         SERVICES="web" bash infra/scaling/deploy.sh   # only the web tier
set -euo pipefail

ROOT=/opt/rxvision
KEY="$ROOT/infra/scaling/keys/rxvision_data"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10)
APP_COMPOSE=/opt/rxvision/docker-compose.app.yml

# Live app nodes behind the LB — PRIVATE IPs only (public is firewalled to MGMT-only SSH).
# Keep in sync with the LB targets: SRV01=10.0.0.5, SRV02=10.0.0.6 (added 2026-07-03).
# ALL app nodes must get the SAME web image in one run, or clients hit cross-node chunk-hash 404s.
APP_NODES=(10.0.0.5 10.0.0.6)
# Which tiers to push. api image is shared by api+worker on the app node.
SERVICES="${SERVICES:-api web worker}"

cd "$ROOT"

echo "▶ 1/4  Build on MGMT01 (single source of truth)…"
# worker/beat build from ./backend too but are SEPARATE images — rebuild them or the
# beat scheduler / workers on MGMT keep stale task code (incident 2026-06-22: new beat task missing).
# NOTE: `optical` lives ONLY on the app nodes (docker-compose.app.yml) since the 2026-07-02 RAM
# rebalance — it is NOT a service in docker-compose.prod.yml, so it must NOT be listed here.
docker compose -f docker-compose.prod.yml build api web worker beat
# keep MGMT's own containers current (build/rollback origin + the beat scheduler lives here).
docker compose -f docker-compose.prod.yml up -d api web worker beat

for NODE in "${APP_NODES[@]}"; do
  echo "▶ 2/4  Ship images → $NODE (private net)…"
  docker save rxvision-api:latest | gzip -1 | "${SSH[@]}" "root@$NODE" \
    'gunzip | docker load && docker tag rxvision-api:latest rxvision-app-api:latest && docker tag rxvision-api:latest rxvision-app-worker:latest'
  docker save rxvision-web:latest | gzip -1 | "${SSH[@]}" "root@$NODE" \
    'gunzip | docker load && docker tag rxvision-web:latest rxvision-app-web:latest'

  # Keep the reverse-proxy config in sync (bind-mounted from the node's checkout). Ships the repo
  # Caddyfile + validates + hot-reloads — so the LB /lb-health probe and routing never drift per node.
  echo "▶ 2b/4  Sync Caddyfile + reload on $NODE…"
  scp -i "$KEY" -o StrictHostKeyChecking=no infra/docker/Caddyfile "root@$NODE:/opt/rxvision/infra/docker/Caddyfile"
  "${SSH[@]}" "root@$NODE" \
    'docker exec rxvision-app-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
       && docker exec rxvision-app-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
       && echo "   caddy reloaded" || echo "   ⚠️ caddy validate/reload failed — check config"'

  echo "▶ 3/4  Recreate [$SERVICES] on $NODE (no rebuild)…"
  "${SSH[@]}" "root@$NODE" \
    "docker compose --project-directory /opt/rxvision -f $APP_COMPOSE up -d --no-build --force-recreate $SERVICES"

  echo "▶ 4/4  Verify $NODE serves the SAME web build as MGMT…"
  A=$(docker compose -f docker-compose.prod.yml exec -T web cat /app/.next/BUILD_ID)
  B=$("${SSH[@]}" "root@$NODE" 'docker exec rxvision-app-web-1 cat /app/.next/BUILD_ID')
  echo "   MGMT BUILD_ID=$A"
  echo "   $NODE BUILD_ID=$B"
  [ "$A" = "$B" ] || { echo "❌ BUILD_ID MISMATCH on $NODE — clients would crash. Abort." >&2; exit 1; }
  echo "✅ $NODE on build $A."
done
echo "✅ Deploy complete to: ${APP_NODES[*]}"

# MGMT is NOT an LB target and no longer serves public traffic (adminpanel/my/app all go via the LB →
# app nodes since 2026-07-03). Keep its web/caddy/worker STOPPED to save ~500MB RAM — the build/rollback
# images stay on disk, and beat (still running on MGMT) dispatches jobs to the app-node workers. We start
# web+worker above only to rebuild them + read the reference BUILD_ID; re-stop them so the saving is durable.
docker compose -f docker-compose.prod.yml stop web caddy worker >/dev/null 2>&1 || true
echo "ℹ️  MGMT web/caddy/worker stopped (RAM saver) — they run only on the app nodes now."
