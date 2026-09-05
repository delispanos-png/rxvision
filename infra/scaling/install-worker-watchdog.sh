#!/usr/bin/env bash
# Εγκατάσταση του worker-watchdog ως systemd timer ΣΤΟ MGMT01 (τρέξε το ΜΙΑ φορά ως root στο MGMT01).
#   sudo bash /opt/rxvision/infra/scaling/install-worker-watchdog.sh
# Δημιουργεί service+timer που τρέχει το worker-watchdog.sh κάθε 2′ (ανεξάρτητο από τη σπασμένη ουρά).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SH="$DIR/worker-watchdog.sh"
chmod +x "$SH"

cat >/etc/systemd/system/rxvision-watchdog.service <<EOF
[Unit]
Description=RxVision Celery worker watchdog (detect wedge → SMS + auto-restart)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $SH
EOF

cat >/etc/systemd/system/rxvision-watchdog.timer <<EOF
[Unit]
Description=Run RxVision worker watchdog every 2 minutes

[Timer]
OnBootSec=90
OnUnitActiveSec=120
AccuracySec=15
Unit=rxvision-watchdog.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now rxvision-watchdog.timer
echo "✅ Εγκαταστάθηκε. Έλεγχος:"
echo "   systemctl status rxvision-watchdog.timer --no-pager"
echo "   systemctl list-timers rxvision-watchdog.timer --no-pager"
echo "   tail -f /var/log/rxvision-watchdog.log"
