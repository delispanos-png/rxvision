#!/usr/bin/env bash
# Αφαίρεση app node που πρόσθεσε η ΑΥΤΟΜΑΤΗ ΚΛΙΜΑΚΩΣΗ (24/10/2026). Τρέχει στο MGMT01 μέσω ops-agent
# (type:remove_node, name:<όνομα>). Σειρά: έξω από τον LB → αναμονή να τελειώσουν τα αιτήματα →
# ομαλό σταμάτημα workers (οι εργασίες επιστρέφουν στην ουρά) → διαγραφή server → έξω από τη λίστα deploy.
#
# ΦΡΑΓΜΟΣ: ΠΟΤΕ οι αρχικοί κόμβοι (SRV01-03, MGMT, DB) — τα cx33 είναι σπάνια και δεν ξαναβρίσκονται.
# DRY_RUN=1: ελέγχει τα πάντα, δεν αγγίζει τίποτα.
set -uo pipefail
cd "$(dirname "$0")/../.."

NAME="${NAME:?NAME required}"
PROTECTED="RxVisionSRV01 RxVisionSRV02 RxVisionSRV03 RxVisionMGMT01 RxVisionDB01 RxVisionDB02"
KEY="$(pwd)/infra/scaling/keys/rxvision_data"
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
LB_ID=6614941
CMD_ID="${NODE_CMD_ID:-}"
NODES_LIST=${NODES_LIST:-/etc/rxvision/app-nodes.list}

strip(){ sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
M(){ docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db=db.getSiblingDB('$DB'); $1"; }
TOK=$(M "print((db.platform_settings.findOne({_id:'cloud'})||{}).hetzner_token||'')" 2>/dev/null | tail -1)
[ -n "$TOK" ] && TOK=$(python3 infra/scripts/rxsecret.py "$TOK")
progress(){ echo "[remove] $1"; [ -n "$CMD_ID" ] && M "db.ops_commands.updateOne({_id:ObjectId('$CMD_ID')},{\$set:{result:'$(printf '%s' "$1" | tr -d "'\"" | cut -c1-200)'}})" >/dev/null 2>&1 || true; }
api(){ local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then curl -s -X "$m" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$d" "https://api.hetzner.cloud/v1$p"
  else curl -s -X "$m" -H "Authorization: Bearer $TOK" "https://api.hetzner.cloud/v1$p"; fi; }

case " $PROTECTED " in *" $NAME "*) progress "ΑΡΝΗΣΗ: ο $NAME είναι αρχικός κόμβος — δεν αφαιρείται"; echo "refused $NAME"; exit 1;; esac
case "$NAME" in RxVisionSRV*) ;; *) progress "ΑΡΝΗΣΗ: $NAME δεν είναι app node"; echo "refused $NAME"; exit 1;; esac
[ -z "$TOK" ] && { progress "ΣΦΑΛΜΑ: λείπει Hetzner token"; exit 1; }

read -r SID PIP < <(api GET "/servers?name=$NAME" | python3 -c "import sys,json; s=(json.load(sys.stdin).get('servers') or [{}])[0]; n=s.get('private_net') or [{}]; print(s.get('id',''), n[0].get('ip',''))" 2>/dev/null)
[ -z "${SID:-}" ] && { progress "ΣΦΑΛΜΑ: δεν βρέθηκε server $NAME"; exit 1; }
if [ "${DRY_RUN:-0}" = 1 ]; then progress "DRY_RUN ✓ θα αφαιρούνταν $NAME (id=$SID, priv=$PIP)"; echo "dryrun $NAME"; exit 0; fi

# 1) έξω από τον LB — καμία ΝΕΑ σύνδεση πελάτη
progress "Αφαίρεση $NAME από τον Load Balancer…"
api POST /load_balancers/$LB_ID/actions/remove_target "{\"type\":\"server\",\"server\":{\"id\":$SID}}" >/dev/null 2>&1
# 2) έξω από τη λίστα deploy (ώστε ένα deploy εν τω μεταξύ να μην αποτύχει πάνω του)
[ -f "$NODES_LIST" ] && [ -n "$PIP" ] && sed -i "/^$PIP /d" "$NODES_LIST"
# 3) αναμονή να τελειώσουν τα ανοιχτά αιτήματα + ομαλό σταμάτημα (Celery warm shutdown: οι εργασίες
#    σε εξέλιξη τελειώνουν ή επιστρέφουν στην ουρά — acks_late — και τις παίρνει άλλος κόμβος)
sleep 60
progress "Ομαλό σταμάτημα υπηρεσιών στον $NAME…"
[ -n "$PIP" ] && ssh "${SSHO[@]}" root@$PIP 'cd /opt/rxvision && timeout 600 docker compose -f docker-compose.app.yml stop -t 300' >/dev/null 2>&1 || true
# 4) διαγραφή του server
progress "Διαγραφή server $NAME…"
RES=$(api DELETE /servers/$SID)
ST=$(printf '%s' "$RES" | python3 -c "import sys,json; print((json.load(sys.stdin).get('action') or {}).get('status',''))" 2>/dev/null)
if [ -z "$ST" ]; then progress "ΣΦΑΛΜΑ διαγραφής: $(printf '%s' "$RES" | tr -d '\n' | cut -c1-150)"; echo "delete_failed $NAME"; exit 1; fi
progress "✅ $NAME αφαιρέθηκε (εκτός LB, σταματημένος, διαγραμμένος)"
echo "removed $NAME"
