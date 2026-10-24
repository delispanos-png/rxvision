#!/usr/bin/env bash
# Provision a NEW RxVision app node and attach it to the Hetzner LB. Runs on MGMT01 (build host: has
# the deploy key, repo, .env, Hetzner token and the current images). Triggered via the ops-agent
# (type:add_node) — from the admin panel OR from the autoscaler (`workers/capacity.py`).
# Writes step-by-step progress to the ops_commands doc (NODE_CMD_ID).
# DRY_RUN=1 validates everything but does NOT create a server.
# SKIP_LB=1 creates & starts the node but does NOT attach it to the LB (end-to-end test).
# On success the private IP is appended to $NODES_LIST, which deploy.sh reads — otherwise the new
# node would never receive later deploys (stale code + cross-node chunk 404s).
set -uo pipefail
cd "$(dirname "$0")/../.."

KEY="$(pwd)/infra/scaling/keys/rxvision_data"
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
NET_ID=12315100; LB_ID=6614941; SSHKEY_ID=113542635; FW_APP_ID=11113679
SRV_TYPE=${SRV_TYPE:-ccx13}; LOCATION=${LOCATION:-hel1}; IMAGE=${IMAGE:-ubuntu-22.04}
CMD_ID="${NODE_CMD_ID:-}"
NODES_LIST=${NODES_LIST:-/etc/rxvision/app-nodes.list}

strip(){ sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
M(){ docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db=db.getSiblingDB('$DB'); $1"; }
TOK=$(M "print((db.platform_settings.findOne({_id:'cloud'})||{}).hetzner_token||'')" 2>/dev/null | tail -1)
[ -n "$TOK" ] && TOK=$(python3 infra/scripts/rxsecret.py "$TOK")   # decrypt Hetzner token (enc:v1:)
progress(){ echo "[provision] $1"; [ -n "$CMD_ID" ] && M "db.ops_commands.updateOne({_id:ObjectId('$CMD_ID')},{\$set:{result:'$(printf '%s' "$1" | tr -d "'\"" | cut -c1-200)'}})" >/dev/null 2>&1 || true; }
api(){ local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then curl -s -X "$m" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$d" "https://api.hetzner.cloud/v1$p"
  else curl -s -X "$m" -H "Authorization: Bearer $TOK" "https://api.hetzner.cloud/v1$p"; fi; }

[ -z "$TOK" ] && { progress "ΣΦΑΛΜΑ: λείπει Hetzner token"; exit 1; }

# 1) next node number
EXIST=$(api GET /servers | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(s['name'] for s in d.get('servers',[])))" 2>/dev/null)
N=$(printf '%s\n' "$EXIST" | grep -oE 'RxVisionSRV0[0-9]+' | grep -oE '[0-9]+$' | sort -n | tail -1)
N=$(( ${N:-2} + 1 )); NAME="RxVisionSRV0$N"
progress "Προετοιμασία $NAME ($SRV_TYPE / $LOCATION)…"

if [ "${DRY_RUN:-0}" = 1 ]; then progress "DRY_RUN ✓ token OK, επόμενος κόμβος = $NAME (δεν δημιουργήθηκε)"; echo "dryrun $NAME"; exit 0; fi

# 2) create server (cloud-init installs docker)
CI=$'#cloud-config\nruncmd:\n  - curl -fsSL https://get.docker.com | sh\n'
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'name':sys.argv[1],'server_type':'$SRV_TYPE','location':'$LOCATION','image':'$IMAGE','ssh_keys':[$SSHKEY_ID],'networks':[$NET_ID],'firewalls':[{'firewall':$FW_APP_ID}],'user_data':sys.argv[2]}))" "$NAME" "$CI")
RES=$(api POST /servers "$PAYLOAD")
SID=$(printf '%s' "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('server',{}).get('id',''))" 2>/dev/null)
[ -z "$SID" ] && { progress "ΣΦΑΛΜΑ create: $(printf '%s' "$RES" | tr -d '\n' | cut -c1-150)"; exit 1; }
progress "Δημιουργήθηκε $NAME (id=$SID) — αναμονή εκκίνησης…"

# 3) poll running + IPs
PUB=""; PIP=""
for _ in $(seq 1 60); do
  J=$(api GET /servers/$SID)
  read -r ST PUB PIP < <(printf '%s' "$J" | python3 -c "import sys,json;s=json.load(sys.stdin)['server'];n=s.get('private_net',[]);print(s['status'], s['public_net']['ipv4']['ip'], (n[0]['ip'] if n else ''))" 2>/dev/null)
  [ "$ST" = running ] && [ -n "$PIP" ] && break
  sleep 5
done
progress "$NAME up (pub=$PUB priv=$PIP) — αναμονή Docker (cloud-init)…"

# 4) wait for SSH + docker
for _ in $(seq 1 72); do ssh "${SSHO[@]}" root@$PIP 'command -v docker >/dev/null 2>&1' 2>/dev/null && break; sleep 10; done

# 4b) Docker log rotation + cron backstop — ΠΡΙΝ ξεκινήσουν containers, ώστε κάθε νέος node να έχει
# φραγμένα logs από την αρχή (χωρίς αυτό, τα container logs φουσκώνουν ασταμάτητα, βλ. DB01 24GB).
ssh "${SSHO[@]}" root@$PIP 'mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<JSON
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
JSON
printf "0 4 * * * root find /var/lib/docker/containers -name '"'"'*-json.log'"'"' -size +50M -exec truncate -s 0 {} \\; >/dev/null 2>&1\n" > /etc/cron.d/rxvision-log-trim
systemctl restart docker' 2>/dev/null

# 5) sync code + .env (Vault→10.0.0.2, NODE_NAME=this node) + app compose
progress "Συγχρονισμός κώδικα & ρυθμίσεων → $NAME…"
ssh "${SSHO[@]}" root@$PIP 'mkdir -p /opt/rxvision' 2>/dev/null
rsync -az -e "ssh ${SSHO[*]}" --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='__pycache__' --exclude='backups' --exclude='*.archive.gz' --exclude='.env' /opt/rxvision/ root@$PIP:/opt/rxvision/ >/dev/null 2>&1
scp "${SSHO[@]}" .env root@$PIP:/opt/rxvision/.env >/dev/null 2>&1
# Vault over TLS (H-3): https + CA cert (SAN includes IP:10.0.0.2). The cert file is rsynced above
# (infra/docker/vault/tls/vault.crt); the app.yml mounts it into every backend service.
ssh "${SSHO[@]}" root@$PIP "sed -i 's#^VAULT_ADDR=.*#VAULT_ADDR=https://10.0.0.2:8200#' /opt/rxvision/.env; grep -qE '^VAULT_CACERT=' /opt/rxvision/.env && sed -i 's#^VAULT_CACERT=.*#VAULT_CACERT=/vault/tls/vault.crt#' /opt/rxvision/.env || echo 'VAULT_CACERT=/vault/tls/vault.crt' >> /opt/rxvision/.env; sed -i 's#^NODE_NAME=.*#NODE_NAME=$NAME#' /opt/rxvision/.env; cp /opt/rxvision/infra/scaling/docker-compose.app.yml /opt/rxvision/docker-compose.app.yml" 2>/dev/null

# 5b) Cloudflare ORIGIN certificate: ζει στον τόμο δεδομένων του Caddy κάθε κόμβου (/data/origin.*),
#     ΟΧΙ στο repo. Χωρίς αυτό ο Caddy δεν ξεκινά (`open /data/origin.pem`) — βρέθηκε στη δοκιμή
#     24/10/2026. Αντιγραφή από υπάρχοντα app node, απευθείας μέσω ιδιωτικού δικτύου (tar stream).
CERT_SRC=${CERT_SRC:-10.0.0.5}
progress "Αντιγραφή πιστοποιητικού Cloudflare Origin από $CERT_SRC…"
# 3 προσπάθειες: ο docker του νέου κόμβου μόλις έκανε restart (βήμα 4b) — 1η δοκιμή 24/10 απέτυχε εκεί.
CERT_OK=0
for _ in 1 2 3; do
  sleep 10
  ssh "${SSHO[@]}" root@$CERT_SRC 'docker exec rxvision-app-caddy-1 tar -C /data -cf - origin.pem origin.key' 2>/dev/null \
    | ssh "${SSHO[@]}" root@$PIP 'docker volume create rxvision-app_caddy_data >/dev/null && tar -C /var/lib/docker/volumes/rxvision-app_caddy_data/_data -xf - && chmod 600 /var/lib/docker/volumes/rxvision-app_caddy_data/_data/origin.key' 2>/dev/null
  ssh "${SSHO[@]}" root@$PIP 'test -s /var/lib/docker/volumes/rxvision-app_caddy_data/_data/origin.pem && test -s /var/lib/docker/volumes/rxvision-app_caddy_data/_data/origin.key' 2>/dev/null && { CERT_OK=1; break; }
done
[ "$CERT_OK" = 1 ] || { progress "ΣΦΑΛΜΑ: δεν αντιγράφηκε το πιστοποιητικό Origin από $CERT_SRC"; echo "nocert $NAME id=$SID priv=$PIP"; exit 1; }

# 6) ship the IDENTICAL images that deploy.sh ships (built once on MGMT) — NOT a local build: a
#    node-built image differs from the others (code drift, different web chunk hashes). Same tags
#    as deploy.sh so every backend service runs the same image.
progress "Αποστολή εικόνων api/web (ίδιο build με τους άλλους κόμβους)…"
docker save rxvision-api:latest | gzip -1 | ssh "${SSHO[@]}" root@$PIP \
  'gunzip | docker load && for t in api worker worker-backfill worker-sync worker-maint optical; do docker tag rxvision-api:latest rxvision-app-$t:latest; done' >/dev/null 2>&1
docker save rxvision-web:latest | gzip -1 | ssh "${SSHO[@]}" root@$PIP 'gunzip | docker load && docker tag rxvision-web:latest rxvision-app-web:latest' >/dev/null 2>&1
ssh "${SSHO[@]}" root@$PIP 'cd /opt/rxvision && docker compose -f docker-compose.app.yml up -d --no-build' >/dev/null 2>&1

# 7) install ops-agent (metrics come from the api via NODE_NAME)
ssh "${SSHO[@]}" root@$PIP "chmod +x /opt/rxvision/infra/scripts/ops-agent.sh; cat > /etc/systemd/system/rxvision-ops.service <<U
[Unit]
After=docker.service
Requires=docker.service
[Service]
Environment=NODE=$NAME
ExecStart=/opt/rxvision/infra/scripts/ops-agent.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload && systemctl enable --now rxvision-ops.service" 2>/dev/null

# 8) verify the app answers BEFORE it gets customer traffic
HOK=""
for _ in $(seq 1 30); do
  HOK=$(ssh "${SSHO[@]}" root@$PIP 'docker exec rxvision-app-caddy-1 wget -qO- http://api:8000/health 2>/dev/null | head -c 200' 2>/dev/null || true)
  printf '%s' "$HOK" | grep -q '"status":"ok"' && break
  sleep 10
done
if ! printf '%s' "$HOK" | grep -q '"status":"ok"'; then
  progress "ΣΦΑΛΜΑ: $NAME δεν απαντά στο /health — ΔΕΝ μπήκε στον LB (id=$SID, priv=$PIP)"
  echo "unhealthy $NAME id=$SID priv=$PIP"; exit 1
fi

# 9) register for deploy.sh (so later deploys reach it) — before the LB, so no window exists where
#    it serves traffic but would be skipped by a deploy
mkdir -p "$(dirname "$NODES_LIST")"
[ -f "$NODES_LIST" ] || printf '10.0.0.5  # RxVisionSRV01\n10.0.0.6  # RxVisionSRV02\n10.0.0.7  # RxVisionSRV03\n' > "$NODES_LIST"
grep -q "^$PIP " "$NODES_LIST" || printf '%s  # %s\n' "$PIP" "$NAME" >> "$NODES_LIST"

# 10) attach to the Load Balancer (private IP) — unless this is an end-to-end test
if [ "${SKIP_LB:-0}" = 1 ]; then
  progress "✅ $NAME έτοιμος (SKIP_LB: εκτός Load Balancer) priv=$PIP"
  echo "done $NAME priv=$PIP id=$SID nolb"; exit 0
fi
progress "Σύνδεση $NAME στον Load Balancer…"
api POST /load_balancers/$LB_ID/actions/add_target "{\"type\":\"server\",\"server\":{\"id\":$SID},\"use_private_ip\":true}" >/dev/null 2>&1
progress "✅ $NAME έτοιμος & συνδεδεμένος στον LB (pub=$PUB, priv=$PIP)"
echo "done $NAME priv=$PIP id=$SID"
