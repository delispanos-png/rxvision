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
M() { docker run --rm --network host mongo:7 mongosh "$URI" --quiet --eval "db = db.getSiblingDB('$DB'); $1"; }
jget() { python3 -c "import sys,json; d=sys.stdin.read().strip(); print(json.loads(d).get('$1','') if d else '')" 2>/dev/null; }

while true; do
  CMD=$(M "const c=db.ops_commands.findOneAndUpdate({status:'pending',node:'$NODE'},{\$set:{status:'running',started_at:new Date()}},{returnDocument:'after'}); print(c?JSON.stringify({id:c._id.toString(),type:c.type,file:c.file||''}):'')" 2>/dev/null | tail -1)
  ID=$(printf '%s' "$CMD" | jget id); TYPE=$(printf '%s' "$CMD" | jget type); FILE=$(printf '%s' "$CMD" | jget file)
  if [ -n "$ID" ]; then
    case "$TYPE" in
      prune)    OUT=$( { docker builder prune -f; docker image prune -f; } 2>&1 | grep -i 'reclaimed' | paste -sd'; ' );;
      backup)   OUT=$(bash infra/scripts/mongo-backup.sh 2>&1 | tail -1);;
      add_node) OUT=$(NODE_CMD_ID="$ID" bash infra/scripts/provision-app-node.sh 2>&1 | tail -1);;
      restore)
        if [[ "$FILE" =~ ^rxvision-[A-Za-z0-9._-]+\.archive\.gz$ ]]; then
          dl=false
          if [ ! -e "backups/$FILE" ]; then           # offsite-only: fetch the archive from the box
            CFG=$(M "print(JSON.stringify(db.platform_settings.findOne({_id:'cloud'})||{}))" 2>/dev/null | tail -1)
            read -r SH SU SP SPATH < <(python3 -c "import json,sys; c=json.loads(sys.argv[1] or '{}'); print(c.get('storage_host','-') or '-', c.get('storage_user','-') or '-', c.get('storage_password','-') or '-', (c.get('storage_path','/') or '/'))" "$CFG")
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
