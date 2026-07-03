#!/usr/bin/env bash
# Offsite-FIRST, ENCRYPTED Mongo backup of the PRODUCTION database (DB01, 10.0.0.3).
#   1. dump → local temp (plaintext, dot-hidden), verify gzip integrity
#   2. ENCRYPT with the backup GPG public key (infra/scripts/backup-pubkey.asc) → *.archive.gz.gpg,
#      then shred the plaintext temp. The offsite copy is therefore unreadable without the PRIVATE key
#      (held off-box: /root/rxvision-backup-private.asc + operator's offline copy). See restore-backup.sh.
#   3. upload encrypted archives to the Hetzner Storage Box over SFTP with a PINNED host key
#      (infra/scripts/backup_known_hosts) — no TOFU/MITM — verify remote size == local, delete local.
#   4. record status + box usage + file list in Mongo.
# If the upload fails, the (encrypted) local copy is KEPT. Wire via /etc/cron.d.
set -uo pipefail
cd "$(dirname "$0")/../.."

DEST="$(pwd)/backups"; mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
FILE="rxvision-$TS.archive.gz.gpg"
OUT="$DEST/$FILE"
WORK="$DEST/.rxvision-$TS.archive.gz"          # dot-hidden plaintext temp (never matched by upload glob)
PUBKEY="$(pwd)/infra/scripts/backup-pubkey.asc"
KNOWN_HOSTS="$(pwd)/infra/scripts/backup_known_hosts"
PWFILE=$(mktemp); chmod 600 "$PWFILE"
trap 'rm -f "$WORK" "$PWFILE"' EXIT             # never leave a plaintext dump or the password around

strip() { sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
MTOOLS=(docker run --rm --network host mongo:7)
mongosh_eval() { "${MTOOLS[@]}" mongosh "$URI" --quiet --eval "db = db.getSiblingDB('$DB'); $1"; }

# 1) dump from DB01 + integrity check ────────────────────────────────────────
"${MTOOLS[@]}" mongodump --uri "$URI" --db "$DB" --archive --gzip > "$WORK"
gzip -t "$WORK" 2>/dev/null && GZOK=true || GZOK=false

# 2) ENCRYPT (asymmetric; host holds only the public key) → shred plaintext ───
ENC=false
if [ "$GZOK" = true ] && [ -s "$PUBKEY" ]; then
  if gpg --batch --yes --trust-model always --recipient-file "$PUBKEY" \
        --encrypt --output "$OUT" "$WORK" 2>/dev/null; then ENC=true; fi
fi
rm -f "$WORK"                                    # plaintext dump gone; only the .gpg remains
SIZE=$(du -h "$OUT" 2>/dev/null | cut -f1)
NEWOK=$ENC

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
[ "$SB_PW" != "-" ] && SB_PW=$(python3 infra/scripts/rxsecret.py "$SB_PW")   # decrypt (enc:v1: → plaintext)
printf '%s' "$SB_PW" > "$PWFILE"                 # password via file (not visible in `ps`)
SB_REL="${SB_PATH#/}"; [ -z "$SB_REL" ] && SB_REL="."
# PINNED host key (StrictHostKeyChecking=yes) — connection fails loudly if the box key ever changes.
SSHOPTS=(-P 23 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
SFTP() { sshpass -f "$PWFILE" sftp "${SSHOPTS[@]}" "$SB_USER@$SB_HOST"; }
SSHBOX() { sshpass -f "$PWFILE" ssh -p 23 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" "$SB_USER@$SB_HOST" "$@"; }

OK=false; LOCATION="local"; uploaded_new=false
if [ "$SB_HOST" != "-" ] && [ "$SB_PW" != "-" ] && [ "$NEWOK" = true ] && command -v sshpass >/dev/null 2>&1; then
  # 3) upload every local encrypted archive, then verify size + delete the verified ones
  { echo "mkdir $SB_REL"; for f in "$DEST"/rxvision-*.archive.gz.gpg; do [ -e "$f" ] && echo "put $f $SB_REL/"; done; echo bye; } | SFTP >/dev/null 2>&1 || true
  declare -A RSZ=()
  while read -r sz nm; do RSZ["$nm"]="$sz"; done < <(printf 'cd %s\nls -l\nbye\n' "$SB_REL" | SFTP 2>/dev/null | awk '/rxvision-.*archive\.gz\.gpg/{print $5, $NF}')
  for f in "$DEST"/rxvision-*.archive.gz.gpg; do
    [ -e "$f" ] || continue
    nm=$(basename "$f")
    if [ "${RSZ[$nm]:-x}" = "$(stat -c %s "$f")" ]; then rm -f "$f"; [ "$nm" = "$FILE" ] && uploaded_new=true; fi
  done
  if [ "$uploaded_new" = true ]; then
    OK=true; LOCATION="storagebox:$SB_HOST:$SB_PATH"
    # retention: delete dated archives on the box older than 7 days
    CUT=$(date -d '7 days ago' +%Y%m%d 2>/dev/null || date +%Y%m%d)
    RM=""
    while read -r nm; do
      d=$(printf '%s' "$nm" | sed -nE 's/^rxvision-([0-9]{8})-.*/\1/p')
      [ -n "$d" ] && [ "$d" -lt "$CUT" ] && RM+="rm $SB_REL/$nm"$'\n'
    done < <(printf 'cd %s\nls -1\nbye\n' "$SB_REL" | SFTP 2>/dev/null | grep -E '^rxvision-.*archive\.gz\.gpg$')
    [ -n "$RM" ] && printf '%sbye\n' "$RM" | SFTP >/dev/null 2>&1 || true
  fi
fi

# 4) status + usage + file list ──────────────────────────────────────────────
if [ "$OK" = true ]; then
  DFL=$(SSHBOX df -h 2>/dev/null | awk 'NR==2')
  BAVAIL=$(echo "$DFL" | awk '{print $4}'); BTOTAL=$(echo "$DFL" | awk '{print $2}'); BPCT=$(echo "$DFL" | awk '{print $5}')
  BK_TOTAL=$(SSHBOX du -sh "$SB_REL" 2>/dev/null | awk '{print $1}'); BK_TOTAL=${BK_TOTAL:-?}
  FILES_JS=""
  while read -r sz nm; do
    [ -z "$nm" ] && continue
    d=$(printf '%s' "$nm" | sed -nE 's/^rxvision-([0-9]{8})-([0-9]{6}).*/\1\2/p')
    if [ -n "$d" ]; then jsd="new Date(${d:0:4},${d:4:2}-1,${d:6:2},${d:8:2},${d:10:2},${d:12:2})"; else jsd="new Date()"; fi
    hsz=$(awk "BEGIN{printf \"%.1fM\", $sz/1048576}")
    FILES_JS+="{file:'$nm',size:'$hsz',ts:$jsd,ok:true,location:'storagebox',encrypted:true},"
  done < <(printf 'cd %s\nls -l\nbye\n' "$SB_REL" | SFTP 2>/dev/null | awk '/rxvision-.*archive\.gz\.gpg/{print $5, $NF}')
  [ -n "$FILES_JS" ] && mongosh_eval "db.backups.deleteMany({}); db.backups.insertMany([$FILES_JS])" >/dev/null 2>&1
else
  # fallback (encrypt or upload failed): keep local, report local disk + list local files
  BK_TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
  read -r BAVAIL BTOTAL BPCT < <(df -h --output=avail,size,pcent "$DEST" 2>/dev/null | tail -1)
  FILES_JS=""
  for f in "$DEST"/rxvision-*.archive.gz.gpg; do [ -e "$f" ] || continue
    FILES_JS+="{file:'$(basename "$f")',size:'$(du -h "$f" | cut -f1)',ts:new Date($(stat -c %Y "$f")000),ok:$ENC,location:'local',encrypted:true},"
  done
  [ -n "$FILES_JS" ] && mongosh_eval "db.backups.deleteMany({}); db.backups.insertMany([$FILES_JS])" >/dev/null 2>&1
fi

REC="db.backup_status.updateOne({_id:'last'},{\$set:{ts:new Date(),size:'$SIZE',location:'$LOCATION',ok:$OK,encrypted:$ENC,file:'$FILE',backups_total:'${BK_TOTAL:-?}',disk_avail:'${BAVAIL:-?}',disk_total:'${BTOTAL:-?}',disk_used_pct:'${BPCT:-?}'}},{upsert:true})"
mongosh_eval "$REC" >/dev/null 2>&1

echo "$(date -Is) backup -> $FILE ($SIZE) encrypted=$ENC offsite=$OK location=$LOCATION"
