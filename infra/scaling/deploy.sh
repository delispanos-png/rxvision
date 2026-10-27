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
# Keep in sync with the LB targets: SRV01=10.0.0.5, SRV02=10.0.0.6, SRV03=10.0.0.7 (adopted 2026-07-15).
# ALL app nodes must get the SAME web image in one run, or clients hit cross-node chunk-hash 404s.
# ΔΥΝΑΜΙΚΗ ΛΙΣΤΑ (24/10/2026): η αυτόματη κλιμάκωση προσθέτει/αφαιρεί κόμβους και τους γράφει στο
# /etc/rxvision/app-nodes.list (provision-app-node.sh / remove-app-node.sh). Σταθερή λίστα = ένας
# αυτόματα προστιθέμενος κόμβος δεν θα έπαιρνε ποτέ deploy (παλιός κώδικας + chunk 404).
NODES_LIST=${NODES_LIST:-/etc/rxvision/app-nodes.list}
if [ -s "$NODES_LIST" ]; then
  mapfile -t APP_NODES < <(grep -oE '^10\.0\.0\.[0-9]+' "$NODES_LIST")
else
  APP_NODES=(10.0.0.5 10.0.0.6 10.0.0.7)
fi
[ "${#APP_NODES[@]}" -gt 0 ] || { echo "✖ Κενή λίστα app nodes ($NODES_LIST)"; exit 1; }
# Which tiers to push. api image is shared by api+worker on the app node.
SERVICES="${SERVICES:-api web worker}"

cd "$ROOT"

# ▶ ΦΡΑΓΜΟΣ ΒΑΣΗΣ (24/10/2026) — αν τρέχει η αυτόματη μεταφορά της DB01 (`workers/db_move`), η DB01
# μπορεί να είναι ΣΒΗΣΤΗ· ένα deploy θα σκότωνε τη διεργασία που θα την ξανάναβε. Περιμένουμε.
# Παράκαμψη μόνο αν ξέρεις τι κάνεις: SKIP_DBMOVE_GUARD=1.
if [ "${SKIP_DBMOVE_GUARD:-0}" != "1" ]; then
  MV=$(docker compose -f docker-compose.prod.yml run --rm --no-deps -T api python -c 'exec("import asyncio\nfrom datetime import datetime, timedelta, timezone\nfrom app.core.db import shared_db\nasync def m():\n    d = await shared_db()[\"ops_alerts\"].find_one({\"_id\": \"capacity:db_move\"}) or {}\n    u = d.get(\"updated_at\")\n    fresh = u and datetime.now(timezone.utc) - u.replace(tzinfo=timezone.utc) < timedelta(hours=1)\n    print(\"running\" if d.get(\"status\") == \"running\" and fresh else \"ok\")\nasyncio.run(m())")' 2>/dev/null | tail -1 || true)
  if [ "$MV" = "running" ]; then
    echo "✖ Τρέχει αυτόματη μεταφορά της βάσης DB01 — το ανέβασμα ΣΤΑΜΑΤΑ. Ξαναδοκίμασε σε λίγα λεπτά."
    exit 1
  fi
fi

# ▶ 0/4 ΦΡΑΓΜΟΣ ΠΟΙΟΤΗΤΑΣ — τα ανεβάσματα γίνονται ΑΠΟ ΕΔΩ, όχι από το CI (που τρέχει μόνο στο push),
# οπότε ο έλεγχος πρέπει να ζει εδώ. Lint πραγματικών λαθών + απομόνωση φαρμακείων + όλα τα τεστ.
# Κόκκινο → ΔΕΝ ανεβαίνει τίποτα. Έκτακτη ανάγκη (π.χ. διόρθωση σε κατάρρευση): SKIP_GATE=1.
# Τρέχει στο ΥΠΑΡΧΟΝ image με τον ΝΕΟ κώδικα προσαρτημένο (μόνο ανάγνωση) — δεν αγγίζει παραγωγή.
if [ "${SKIP_GATE:-0}" != "1" ]; then
  echo "▶ 0/4  Φραγμός ποιότητας (lint · απομόνωση · τεστ)…"
  python3 scripts/ci/check_tenant_isolation.py || { echo "✖ Απομόνωση φαρμακείων: ΣΤΑΜΑΤΑ το ανέβασμα."; exit 1; }
  if ! docker run --rm --user root --entrypoint sh -e PYTHONDONTWRITEBYTECODE=1 \
        -v "$ROOT/backend:/src:ro" -v "$ROOT/docs:/docs:ro" -v "$ROOT/frontend:/frontend:ro" -w /src \
        rxvision-api:latest -c 'pip -q install ruff mongomock-motor pytest pytest-asyncio >/dev/null 2>&1 \
          && ruff check --no-cache --select F,E9 app tests \
          && { python -m pytest -q -p no:cacheprovider > /tmp/pytest.log 2>&1; rc=$?; tail -15 /tmp/pytest.log; exit $rc; }'; then
    echo "✖ Ο φραγμός απέτυχε — το ανέβασμα ΣΤΑΜΑΤΑ. (Έκτακτη ανάγκη: SKIP_GATE=1 bash infra/scaling/deploy.sh)"
    exit 1
  fi
fi

# ΜΙΑ ΠΗΓΗ ΑΛΗΘΕΙΑΣ ΓΙΑ ΤΟ ΕΓΧΕΙΡΙΔΙΟ: το γράφουμε στο docs/USER_MANUAL.md και το διαβάζει ο
# πελάτης στη σελίδα /manual. Το `docs/` είναι ΕΚΤΟΣ του build context του web (που είναι
# ./frontend), γι' αυτό αντιγράφεται εδώ — ΠΡΙΝ το build, αλλιώς ανεβαίνει παλιά έκδοση.
cp docs/USER_MANUAL.md frontend/public/user-manual.md
echo "   εγχειρίδιο → frontend/public/user-manual.md ($(wc -l < docs/USER_MANUAL.md) γραμμές)"

echo "▶ 1/4  Build on MGMT01 (single source of truth)…"
# worker/beat build from ./backend too but are SEPARATE images — rebuild them or the
# beat scheduler / workers on MGMT keep stale task code (incident 2026-06-22: new beat task missing).
# NOTE: `optical` lives ONLY on the app nodes (docker-compose.app.yml) since the 2026-07-02 RAM
# rebalance — it is NOT a service in docker-compose.prod.yml, so it must NOT be listed here.
docker compose -f docker-compose.prod.yml build api web worker beat
# keep MGMT's own containers current (build/rollback origin + the beat scheduler lives here).
docker compose -f docker-compose.prod.yml up -d api web worker beat

# ΧΩΡΙΣ 502 (26/10/2026): κάθε κόμβος βγαίνει από τον Load Balancer ΠΡΙΝ ξαναστηθεί και μπαίνει ξανά
# ΜΟΝΟ όταν είναι υγιής. Πριν, ο LB συνέχιζε να του στέλνει ~1/3 της κίνησης για ~30″ → 502 στους
# πελάτες σε κάθε deploy. `lb_target` αρνείται να βγάλει τον τελευταίο υγιή κόμβο. SKIP_LB_DRAIN=1 = παλιά συμπεριφορά.
LB() { docker compose -f docker-compose.prod.yml run --rm --no-deps -T -v "$ROOT/backend/app:/app/app:ro" \
         api python -m app.workers.lb_target "$@" 2>&1 | grep -v -E '^ ?Container ' ; return "${PIPESTATUS[0]}"; }

for NODE in "${APP_NODES[@]}"; do
  # ΕΞΩ ΑΠΟ ΤΟΝ LB ΠΡΙΝ ΑΠΟ ΟΤΙΔΗΠΟΤΕ: το `docker load` (~600MB) μπλοκάρει το DNS του Docker
  # («lookup web: server misbehaving» → 502) και το caddy reload δίνει στιγμιαίο 525 — μετρημένο
  # 26/10/2026 (70×502 + 6×525 όταν η έξοδος γινόταν μετά την αποστολή εικόνων).
  if [ "${SKIP_LB_DRAIN:-0}" != "1" ]; then
    echo "▶ 1b/4  Έξοδος $NODE από τον Load Balancer + 20″ να τελειώσουν τα ανοιχτά αιτήματα…"
    LB remove "$NODE" || { echo "✖ Δεν βγήκε από τον LB (κανένας άλλος υγιής;) — ΣΤΑΜΑΤΑ το deploy για να μη γίνει διακοπή."; exit 1; }
    sleep 5
    # Ο LB κόβει μόνο ΝΕΕΣ συνδέσεις· η Cloudflare κρατά ανοιχτές (keep-alive) και ΣΥΝΕΧΙΖΕΙ να στέλνει
    # σε αυτόν τον κόμβο για λεπτά (μετρημένο 26/10: 66×502 μετά από «επιτυχή» αφαίρεση). Ομαλό σταμάτημα
    # του Caddy: τελειώνει ό,τι τρέχει και κλείνει τις συνδέσεις (GOAWAY) → η Cloudflare ξανασυνδέεται
    # μέσω LB στους υγιείς. Ξεκινά ξανά πριν τον έλεγχο υγείας (βήμα 4b).
    "${SSH[@]}" "root@$NODE" 'docker stop -t 30 rxvision-app-caddy-1 >/dev/null' || true
  fi

  echo "▶ 2/4  Ship images → $NODE (private net)…"
  # api image is shared by ALL backend services: api, worker, AND the app-node-only
  # worker-backfill + optical (docker-compose.app.yml). Tag them ALL or those extra workers
  # keep running stale code — incident 2026-07-13: worker-backfill ran 4-day-old ingest code and
  # re-clobbered corrected retail prices on every sync. See [[profitability-retail-bug]].
  docker save rxvision-api:latest | gzip -1 | "${SSH[@]}" "root@$NODE" \
    'gunzip | docker load && docker tag rxvision-api:latest rxvision-app-api:latest \
       && docker tag rxvision-api:latest rxvision-app-worker:latest \
       && docker tag rxvision-api:latest rxvision-app-worker-backfill:latest \
       && docker tag rxvision-api:latest rxvision-app-worker-sync:latest \
       && docker tag rxvision-api:latest rxvision-app-worker-maint:latest \
       && docker tag rxvision-api:latest rxvision-app-optical:latest'
  docker save rxvision-web:latest | gzip -1 | "${SSH[@]}" "root@$NODE" \
    'gunzip | docker load && docker tag rxvision-web:latest rxvision-app-web:latest'

  # Keep the reverse-proxy config in sync (bind-mounted from the node's checkout). Ships the repo
  # Caddyfile + validates + hot-reloads — so the LB /lb-health probe and routing never drift per node.
  echo "▶ 2b/4  Sync Caddyfile + compose + reload on $NODE…"
  scp -i "$KEY" -o StrictHostKeyChecking=no infra/docker/Caddyfile "root@$NODE:/opt/rxvision/infra/docker/Caddyfile"
  # ΤΟ COMPOSE ΤΩΝ ΚΟΜΒΩΝ ΔΕΝ ΣΥΓΧΡΟΝΙΖΟΤΑΝ ΠΟΤΕ (19/09/2026): κάθε app node έχει ΔΙΚΟ ΤΟΥ
  # αντίγραφο και το `docker compose up` το διαβάζει ΕΚΕΙ. Όταν προστέθηκαν οι νέοι δρόμοι
  # (worker-sync/worker-maint) το deploy έσκασε με «no such service» — ΑΦΟΥ όμως είχε ήδη
  # ανανεωθεί ο beat στο MGMT, που άρχισε να στέλνει σε ουρές που δεν άκουγε κανείς.
  scp -i "$KEY" -o StrictHostKeyChecking=no infra/scaling/docker-compose.app.yml "root@$NODE:$APP_COMPOSE"
  "${SSH[@]}" "root@$NODE" \
    '[ "$(docker inspect -f "{{.State.Running}}" rxvision-app-caddy-1 2>/dev/null)" != true ] && { echo "   caddy σταματημένος (drain) — η νέα ρύθμιση φορτώνει στην εκκίνηση"; exit 0; }; docker exec rxvision-app-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
       && docker exec rxvision-app-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
       && echo "   caddy reloaded" || echo "   ⚠️ caddy validate/reload failed — check config"'

  # Recreate the standard services + any app-node-only extra workers (worker-backfill/optical)
  # that actually exist on THIS node — so they pick up the freshly-tagged image too (see above).
  echo "▶ 3/4  Recreate [$SERVICES +extra workers] on $NODE (no rebuild)…"
  "${SSH[@]}" "root@$NODE" \
    "docker compose --project-directory /opt/rxvision -f $APP_COMPOSE up -d --no-build --force-recreate $SERVICES \
       worker-sync worker-maint \
       \$(for X in worker-backfill optical; do docker ps -a --format '{{.Names}}' | grep -q \"rxvision-app-\$X-1\" && echo \$X; done)"

  echo "▶ 4/4  Verify $NODE serves the SAME web build as MGMT…"
  A=$(docker compose -f docker-compose.prod.yml exec -T web cat /app/.next/BUILD_ID)
  B=$("${SSH[@]}" "root@$NODE" 'docker exec rxvision-app-web-1 cat /app/.next/BUILD_ID')
  echo "   MGMT BUILD_ID=$A"
  echo "   $NODE BUILD_ID=$B"
  [ "$A" = "$B" ] || { echo "❌ BUILD_ID MISMATCH on $NODE — clients would crash. Abort (ο κόμβος ΜΕΝΕΙ εκτός LB)." >&2; exit 1; }
  echo "✅ $NODE on build $A."

  if [ "${SKIP_LB_DRAIN:-0}" != "1" ]; then
    echo "▶ 4b/4  Εκκίνηση Caddy, αναμονή υγείας $NODE και επιστροφή στον Load Balancer…"
    "${SSH[@]}" "root@$NODE" 'docker start rxvision-app-caddy-1 >/dev/null' || true
    for _ in $(seq 1 40); do
      curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve "app.rxvision.gr:443:$NODE" https://app.rxvision.gr/lb-health | grep -q 200 && break
      sleep 3
    done
    LB add "$NODE" || { echo "✖ $NODE δεν έγινε υγιής στον LB — ΣΤΑΜΑΤΑ (οι υπόλοιποι εξυπηρετούν). Έλεγξέ τον."; exit 1; }
  fi
done
echo "✅ Deploy complete to: ${APP_NODES[*]}"

# MGMT is NOT an LB target and no longer serves public traffic (adminpanel/my/app all go via the LB →
# app nodes since 2026-07-03). Keep its web/caddy/worker STOPPED to save ~500MB RAM — the build/rollback
# images stay on disk, and beat (still running on MGMT) dispatches jobs to the app-node workers. We start
# web+worker above only to rebuild them + read the reference BUILD_ID; re-stop them so the saving is durable.
docker compose -f docker-compose.prod.yml stop web caddy worker >/dev/null 2>&1 || true
echo "ℹ️  MGMT web/caddy/worker stopped (RAM saver) — they run only on the app nodes now."
