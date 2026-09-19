#!/usr/bin/env bash
# RxVision worker watchdog — runner (systemd timer στο MGMT01, κάθε 2′).
# Τρέχει το detection μέσα στο rxvision-api-1 (Redis+Apifon)· αν αυτό αποφασίσει «ACTION=RESTART»,
# κάνει το πραγματικό restart των app-node workers μέσω ssh (private net). Ανεξάρτητο από τη σπασμένη
# ουρά — γι' αυτό ζει εδώ, όχι ως Celery task. Λύση για incident 2026-09-05 (13ωρο wedge, σιωπηλά).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY="$DIR/keys/rxvision_data"
API_CTR="${WD_API_CONTAINER:-rxvision-api-1}"
APP_NODES=(10.0.0.5 10.0.0.6 10.0.0.7)
LOG="/var/log/rxvision-watchdog.log"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "$(ts) $*" | tee -a "$LOG" 2>/dev/null || echo "$(ts) $*"; }

# 1) Detection μέσα στο api container (Redis + SMS ζουν εκεί)
OUT="$(cat "$DIR/worker_watchdog.py" | timeout 40 docker exec -i "$API_CTR" python 2>&1)"
log "$OUT"

# 2) Αν ζητήθηκε restart → ξαναρίχνουμε ΜΟΝΟ τα containers που ονόμασε το detection.
#    ΓΙΑΤΙ ΟΧΙ ΟΛΑ: μετά τον χωρισμό σε δρόμους (fast/sync/maintenance/backfill/optical) μπορεί
#    να έχει κολλήσει μόνο ένας. Το να ρίχναμε τους πάντες θα διέκοπτε υγιή δουλειά — π.χ. ένα
#    ιστορικό κατέβασμα δύο ετών — χωρίς κανέναν λόγο.
CTRS="$(grep -oP '(?<=^ACTION=RESTART ).*' <<<"$OUT" | tail -1)"
if [ -n "$CTRS" ]; then
  log "→ restarting [$CTRS] on ${APP_NODES[*]}"
  for h in "${APP_NODES[@]}"; do
    for c in $CTRS; do
      # Αν ο δρόμος δεν τρέχει σε ΑΥΤΟΝ τον κόμβο, το προσπερνάμε σιωπηλά — δεν είναι σφάλμα.
      if ! timeout 20 ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
             root@"$h" "docker ps -a --format '{{.Names}}' | grep -qx '$c'" 2>/dev/null; then
        continue
      fi
      R="$(timeout 90 ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
             root@"$h" "docker restart -t 15 $c" 2>&1)"
      log "   $h · $c: $R"
    done
  done
fi
