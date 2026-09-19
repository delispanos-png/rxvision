#!/usr/bin/env bash
# Host ops-agent: polls the ops_commands collection for work targeted at this node and runs it
# on the host (docker prune / backup). The internet-facing api only ENQUEUES commands — it never
# touches docker or SSH. NODE is set by the systemd unit. Results are written back to Mongo.
set -uo pipefail
cd "$(dirname "$0")/../.."
NODE="${NODE:?NODE env required}"

strip() { sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
# ΣΠΑΝΙΕΣ κλήσεις (ανάγνωση ρυθμίσεων, γράψιμο αποτελέσματος): σηκώνουν δικό τους container.
M() { docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db = db.getSiblingDB('$DB'); $1"; }
jget() { python3 -c "import sys,json; d=sys.stdin.read().strip(); print(json.loads(d).get('$1','') if d else '')" 2>/dev/null; }

# ── ΤΟ ΕΡΩΤΗΜΑ ΤΟΥ ΒΡΟΧΟΥ ─────────────────────────────────────────────────────────────────
# ΤΙ ΔΙΟΡΘΩΝΕΙ (19/09/2026): ο βρόχος καλούσε την `M()`, δηλαδή σήκωνε ΟΛΟΚΛΗΡΟ container
# `mongo:7` κάθε 8 δευτερόλεπτα — δημιουργία container + 2 volumes + δίκτυο + εκκίνηση +
# τερματισμός + καταστροφή, ~10.800 φορές την ημέρα ΑΝΑ ΚΟΜΒΟ. Ο `dockerd` έτρεχε μόνιμα στο
# 100-190% CPU σε τρεις servers χωρίς να είναι κανείς συνδεδεμένος.
# Τώρα το ίδιο ερώτημα γίνεται με `docker exec` μέσα στο API container που ΗΔΗ τρέχει και έχει
# και τη σύνδεση και τα credentials. Καμία δημιουργία container.
API_CT="${API_CT:-rxvision-app-api-1}"

POLL() {
  docker exec -i -e OPS_NODE="$NODE" "$API_CT" python - <<'PYEOF' 2>/dev/null
import json, os
from datetime import datetime, timezone
from pymongo import MongoClient, ReturnDocument
cli = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=4000)
db = cli[os.environ.get("MONGODB_DB", "rxvision")]
c = db.ops_commands.find_one_and_update(
    {"status": "pending", "node": os.environ["OPS_NODE"]},
    {"$set": {"status": "running", "started_at": datetime.now(tz=timezone.utc)}},
    return_document=ReturnDocument.AFTER)
print(json.dumps({"id": str(c["_id"]), "type": c.get("type", ""), "file": c.get("file", ""),
                  "server_type": c.get("server_type", ""), "location": c.get("location", "")})
      if c else "")
PYEOF
}

# ── ΔΙΚΛΕΙΔΑ ΑΣΦΑΛΕΙΑΣ ΤΟΥ ΚΟΜΒΟΥ ────────────────────────────────────────────────────────────
# ΓΙΑΤΙ ΥΠΑΡΧΕΙ (19/09/2026): τρεις servers έκαιγαν CPU επί 30 ημέρες χωρίς να το δει κανείς.
# Δύο αιτίες: (α) ο ίδιος ο agent γεννούσε container κάθε 8΄΄, (β) εντολές `docker logs` που
# ξέμειναν ανοιχτές 13 μέρες και ο dockerd τις σέρβιρε ασταμάτητα. Και τα δύο ήταν ΟΡΑΤΑ από
# τον host — απλώς κανείς δεν κοιτούσε. Τώρα κοιτάει ο ίδιος ο κόμβος, κάθε 5 λεπτά.
SELFCHECK_EVERY=$(( 5 * 60 / 8 ))     # ~κάθε 5 λεπτά (ο βρόχος κάνει sleep 8)
ORPHAN_AGE=3600                        # ροή docker ανοιχτή >1 ώρα = ξεχασμένη

host_selfcheck() {
  # 1) Ορφανές ΡΟΕΣ docker. ΜΟΝΟ logs/events/stats/attach — είναι read-only και το κλείσιμό
  #    τους δεν μπορεί να χαλάσει τίποτα. Το `exec` ΔΕΝ μπαίνει εδώ επίτηδες: το χρησιμοποιεί
  #    ο ίδιος ο agent και μπορεί να τρέχει μια νόμιμη μακρά εργασία (migration).
  local orphans killed=0 pid
  orphans=$(ps -eo pid,etimes,cmd --no-headers 2>/dev/null             | awk -v a="$ORPHAN_AGE" '$2>a'             | grep -E "docker (logs|events|stats|attach)" | grep -v grep || true)
  if [ -n "$orphans" ]; then
    while read -r pid _; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null && killed=$((killed+1))
    done <<< "$orphans"
  fi

  # 2) CPU του dockerd — ΣΩΣΤΟΣ τύπος: ticks / (CLK_TCK × δευτερόλεπτα) × 100.
  #    (Λάθος διαίρεση δίνει νούμερα 100× μεγαλύτερα και στέλνει σε κυνήγι φαντασμάτων.)
  local dp a b hz
  dp=$(pgrep -x dockerd | head -1); hz=$(getconf CLK_TCK)
  a=$(awk '{print $14+$15}' "/proc/$dp/stat" 2>/dev/null || echo 0)
  sleep 3
  b=$(awk '{print $14+$15}' "/proc/$dp/stat" 2>/dev/null || echo 0)
  local dcpu; dcpu=$(awk -v d=$((b-a)) -v hz="$hz" 'BEGIN{printf "%.1f", 100*(d/hz)/3}')

  # 3) Ρυθμός γέννησης container — ο καταιγισμός που μας έκαψε ήταν ακριβώς αυτό.
  # ΠΡΟΣΟΧΗ: `grep -c … || echo 0` τυπώνει ΔΥΟ μηδενικά (το «0» του grep ΚΑΙ το echo) — η
  # τιμή γίνεται "0\n0", το int() σκάει και η εγγραφή χάνεται ΣΙΩΠΗΛΑ. Το `|| true` κρατά
  # μόνο το «0» του grep.
  local churn; churn=$( { timeout 12 docker events --since 0s --until 10s 2>/dev/null || true; } | grep -c "container create" || true )

  local zomb; zomb=$(ps -eo stat --no-headers 2>/dev/null | grep -c '^Z' || true)
  churn=$(printf "%s" "${churn:-0}" | head -1); zomb=$(printf "%s" "${zomb:-0}" | head -1)
  local load1; load1=$(cut -d" " -f1 /proc/loadavg)
  local cores; cores=$(nproc)

  docker exec -i     -e H_NODE="$NODE" -e H_ORPH="$killed" -e H_DCPU="$dcpu" -e H_CHURN="$churn"     -e H_ZOMB="$zomb" -e H_LOAD="$load1" -e H_CORES="$cores"     "$API_CT" python - <<'PYEOF' 2>&1 | head -3
import os
from datetime import datetime, timezone
from pymongo import MongoClient
cli = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=4000)
db = cli[os.environ.get("MONGODB_DB", "rxvision")]
node = os.environ["H_NODE"]
killed = int(os.environ.get("H_ORPH") or 0)
doc = {
    "node": node, "at": datetime.now(tz=timezone.utc),
    "dockerd_cpu": float(os.environ.get("H_DCPU") or 0),
    "container_churn_10s": int(os.environ.get("H_CHURN") or 0),
    "zombies": int(os.environ.get("H_ZOMB") or 0),
    "load1": float(os.environ.get("H_LOAD") or 0),
    "cores": int(os.environ.get("H_CORES") or 1),
    "orphans_killed": killed,
}
db.node_health.update_one({"_id": node}, {"$set": doc}, upsert=True)
# Η αυτοδιόρθωση καταγράφεται ΠΑΝΤΑ: μια σιωπηλή θεραπεία κρύβει ότι το πρόβλημα επανέρχεται.
if killed:
    db.node_health_events.insert_one({**doc, "kind": "orphans_killed"})
PYEOF
}

LOOPS=0
while true; do
  LOOPS=$((LOOPS+1))
  if [ $((LOOPS % SELFCHECK_EVERY)) -eq 1 ]; then host_selfcheck || true; fi
  # Το API container μπορεί να λείπει στιγμιαία (deploy) → περίμενε, ΜΗΝ γυρίσεις στο παλιό
  # ακριβό μονοπάτι· αλλιώς ένα μεγάλο deploy θα ξανάφερνε τον καταιγισμό container.
  if ! docker inspect -f '{{.State.Running}}' "$API_CT" 2>/dev/null | grep -q true; then
    sleep 30; continue
  fi
  CMD=$(POLL | tail -1)
  ID=$(printf '%s' "$CMD" | jget id); TYPE=$(printf '%s' "$CMD" | jget type); FILE=$(printf '%s' "$CMD" | jget file)
  STY=$(printf '%s' "$CMD" | jget server_type); LOC=$(printf '%s' "$CMD" | jget location)
  if [ -n "$ID" ]; then
    case "$TYPE" in
      prune)    OUT=$( {
                  # -af (ΟΛΟ το build cache): με σκέτο -f ο build node (MGMT) ανακτά 0B γιατί το cache
                  # θεωρείται «πρόσφατα σε χρήση». Καθαρίζουμε ΚΑΙ container logs + journald (οι άλλοι όγκοι).
                  docker builder prune -af
                  docker image prune -f
                  journalctl --vacuum-size=200M 2>/dev/null || true
                  LB=$(du -cb /var/lib/docker/containers/*/*-json.log 2>/dev/null | tail -1 | cut -f1)
                  for f in /var/lib/docker/containers/*/*-json.log; do : > "$f" 2>/dev/null || true; done
                  [ -n "${LB:-}" ] && [ "${LB:-0}" -gt 0 ] && echo "container logs cleared ($((LB/1024/1024))MB)"
                } 2>&1 | grep -iE 'reclaimed|freed|cleared' | paste -sd'; ' );;
      backup)   OUT=$(bash infra/scripts/mongo-backup.sh 2>&1 | tail -1);;
      add_node) OUT=$(NODE_CMD_ID="$ID" SRV_TYPE="${STY:-ccx13}" LOCATION="${LOC:-hel1}" bash infra/scripts/provision-app-node.sh 2>&1 | tail -1);;
      restore)
        if [[ "$FILE" =~ ^rxvision-[A-Za-z0-9._-]+\.archive\.gz$ ]]; then
          dl=false
          if [ ! -e "backups/$FILE" ]; then           # offsite-only: fetch the archive from the box
            CFG=$(M "print(JSON.stringify(db.platform_settings.findOne({_id:'cloud'})||{}))" 2>/dev/null | tail -1)
            read -r SH SU SP SPATH < <(python3 -c "import json,sys; c=json.loads(sys.argv[1] or '{}'); print(c.get('storage_host','-') or '-', c.get('storage_user','-') or '-', c.get('storage_password','-') or '-', (c.get('storage_path','/') or '/'))" "$CFG")
            [ "$SP" != "-" ] && SP=$(python3 infra/scripts/rxsecret.py "$SP")   # decrypt storage password
            REL="${SPATH#/}"; [ -z "$REL" ] && REL="."
            mkdir -p backups
            printf 'get %s/%s backups/%s\nbye\n' "$REL" "$FILE" "$FILE" | sshpass -p "$SP" sftp -P 23 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SU@$SH" >/dev/null 2>&1 || true
            dl=true
          fi
          if [ -e "backups/$FILE" ]; then
            OUT=$(docker run --rm --network host -v "$(pwd)/backups:/b:ro" mongo:7 \
                    mongorestore --uri "$URI" --archive="/b/$FILE" --gzip --drop 2>&1 | tail -1)
            OUT="restored $FILE — $OUT"
            [ "$dl" = true ] && rm -f "backups/$FILE"   # remove the temp download (stay offsite-only)
          else OUT="could not fetch backup file: $FILE"; fi
        else OUT="invalid backup file: $FILE"; fi
        ;;
      *)      OUT="unknown command type";;
    esac
    OUT=$(printf '%s' "${OUT:-done}" | tr -d "'\"" | cut -c1-300)
    M "db.ops_commands.updateOne({_id:ObjectId('$ID')},{\$set:{status:'done',result:'$OUT',finished_at:new Date()}})" >/dev/null 2>&1
  fi
  sleep 8
done
