#!/usr/bin/env bash
# Offsite-FIRST Mongo backup of the PRODUCTION database (DB01, 10.0.0.3 — NOT the idle local mongo).
#   1. dump → local temp, verify gzip integrity
#   2. upload ALL local archives to the Hetzner Storage Box, verify remote size == local, then
#      DELETE the local copies (offsite-only). Keeps ~1 week on the box.
#   3. record status + box usage (df) + the box file list (for restore) in Mongo.
# If the upload fails, the local copy is KEPT (never lose the only copy). Wire via /etc/cron.d.
set -uo pipefail
cd "$(dirname "$0")/../.."

DEST="$(pwd)/backups"; mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
FILE="rxvision-$TS.archive.gz"
OUT="$DEST/$FILE"

strip() { sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
MTOOLS=(docker run --rm --network host mongo:7)
mongosh_eval() { "${MTOOLS[@]}" mongosh "$URI" --quiet --eval "db = db.getSiblingDB('$DB'); $1"; }

# 1) dump from DB01 + integrity check ────────────────────────────────────────
"${MTOOLS[@]}" mongodump --uri "$URI" --db "$DB" --archive --gzip > "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
gzip -t "$OUT" 2>/dev/null && NEWOK=true || NEWOK=false

# storage-box creds (from platform_settings.cloud)
CFG=$(mongosh_eval 'print(JSON.stringify(db.platform_settings.findOne({_id:"cloud"})||{}))')
read -r SB_HOST SB_USER SB_PW SB_PATH < <(python3 - "$CFG" <<'PY'
import json,sys
try: c=json.loads(sys.argv[1])
except Exception: c={}
print(c.get("storage_host","") or "-", c.get("storage_user","") or "-",
      c.get("storage_password","") or "-", c.get("storage_path","/") or "/")
PY
)
SB_REL="${SB_PATH#/}"; [ -z "$SB_REL" ] && SB_REL="."
SFTP() { sshpass -p "$SB_PW" sftp -P 23 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SB_USER@$SB_HOST"; }
SSHBOX() { sshpass -p "$SB_PW" ssh -p 23 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SB_USER@$SB_HOST" "$@"; }

OK=false; LOCATION="local"; uploaded_new=false
if [ "$SB_HOST" != "-" ] && [ "$SB_PW" != "-" ] && [ "$NEWOK" = true ] && command -v sshpass >/dev/null 2>&1; then
  # 2) upload every local archive in one session, then verify + delete the verified ones
  { echo "mkdir $SB_REL"; for f in "$DEST"/rxvision-*.archive.gz; do [ -e "$f" ] && echo "put $f $SB_REL/"; done; echo bye; } | SFTP >/dev/null 2>&1 || true
  declare -A RSZ=()
  while read -r sz nm; do RSZ["$nm"]="$sz"; done < <(printf 'cd %s\nls -l\nbye\n' "$SB_REL" | SFTP 2>/dev/null | awk '/rxvision-.*archive\.gz/{print $5, $NF}')
  for f in "$DEST"/rxvision-*.archive.gz; do
    [ -e "$f" ] || continue
    nm=$(basename "$f")
    if [ "${RSZ[$nm]:-x}" = "$(stat -c %s "$f")" ]; then rm -f "$f"; [ "$nm" = "$FILE" ] && uploaded_new=true; fi
  done
  if [ "$uploaded_new" = true ]; then
    OK=true; LOCATION="storagebox:$SB_HOST:$SB_PATH"
    # retention: delete dated archives on the box older than 7 days (keep PREWIPE)
    CUT=$(date -d '7 days ago' +%Y%m%d 2>/dev/null || date +%Y%m%d)
    RM=""
    while read -r nm; do
      d=$(printf '%s' "$nm" | sed -nE 's/^rxvision-([0-9]{8})-.*/\1/p')
      [ -n "$d" ] && [ "$d" -lt "$CUT" ] && RM+="rm $SB_REL/$nm"$'\n'
    done < <(printf 'cd %s\nls -1\nbye\n' "$SB_REL" | SFTP 2>/dev/null | grep -E '^rxvision-.*archive\.gz$')
    [ -n "$RM" ] && printf '%sbye\n' "$RM" | SFTP >/dev/null 2>&1 || true
  fi
fi

# 3) status + usage + file list ──────────────────────────────────────────────
if [ "$OK" = true ]; then
  # Hetzner box `df` Used is updated with delay → use `du` for the real footprint; df for quota.
  DFL=$(SSHBOX df -h 2>/dev/null | awk 'NR==2')
  BAVAIL=$(echo "$DFL" | awk '{print $4}'); BTOTAL=$(echo "$DFL" | awk '{print $2}'); BPCT=$(echo "$DFL" | awk '{print $5}')
  BK_TOTAL=$(SSHBOX du -sh "$SB_REL" 2>/dev/null | awk '{print $1}'); BK_TOTAL=${BK_TOTAL:-?}
  FILES_JS=""
  while read -r sz nm; do
    [ -z "$nm" ] && continue
    d=$(printf '%s' "$nm" | sed -nE 's/^rxvision-([0-9]{8})-([0-9]{6}).*/\1\2/p')
    if [ -n "$d" ]; then jsd="new Date(${d:0:4},${d:4:2}-1,${d:6:2},${d:8:2},${d:10:2},${d:12:2})"; else jsd="new Date()"; fi
    hsz=$(awk "BEGIN{printf \"%.1fM\", $sz/1048576}")
    FILES_JS+="{file:'$nm',size:'$hsz',ts:$jsd,ok:true,location:'storagebox'},"
  done < <(printf 'cd %s\nls -l\nbye\n' "$SB_REL" | SFTP 2>/dev/null | awk '/rxvision-.*archive\.gz/{print $5, $NF}')
  [ -n "$FILES_JS" ] && mongosh_eval "db.backups.deleteMany({}); db.backups.insertMany([$FILES_JS])" >/dev/null 2>&1
else
  # fallback (upload failed): keep local, report local disk + list local files
  BK_TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
  read -r BAVAIL BTOTAL BPCT < <(df -h --output=avail,size,pcent "$DEST" 2>/dev/null | tail -1)
  FILES_JS=""
  for f in "$DEST"/rxvision-*.archive.gz; do [ -e "$f" ] || continue
    gzip -t "$f" 2>/dev/null && o=true || o=false
    FILES_JS+="{file:'$(basename "$f")',size:'$(du -h "$f" | cut -f1)',ts:new Date($(stat -c %Y "$f")000),ok:$o,location:'local'},"
  done
  [ -n "$FILES_JS" ] && mongosh_eval "db.backups.deleteMany({}); db.backups.insertMany([$FILES_JS])" >/dev/null 2>&1
fi

REC="db.backup_status.updateOne({_id:'last'},{\$set:{ts:new Date(),size:'$SIZE',location:'$LOCATION',ok:$OK,file:'$FILE',backups_total:'${BK_TOTAL:-?}',disk_avail:'${BAVAIL:-?}',disk_total:'${BTOTAL:-?}',disk_used_pct:'${BPCT:-?}'}},{upsert:true})"
mongosh_eval "$REC" >/dev/null 2>&1

echo "$(date -Is) backup -> $FILE ($SIZE) offsite=$OK location=$LOCATION"
