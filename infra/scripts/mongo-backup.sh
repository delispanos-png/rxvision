#!/usr/bin/env bash
# Nightly Mongo backup: gzip archive of the rxvision DB, kept on the host.
# Retains the last 14. Wire via /etc/cron.d/rxvision-backup.
set -euo pipefail
cd "$(dirname "$0")/../.."

DEST="$(pwd)/backups"
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/rxvision-$TS.archive.gz"

docker exec rxvision-mongo-1 sh -c "mongodump --db rxvision --archive --gzip" > "$OUT"

# retention: keep newest 14
ls -1t "$DEST"/rxvision-*.archive.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "$(date -Is) backup -> $OUT ($(du -h "$OUT" | cut -f1))"
