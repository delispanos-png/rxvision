#!/usr/bin/env bash
# Κυλιόμενη επανεκκίνηση του Docker daemon στους application nodes — ΕΝΑΝ ΚΑΘΕ ΦΟΡΑ.
#
# ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ: ο dockerd συσσωρεύει εσωτερικές διεργασίες που δεν ξεμπλοκάρουν μόνες
# τους (π.χ. μετά από μήνες συνεχούς δημιουργίας/καταστροφής container ή από ροές `docker
# logs` που έμειναν ανοιχτές). Οι ΑΙΤΙΕΣ διορθώνονται στον κώδικα· τα κατάλοιπα φεύγουν
# μόνο με επανεκκίνηση του daemon.
#
# ΓΙΑΤΙ ΚΥΛΙΟΜΕΝΗ: το `live-restore` είναι κλειστό, άρα η επανεκκίνηση ρίχνει στιγμιαία τα
# containers ΤΟΥ ΚΟΜΒΟΥ. Με τρεις κόμβους πίσω από load balancer, ένας κάθε φορά σημαίνει
# ΚΑΜΙΑ διακοπή για τον πελάτη.
#
# Χρήση (ΑΠΟ ΤΟΝ MGMT01):
#   bash infra/scripts/rolling-docker-restart.sh            # κανονικά
#   bash infra/scripts/rolling-docker-restart.sh --dry-run  # μόνο δείξε τι θα γινόταν
set -uo pipefail
cd "$(dirname "$0")/../.."

KEY="infra/scaling/keys/rxvision_data"
NODES=(10.0.0.7 10.0.0.6 10.0.0.5)      # ο βασικός (.5) ΤΕΛΕΥΤΑΙΟΣ
DRY=false; [ "${1:-}" = "--dry-run" ] && DRY=true

S() { ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -i "$KEY" "root@$1" "$2"; }

# Περιμένει να ξανασηκωθούν ΟΛΑ τα containers και να απαντά το /health. Χωρίς αυτό, θα
# προχωρούσαμε στον επόμενο κόμβο ενώ ο προηγούμενος είναι ακόμη κάτω — δηλαδή θα ρίχναμε
# δύο μαζί, που είναι ακριβώς αυτό που η κυλιόμενη επανεκκίνηση υπάρχει για να αποφύγει.
wait_healthy() {
  local host="$1" i
  for i in $(seq 1 60); do
    sleep 5
    local up
    up=$(S "$host" 'docker ps --format "{{.Names}}" 2>/dev/null | wc -l' 2>/dev/null || echo 0)
    # Η θύρα 8000 ΔΕΝ είναι δημοσιευμένη στον host (μόνο στο εσωτερικό δίκτυο, πίσω από
    # Caddy) — ο έλεγχος πρέπει να γίνει ΜΕΣΑ από το container, αλλιώς λέει πάντα «όχι».
    local ok
    ok=$(S "$host" 'docker exec rxvision-app-api-1 python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen(\"http://127.0.0.1:8000/health\",timeout=3).status==200 else 1)" >/dev/null 2>&1 && echo yes || echo no' 2>/dev/null || echo no)
    printf '\r   …%3ds  containers=%s  /health=%s' "$((i * 5))" "${up:-?}" "$ok"
    if [ "${up:-0}" -ge 5 ] && [ "$ok" = "yes" ]; then echo; return 0; fi
  done
  echo; return 1
}

echo "Κυλιόμενη επανεκκίνηση Docker — ${#NODES[@]} κόμβοι, ένας κάθε φορά."
$DRY && echo "(ΔΟΚΙΜΗ — καμία αλλαγή)"
echo

for h in "${NODES[@]}"; do
  name=$(S "$h" 'hostname' 2>/dev/null || echo "$h")
  # ΠΡΟΣΟΧΗ ΣΤΟΝ ΤΥΠΟ: το /proc/<pid>/stat μετρά σε ticks (100/δευτ). Ποσοστό =
  # ticks / (100 * δευτερόλεπτα) * 100. Λάθος διαίρεση δίνει νούμερα 100× μεγαλύτερα και
  # στέλνει σε κυνήγι φαντασμάτων.
  cpu=$(S "$h" 'P=$(pgrep -x dockerd|head -1); a=$(awk "{print \$14+\$15}" /proc/$P/stat); sleep 3; b=$(awk "{print \$14+\$15}" /proc/$P/stat); awk -v d=$((b-a)) "BEGIN{printf \"%.1f\", d/3}"' 2>/dev/null || echo "?")
  echo "▶ $name ($h) — dockerd πριν: ${cpu}%"
  if $DRY; then echo "   (δοκιμή: θα έτρεχα systemctl restart docker)"; echo; continue; fi

  S "$h" 'systemctl restart docker' || { echo "   ✖ απέτυχε η επανεκκίνηση — ΣΤΑΜΑΤΩ"; exit 1; }
  if ! wait_healthy "$h"; then
    echo "   ✖ ο κόμβος ΔΕΝ επανήλθε σε 5 λεπτά — ΣΤΑΜΑΤΩ πριν αγγίξω άλλον."
    exit 1
  fi
  after=$(S "$h" 'P=$(pgrep -x dockerd|head -1); a=$(awk "{print \$14+\$15}" /proc/$P/stat); sleep 5; b=$(awk "{print \$14+\$15}" /proc/$P/stat); awk -v d=$((b-a)) "BEGIN{printf \"%.1f\", d/5}"' 2>/dev/null || echo "?")
  echo "   ✔ επανήλθε — dockerd μετά: ${after}%"
  echo
done

echo "Τέλος."
