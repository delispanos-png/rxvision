#!/usr/bin/env bash
# Provision a NEW RxVision app node and attach it to the Hetzner LB. Runs on SRV01 (has the deploy
# key, repo, .env and Hetzner token). Triggered semi-automatically from the admin panel via the
# ops-agent (type:add_node). Writes step-by-step progress to the ops_commands doc (NODE_CMD_ID).
# DRY_RUN=1 validates everything but does NOT create a server.
set -uo pipefail
cd "$(dirname "$0")/../.."

KEY="$(pwd)/infra/scaling/keys/rxvision_data"
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
NET_ID=12315100; LB_ID=6614941; SSHKEY_ID=113542635; FW_APP_ID=11113679
SRV_TYPE=ccx13; LOCATION=hel1; IMAGE=ubuntu-22.04
CMD_ID="${NODE_CMD_ID:-}"

strip(){ sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
M(){ docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db=db.getSiblingDB('$DB'); $1"; }
TOK=$(M "print((db.platform_settings.findOne({_id:'cloud'})||{}).hetzner_token||'')" 2>/dev/null | tail -1)
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

# 5) sync code + .env (Vault→10.0.0.2, NODE_NAME=this node) + app compose
progress "Συγχρονισμός κώδικα & ρυθμίσεων → $NAME…"
ssh "${SSHO[@]}" root@$PIP 'mkdir -p /opt/rxvision' 2>/dev/null
rsync -az -e "ssh ${SSHO[*]}" --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='__pycache__' --exclude='backups' --exclude='*.archive.gz' --exclude='.env' /opt/rxvision/ root@$PIP:/opt/rxvision/ >/dev/null 2>&1
scp "${SSHO[@]}" .env root@$PIP:/opt/rxvision/.env >/dev/null 2>&1
ssh "${SSHO[@]}" root@$PIP "sed -i 's#^VAULT_ADDR=.*#VAULT_ADDR=http://10.0.0.2:8200#' /opt/rxvision/.env; sed -i 's#^NODE_NAME=.*#NODE_NAME=$NAME#' /opt/rxvision/.env; cp /opt/rxvision/infra/scaling/docker-compose.app.yml /opt/rxvision/docker-compose.app.yml" 2>/dev/null

# 6) build api/worker on node + ship the IDENTICAL web image from SRV01, then start
progress "Build api/worker + αποστολή web image (ίδιο build)…"
ssh "${SSHO[@]}" root@$PIP 'cd /opt/rxvision && docker compose -f docker-compose.app.yml build api worker' >/dev/null 2>&1
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

# 8) attach to the Load Balancer (private IP)
progress "Σύνδεση $NAME στον Load Balancer…"
api POST /load_balancers/$LB_ID/actions/add_target "{\"type\":\"server\",\"server\":{\"id\":$SID},\"use_private_ip\":true}" >/dev/null 2>&1

# 9) verify
sleep 10
HOK=$(ssh "${SSHO[@]}" root@$PIP 'docker exec rxvision-app-caddy-1 wget -qO- http://api:8000/api/v1/health 2>/dev/null | head -c 3' 2>/dev/null || echo "?")
progress "✅ $NAME έτοιμος & συνδεδεμένος στον LB (pub=$PUB, priv=$PIP)"
echo "done $NAME priv=$PIP"
