#!/usr/bin/env bash
# Adopt an EXISTING Hetzner server into RxVision production (no purchase — you already bought it).
# Runs on MGMT01. Mirrors provision-app-node.sh steps 5-9 but SKIPS create/poll: the server exists.
#
# WHEN: you bought a specific server manually (type/location of your choice) and want it live,
#       instead of letting the auto-provisioner buy a fixed ccx13.
#
# PREREQUISITES (do these first — the script checks and stops if missing):
#   1. The server is a Hetzner server in your project (you have its numeric id).
#   2. Our public key is in the server's /root/.ssh/authorized_keys:
#        ssh-keygen -y -f infra/scaling/keys/rxvision_data   # prints the key to add
#   3. The Hetzner token is stored (Admin → Υποδομή/Cloud) — same one the auto-provisioner uses.
#
# USAGE:  bash infra/scaling/adopt-node.sh <HETZNER_SERVER_ID>
#         DRY_RUN=1 bash infra/scaling/adopt-node.sh <id>   # checks only, changes nothing
set -uo pipefail
cd "$(dirname "$0")/../.."

SID="${1:?δώσε το Hetzner server id (π.χ. 151514259)}"
KEY="$(pwd)/infra/scaling/keys/rxvision_data"
SSHO=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
NET_ID=12315100; LB_ID=6614941; FW_APP_ID=11113679
VAULT_ADDR=https://10.0.0.2:8200; DATA_IP=10.0.0.3

strip(){ sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
M(){ docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db=db.getSiblingDB('$DB'); $1"; }
TOK=$(M "print((db.platform_settings.findOne({_id:'cloud'})||{}).hetzner_token||'')" 2>/dev/null | tail -1)
[ -n "$TOK" ] && TOK=$(python3 infra/scripts/rxsecret.py "$TOK")
[ -z "$TOK" ] && { echo "✗ λείπει Hetzner token (Admin → Υποδομή/Cloud)"; exit 1; }
api(){ local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then curl -s -X "$m" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$d" "https://api.hetzner.cloud/v1$p"
  else curl -s -X "$m" -H "Authorization: Bearer $TOK" "https://api.hetzner.cloud/v1$p"; fi; }
jq_py(){ python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

# ── 0) fetch server, ensure it's on the private network (attach with next free 10.0.0.N if not) ──
J=$(api GET /servers/$SID); NAME=$(printf '%s' "$J" | jq_py "d['server']['name']")
[ -z "$NAME" ] && { echo "✗ δεν βρέθηκε server id=$SID"; exit 1; }
PRIV=$(printf '%s' "$J" | jq_py "(d['server'].get('private_net') or [{}])[0].get('ip','')")
echo "▶ Adopt «$NAME» (id=$SID) — private=${PRIV:-—}"

if [ -z "$PRIV" ]; then
  USED=$(api GET /servers | jq_py "sorted(int((s.get('private_net') or [{}])[0].get('ip','0.0.0.0').split('.')[-1]) for s in d['servers'] if (s.get('private_net') or []))" )
  NEXT=$(python3 -c "u=set($USED); n=4
while n in u: n+=1
print(f'10.0.0.{n}')")
  echo "  → attach στο private network ως $NEXT"
  [ "${DRY_RUN:-0}" = 1 ] || api POST /servers/$SID/actions/attach_to_network "{\"network\":$NET_ID,\"ip\":\"$NEXT\"}" >/dev/null
  PRIV=$NEXT; sleep 6
fi
[ "${DRY_RUN:-0}" = 1 ] && { echo "DRY_RUN ✓ token OK, server=$NAME, private=$PRIV (δεν άλλαξε τίποτα)"; exit 0; }

# ── 1) preflight: SSH via private + can reach DB (proves it's really on the net) ──
ssh "${SSHO[@]}" root@$PRIV true 2>/dev/null || {
  echo "✗ Δεν έχω SSH στο $PRIV. Βάλε το public key μας στον server:"; ssh-keygen -y -f "$KEY"; exit 1; }
ssh "${SSHO[@]}" root@$PRIV "timeout 5 bash -c '</dev/tcp/$DATA_IP/27017'" 2>/dev/null || {
  echo "✗ Ο $PRIV δεν βλέπει τον DB ($DATA_IP) — έλεγξε το private interface (enp7s0/DHCP)."; exit 1; }
echo "  ✓ SSH + βλέπει DB"

# ── 2) hostname + docker ──
ssh "${SSHO[@]}" root@$PRIV "hostnamectl set-hostname $NAME; command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh" >/dev/null 2>&1
echo "  ✓ hostname=$NAME + docker"

# ── 3) sync code + .env (Vault over TLS, NODE_NAME) + app compose ──
ssh "${SSHO[@]}" root@$PRIV 'mkdir -p /opt/rxvision'
rsync -az --delete -e "ssh ${SSHO[*]}" --exclude='.git' --exclude='node_modules' --exclude='.next' \
  --exclude='__pycache__' --exclude='backups' --exclude='*.archive.gz' --exclude='infra/scaling/keys' \
  --exclude='.env' /opt/rxvision/ root@$PRIV:/opt/rxvision/ >/dev/null
scp "${SSHO[@]}" .env root@$PRIV:/opt/rxvision/.env >/dev/null
ssh "${SSHO[@]}" root@$PRIV "cd /opt/rxvision
  sed -i 's#^VAULT_ADDR=.*#VAULT_ADDR=$VAULT_ADDR#' .env
  grep -qE '^VAULT_CACERT=' .env && sed -i 's#^VAULT_CACERT=.*#VAULT_CACERT=/vault/tls/vault.crt#' .env || echo 'VAULT_CACERT=/vault/tls/vault.crt' >> .env
  grep -qE '^NODE_NAME=' .env && sed -i 's#^NODE_NAME=.*#NODE_NAME=$NAME#' .env || echo 'NODE_NAME=$NAME' >> .env
  cp infra/scaling/docker-compose.app.yml docker-compose.app.yml"
echo "  ✓ κώδικας + .env"

# ── 4) build backend on node + ship the IDENTICAL web image (NEVER build web on a node) ──
CO="docker compose --project-directory /opt/rxvision -f /opt/rxvision/docker-compose.app.yml"
ssh "${SSHO[@]}" root@$PRIV "$CO build api worker worker-backfill optical" >/dev/null 2>&1
docker save rxvision-web:latest | gzip -1 | ssh "${SSHO[@]}" root@$PRIV \
  'gunzip | docker load && docker tag rxvision-web:latest rxvision-app-web:latest' >/dev/null 2>&1
ssh "${SSHO[@]}" root@$PRIV "$CO up -d --no-build" >/dev/null 2>&1
echo "  ✓ υπηρεσίες up"

# ── 5) ops-agent (metrics + host-ops) ──
ssh "${SSHO[@]}" root@$PRIV "chmod +x /opt/rxvision/infra/scripts/ops-agent.sh; cat > /etc/systemd/system/rxvision-ops.service <<U
[Unit]
After=docker.service
Requires=docker.service
[Service]
WorkingDirectory=/opt/rxvision
Environment=NODE=$NAME
ExecStart=/opt/rxvision/infra/scripts/ops-agent.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload && systemctl enable --now rxvision-ops.service" 2>/dev/null
echo "  ✓ ops-agent"

# ── 6) firewall (closes public SSH → MGMT-only) + attach to LB (private IP) ──
api POST /firewalls/$FW_APP_ID/actions/apply_to_resources "{\"apply_to\":[{\"type\":\"server\",\"server\":{\"id\":$SID}}]}" >/dev/null
api POST /load_balancers/$LB_ID/actions/add_target "{\"type\":\"server\",\"server\":{\"id\":$SID},\"use_private_ip\":true}" >/dev/null
echo "  ✓ firewall + LB"

# ── 7) verify ──
sleep 8
H=$(ssh "${SSHO[@]}" root@$PRIV 'docker exec rxvision-app-api-1 python -c "import urllib.request as u;print(u.urlopen(\"http://127.0.0.1:8000/health\",timeout=5).status)"' 2>/dev/null)
echo
echo "✅ «$NAME» εντάχθηκε (private=$PRIV, api/health=$H, στον LB)."
echo "⚠️  ΤΕΛΕΥΤΑΙΟ ΒΗΜΑ (χειροκίνητο): πρόσθεσε το $PRIV στο APP_NODES στο infra/scaling/deploy.sh"
echo "    ώστε τα επόμενα deploys να ενημερώνουν κι αυτόν τον κόμβο."
