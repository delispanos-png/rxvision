"""RxVision worker watchdog — DETECTION + SMS (runs INSIDE rxvision-api-1 on MGMT01).

Ανιχνεύει «κολλημένους» Celery workers της κύριας ουράς `celery` (incident 2026-09-05: 13ωρο κενό
συγχρονισμού ΗΔΥΚΑ επειδή tasks χωρίς time-limit μπλόκαραν τις θέσεις των workers). Είναι ΑΝΕΞΑΡΤΗΤΟ
από την ουρά που μπορεί να κολλήσει: τρέχει από systemd timer στο MGMT01, μιλά μόνο σε Redis + Apifon.

Λογική (2 ανεξάρτητα σήματα wedge — αποφεύγουμε restart ΥΓΙΩΝ workers κατά τη νόμιμη αποκλιμάκωση):
  • ping-wedge: το `ping` δεν επιστρέφει ΚΑΝΕΝΑΝ worker (nodes==0) — το βασικό & αξιόπιστο σήμα (όπως
    στο incident 2026-09-05: «No nodes replied»). Χρειάζονται PING_STREAK συνεχόμενα ticks (transient-safe).
  • stuck-queue: το backlog είναι > BACKLOG_HI ΚΑΙ ΔΕΝ προχωρά (backlog ≥ προηγούμενο) για STUCK_STREAK
    συνεχόμενα ticks — πιάνει τη σπάνια περίπτωση «workers απαντούν στο ping αλλά δεν καταναλώνουν».
    Όσο η ουρά ΑΔΕΙΑΖΕΙ (backlog < προηγούμενο), ΠΟΤΕ δεν θεωρείται stuck (καμία false δράση στο drain).
  • Δράση (με cooldown RESTART_COOLDOWN): «ACTION=RESTART» (το shell wrapper κάνει το ssh-restart) + SMS.
  • Ανάκαμψη (ήταν incident, τώρα nodes>0 & όχι stuck): SMS «OK» + κλείσιμο incident.

State: Redis key `rxv:watchdog` (JSON). Έξοδος: μία γραμμή status + προαιρετικά «ACTION=RESTART».
"""
from __future__ import annotations

import asyncio
import json
import os
import time

BACKLOG_HI = int(os.environ.get("WD_BACKLOG_HI", "800"))              # πάνω απ' αυτό = ύποπτο backlog
BAD_STREAK = int(os.environ.get("WD_BAD_STREAK", "2"))               # ping==0 συνεχόμενα ticks πριν δράση
STUCK_STREAK = int(os.environ.get("WD_STUCK_STREAK", "4"))           # στάσιμο backlog ticks (≈8′) πριν δράση
RESTART_COOLDOWN = int(os.environ.get("WD_RESTART_COOLDOWN", "900"))  # 15′ μεταξύ auto-restarts
STATE_KEY = "rxv:watchdog"


def _redis():
    import redis
    from app.workers.celery_app import celery_app
    return redis.from_url(celery_app.conf.broker_url, socket_connect_timeout=5, socket_timeout=6)


def _ping_nodes() -> int:
    """Πλήθος workers που απαντούν σε ping (broadcast, σύντομο timeout). 0 = κανείς → wedge/down."""
    try:
        from app.workers.celery_app import celery_app
        replies = celery_app.control.ping(timeout=8) or []
        return len(replies)
    except Exception:
        return -1   # άγνωστο (δεν το μετράμε ως απόδειξη wedge από μόνο του)


async def _sms(text: str) -> None:
    try:
        from app.services import comms
        await comms.admin_alert(text)
    except Exception:
        pass


def main() -> None:
    r = _redis()
    try:
        backlog = int(r.llen("celery"))
    except Exception as exc:
        print(f"WD backlog=ERR ({exc}) — redis unreachable")
        return
    nodes = _ping_nodes()

    try:
        st = json.loads(r.get(STATE_KEY) or "{}")
    except Exception:
        st = {}
    prev = int(st.get("last_backlog", backlog))
    ping_streak = int(st.get("ping_streak", 0))
    stuck_streak = int(st.get("stuck_streak", 0))
    incident = bool(st.get("incident_open", False))
    last_restart = float(st.get("last_restart_ts", 0))
    now = time.time()

    # Σήμα 1: κανένας worker δεν απαντά (nodes==0). nodes==-1 = άγνωστο (σφάλμα ping) → δεν το μετράμε.
    ping_streak = ping_streak + 1 if nodes == 0 else 0
    # Σήμα 2: μεγάλο backlog που ΔΕΝ προχωρά (backlog >= προηγούμενο). Όσο αδειάζει → reset.
    stuck = backlog > BACKLOG_HI and backlog >= prev
    stuck_streak = stuck_streak + 1 if stuck else 0

    wedged = ping_streak >= BAD_STREAK or stuck_streak >= STUCK_STREAK

    action = False
    if wedged and (now - last_restart) >= RESTART_COOLDOWN:
        action = True
        last_restart = now
        why = "δεν απαντούν στο ping" if ping_streak >= BAD_STREAK else "στάσιμη ουρά"
        asyncio.run(_sms(
            f"⚠️ RxVision: οι workers φαίνονται κολλημένοι ({why}· ουρά celery={backlog}, "
            f"workers που απαντούν={max(nodes, 0)}). Αυτόματο restart σε εξέλιξη."))
        st["incident_open"] = True
    elif incident and nodes > 0 and not stuck:
        asyncio.run(_sms(f"✅ RxVision: οι workers επανήλθαν (ουρά celery={backlog}, workers={nodes})."))
        st["incident_open"] = False

    st.update({"last_backlog": backlog, "ping_streak": ping_streak, "stuck_streak": stuck_streak,
               "last_restart_ts": last_restart, "updated_at": now})
    try:
        r.set(STATE_KEY, json.dumps(st))
    except Exception:
        pass

    print(f"WD backlog={backlog} prev={prev} nodes={nodes} stuck={stuck} "
          f"ping_streak={ping_streak} stuck_streak={stuck_streak} incident={st.get('incident_open')}")
    if action:
        print("ACTION=RESTART")


if __name__ == "__main__":
    main()
