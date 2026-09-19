"""RxVision worker watchdog — ΑΝΙΧΝΕΥΣΗ ΑΝΑ ΔΡΟΜΟ + SMS (τρέχει ΜΕΣΑ στο rxvision-api-1, MGMT01).

ΓΙΑΤΙ ΑΝΑ ΔΡΟΜΟ (19/09/2026): από τότε που οι εργασίες χωρίστηκαν σε δρόμους (fast/sync/
maintenance/backfill/optical), ένας γενικός έλεγχος «κόλλησαν οι workers;» είναι πολύ χοντρός.
Μπορεί να έχει κολλήσει ΜΟΝΟ ο sync ενώ οι υπόλοιποι δουλεύουν μια χαρά — και τότε δεν έχει
κανένα νόημα να ρίξουμε τους πάντες. Ελέγχουμε κάθε δρόμο μόνο του και ξαναρίχνουμε ΜΟΝΟ
αυτόν που φταίει.

Είναι ΑΝΕΞΑΡΤΗΤΟ από την ουρά που μπορεί να κολλήσει: systemd timer στο MGMT01, μιλά μόνο σε
Redis + Apifon. Γι' αυτό επιβίωσε και δούλεψε στο 9ωρο περιστατικό της 19/09/2026.

Δύο ανεξάρτητα σήματα ανά δρόμο (για να μη ρίχνουμε ΥΓΙΕΙΣ workers σε νόμιμη αποκλιμάκωση):
  • ping-wedge : κανένας worker ΑΥΤΟΥ του δρόμου δεν απαντά, για BAD_STREAK συνεχόμενα ticks.
  • stuck-queue: η ουρά του είναι πάνω από το κατώφλι ΚΑΙ δεν προχωρά, για STUCK_STREAK ticks.
    Όσο ΑΔΕΙΑΖΕΙ, ΠΟΤΕ δεν θεωρείται κολλημένη — καμία λάθος δράση σε φυσιολογικό drain.

Έξοδος: μία γραμμή κατάστασης ανά δρόμο + «ACTION=RESTART <container> …» μόνο για όσους φταίνε.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

# Κάθε δρόμος: ουρές του, το container που τον τρέχει, το πρόθεμα του ονόματός του στο ping,
# και το κατώφλι ουράς πάνω από το οποίο θεωρείται ύποπτος.
# ΤΑ ΚΑΤΩΦΛΙΑ ΔΙΑΦΕΡΟΥΝ ΕΠΙΤΗΔΕΣ: ο «fast» δεν επιτρέπεται να στοιβάζει (κάποιος περιμένει
# μπροστά στην οθόνη), ενώ ο «backfill» στοιβάζει ΝΟΜΙΜΑ — τραβά χρόνια δεδομένων.
LANES = {
    "fast": {
        "queues": ["fast"],
        "container": "rxvision-app-worker-1",
        # «celery@» = το παλιό όνομα πριν τον χωρισμό· το δεχόμαστε ώστε ο φύλακας να μη
        # νομίσει ότι κόλλησε ο δρόμος ΚΑΤΑ ΤΗ ΜΕΤΑΒΑΣΗ, όσο ο παλιός worker ζει ακόμη.
        "prefixes": ("fast@", "celery@"),
        "backlog_hi": 200,
    },
    "sync": {"queues": ["sync"], "container": "rxvision-app-worker-sync-1",
             "prefixes": ("sync@",), "backlog_hi": 400},
    # Η συντήρηση κουβαλά ΚΑΙ τις δύο παλιές ουρές (αδειάζουν εφάπαξ μετά τον χωρισμό της
    # 19/09). Γι' αυτό το κατώφλι της είναι ΨΗΛΟ: χωρίς αυτό ο φύλακας θα έβλεπε 1.300 παλιές
    # εργασίες, θα τις νόμιζε «στάσιμη ουρά» και θα έριχνε ΥΓΙΗ εργάτη χωρίς κανέναν λόγο.
    "maint": {"queues": ["maintenance", "celery", "default"],
              "container": "rxvision-app-worker-maint-1",
              "prefixes": ("maint@",), "backlog_hi": 3000},
    "backfill": {"queues": ["backfill"], "container": "rxvision-app-worker-backfill-1",
                 "prefixes": ("backfill@",), "backlog_hi": 2000},
    "optical": {"queues": ["optical"], "container": "rxvision-app-optical-1",
                "prefixes": ("optical@",), "backlog_hi": 200},
}

BAD_STREAK = int(os.environ.get("WD_BAD_STREAK", "2"))               # ticks χωρίς καμία απάντηση
STUCK_STREAK = int(os.environ.get("WD_STUCK_STREAK", "4"))           # ticks με στάσιμη ουρά (≈8′)
RESTART_COOLDOWN = int(os.environ.get("WD_RESTART_COOLDOWN", "900"))  # 15′ ανά ΔΡΟΜΟ
STATE_KEY = "rxv:watchdog"


def _redis():
    import redis
    from app.workers.celery_app import celery_app
    return redis.from_url(celery_app.conf.broker_url, socket_connect_timeout=5, socket_timeout=6)


def _ping_by_lane() -> dict[str, int] | None:
    """Πόσοι workers απαντούν ΑΝΑ ΔΡΟΜΟ. None = δεν μπορέσαμε να ρωτήσουμε (≠ «κανείς»).

    Η διάκριση είναι κρίσιμη: «δεν ξέρω» ΔΕΝ είναι απόδειξη βλάβης και δεν πρέπει ποτέ να
    πυροδοτεί restart.
    """
    try:
        from app.workers.celery_app import celery_app
        replies = celery_app.control.ping(timeout=8) or []
    except Exception:
        return None
    names = [n for reply in replies for n in reply]
    out = {}
    for lane, cfg in LANES.items():
        out[lane] = sum(1 for n in names if n.startswith(tuple(cfg["prefixes"])))
    return out


async def _sms(text: str) -> None:
    try:
        from app.services import comms
        await comms.admin_alert(text)
    except Exception:
        pass


def main() -> None:
    r = _redis()
    try:
        r.ping()
    except Exception as exc:
        print(f"WD ΣΦΑΛΜΑ: ο Redis δεν απαντά ({exc}) — καμία δράση")
        return

    try:
        state = json.loads(r.get(STATE_KEY) or "{}")
    except Exception:
        state = {}
    lanes_state = state.get("lanes") or {}
    pings = _ping_by_lane()
    now = time.time()
    to_restart, messages = [], []

    for lane, cfg in LANES.items():
        st = lanes_state.get(lane) or {}
        try:
            backlog = sum(int(r.llen(q)) for q in cfg["queues"])
        except Exception:
            continue
        nodes = -1 if pings is None else pings.get(lane, 0)
        prev = int(st.get("last_backlog", backlog))

        # nodes == -1 → άγνωστο: μηδενίζουμε το streak αντί να το αυξήσουμε.
        ping_streak = int(st.get("ping_streak", 0)) + 1 if nodes == 0 else 0
        stuck = backlog > cfg["backlog_hi"] and backlog >= prev
        stuck_streak = int(st.get("stuck_streak", 0)) + 1 if stuck else 0
        last_restart = float(st.get("last_restart_ts", 0))
        incident = bool(st.get("incident_open", False))

        # «Κανένας worker» ΜΕ ΑΔΕΙΑ ΟΥΡΑ δεν είναι βλάβη: είναι δρόμος που δεν έχει στηθεί
        # ακόμη ή απλώς δεν έχει δουλειά. Χτυπάμε καμπανάκι μόνο όταν ΥΠΑΡΧΕΙ δουλειά που
        # περιμένει και δεν την κάνει κανείς — αλλιώς γεμίζουμε τον ιδιοκτήτη ψεύτικα SMS.
        wedged = (ping_streak >= BAD_STREAK and backlog > 0) or stuck_streak >= STUCK_STREAK
        if wedged and (now - last_restart) >= RESTART_COOLDOWN:
            why = "δεν απαντά κανείς" if ping_streak >= BAD_STREAK else "στάσιμη ουρά"
            to_restart.append(cfg["container"])
            messages.append(f"«{lane}» ({why}, ουρά={backlog})")
            last_restart = now
            incident = True
        elif incident and nodes > 0 and not stuck:
            asyncio.run(_sms(f"✅ RxVision: ο δρόμος «{lane}» επανήλθε "
                             f"(ουρά={backlog}, workers={nodes})."))
            incident = False

        lanes_state[lane] = {"last_backlog": backlog, "ping_streak": ping_streak,
                             "stuck_streak": stuck_streak, "last_restart_ts": last_restart,
                             "incident_open": incident, "updated_at": now}
        print(f"WD [{lane:9}] ουρά={backlog:<6} workers={nodes:<3} "
              f"ping_streak={ping_streak} stuck_streak={stuck_streak} incident={incident}")

    state["lanes"] = lanes_state
    try:
        r.set(STATE_KEY, json.dumps(state))
    except Exception:
        pass

    if to_restart:
        asyncio.run(_sms("⚠️ RxVision: κολλημένοι workers — " + ", ".join(messages) +
                         ". Αυτόματη επανεκκίνηση σε εξέλιξη."))
        print("ACTION=RESTART " + " ".join(to_restart))


if __name__ == "__main__":
    main()
