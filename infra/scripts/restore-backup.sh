#!/usr/bin/env bash
# Restore a GPG-encrypted RxVision backup produced by mongo-backup.sh.
#   Usage: restore-backup.sh <file.archive.gz.gpg | latest> [--target-db <name>] [--drop]
# Needs the PRIVATE key. By default imports /root/rxvision-backup-private.asc into a temp keyring;
# override with GPG_PRIVATE_KEY=/path/to/key.asc (e.g. the operator's offline copy on a restore host).
# WITHOUT --target-db it only downloads + decrypts + integrity-checks (safe dry run) — it will NOT
# touch any database. Restoring over prod requires an explicit --target-db.
set -euo pipefail
cd "$(dirname "$0")/../.."

ARG="${1:-latest}"; shift || true
TARGET_DB=""; DROP=""
while [ $# -gt 0 ]; do case "$1" in
  --target-db) TARGET_DB="$2"; shift 2;;
  --drop) DROP="--drop"; shift;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done

PRIV="${GPG_PRIVATE_KEY:-/root/rxvision-backup-private.asc}"
KNOWN_HOSTS="$(pwd)/infra/scripts/backup_known_hosts"
[ -s "$PRIV" ] || { echo "FATAL: private key not found ($PRIV). Provide GPG_PRIVATE_KEY=..."; exit 1; }

strip() { sed -E 's/^["'"'"']//; s/["'"'"']$//'; }
URI=$(grep -E '^MONGODB_URI=' .env | cut -d= -f2- | strip)
DB=$(grep -E '^MONGODB_DB=' .env | cut -d= -f2- | strip); DB=${DB:-rxvision}
MTOOLS=(docker run --rm -i --network host mongo:7)
mongosh_eval() { "${MTOOLS[@]}" mongosh "$URI" --quiet --eval "$1"; }
CFG=$(mongosh_eval "print(JSON.stringify(db.getSiblingDB('$DB').platform_settings.findOne({_id:'cloud'})||{}))")
read -r SB_HOST SB_USER SB_PW SB_PATH < <(python3 - "$CFG" <<'PY'
import json,sys
try: c=json.loads(sys.argv[1])
except Exception: c={}
print(c.get("storage_host","-"), c.get("storage_user","-"), c.get("storage_password","-"), c.get("storage_path","/") or "/")
PY
)
SB_REL="${SB_PATH#/}"; [ -z "$SB_REL" ] && SB_REL="."
[ "$SB_PW" != "-" ] && SB_PW=$(python3 infra/scripts/rxsecret.py "$SB_PW")   # decrypt storage password
PWFILE=$(mktemp); chmod 600 "$PWFILE"; printf '%s' "$SB_PW" > "$PWFILE"
TMP=$(mktemp -d); GNUPGHOME=$(mktemp -d); export GNUPGHOME
trap 'rm -rf "$TMP" "$GNUPGHOME" "$PWFILE"' EXIT
SFTP() { sshpass -f "$PWFILE" sftp -P 23 -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" "$SB_USER@$SB_HOST"; }

if [ "$ARG" = "latest" ]; then
  ARG=$(printf 'cd %s\nls -1\nbye\n' "$SB_REL" | SFTP 2>/dev/null | grep -E '^rxvision-.*archive\.gz\.gpg$' | sort | tail -1)
  [ -n "$ARG" ] || { echo "FATAL: no encrypted backups found on the box"; exit 1; }
fi
echo "restoring: $ARG"
printf 'cd %s\nget %s %s/\nbye\n' "$SB_REL" "$ARG" "$TMP" | SFTP >/dev/null 2>&1
[ -s "$TMP/$ARG" ] || { echo "FATAL: download failed"; exit 1; }

gpg --batch --quiet --import "$PRIV" 2>/dev/null
gpg --batch --quiet --yes --decrypt "$TMP/$ARG" > "$TMP/archive.gz" 2>/dev/null
gzip -t "$TMP/archive.gz" && echo "OK: decrypted + gzip-valid ($(du -h "$TMP/archive.gz" | cut -f1))"

if [ -n "$TARGET_DB" ]; then
  echo "restoring into DB '$TARGET_DB' $DROP …"
  "${MTOOLS[@]}" mongorestore --uri "$URI" --archive --gzip --nsInclude "$DB.*" \
    --nsFrom "$DB.*" --nsTo "$TARGET_DB.*" $DROP < "$TMP/archive.gz"
  echo "restore into '$TARGET_DB' complete."
else
  echo "DRY RUN ok (decrypt+verify only). Re-run with --target-db <name> to actually restore."
fi
