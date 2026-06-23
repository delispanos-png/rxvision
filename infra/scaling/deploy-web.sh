#!/usr/bin/env bash
# Deploy the Next.js frontend (web) to BOTH nodes from a SINGLE build.
#
# WHY THIS EXISTS (incident 2026-06-13):
#   Building the web image independently on each node produces DIFFERENT chunk hashes
#   (Next.js BUILD_ID is random + content-hashed chunks). Cloudflare load-balances across
#   both origins (SRV01 + SRV02), so a browser can fetch index.html from one build and then
#   request a /_next/static/chunks/* file that only exists in the OTHER build → 404 →
#   hydration fails → app-wide blank "Application error: a client-side exception".
#
#   FIX: build ONCE on SRV01, then ship the byte-identical image to SRV02. Never `build web`
#   on SRV02 independently. Both origins must serve the same BUILD_ID.
#
# Usage:  bash infra/scaling/deploy-web.sh
set -euo pipefail

ROOT=/opt/rxvision
KEY="$ROOT/infra/scaling/keys/rxvision_data"
APP_NODE=root@10.0.0.5   # SRV02 PRIVATE IP — ship over the private net (fast, no public-traffic cost)
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no)

cd "$ROOT"

echo "▶ 1/4  Build web on SRV01 (the single source of truth)…"
docker compose -f docker-compose.prod.yml build web
docker compose -f docker-compose.prod.yml up -d web

echo "▶ 2/4  Ship the identical image → SRV02 (save | gzip | ssh | load)…"
docker save rxvision-web:latest | gzip -1 \
  | "${SSH[@]}" "$APP_NODE" 'gunzip | docker load && docker tag rxvision-web:latest rxvision-app-web:latest'

echo "▶ 3/4  Recreate SRV02 web from the synced image (NO rebuild)…"
"${SSH[@]}" "$APP_NODE" \
  'docker compose --project-directory /opt/rxvision -f /opt/rxvision/docker-compose.app.yml up -d --no-build --force-recreate web'

echo "▶ 4/4  Verify both nodes serve the SAME build…"
A=$(docker compose -f docker-compose.prod.yml exec -T web cat /app/.next/BUILD_ID)
B=$("${SSH[@]}" "$APP_NODE" 'docker exec rxvision-app-web-1 cat /app/.next/BUILD_ID')
echo "   SRV01 BUILD_ID=$A"
echo "   SRV02 BUILD_ID=$B"
if [ "$A" = "$B" ]; then
  echo "✅ Both nodes serve identical build $A — round-robin safe."
else
  echo "❌ BUILD_ID MISMATCH — clients WILL crash on cross-origin chunk loads. Investigate." >&2
  exit 1
fi
