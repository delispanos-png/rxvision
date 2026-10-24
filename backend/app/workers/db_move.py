"""Αυτόματη μεταφορά της βάσης DB01 σε φθηνότερο τύπο (rescale επί τόπου) — 24/10/2026.

ΑΠΟΦΑΣΗ ΙΔΙΟΚΤΗΤΗ: «με την πρώτη ευκαιρία που θα βρεις cx33 στο Ελσίνκι, μετάφερέ τη — αυτόματα,
χωρίς ειδοποίηση». Η DB01 (ccx13, 2 dedicated, 42,99 €) χρησιμοποιεί ~5% CPU· cx33 = ίδια RAM 8 GB,
8,49 € → −34,50 €/μήνα.

ΓΙΑΤΙ ΕΙΝΑΙ ΧΩΡΙΣΤΗ ΔΙΕΡΓΑΣΙΑ ΚΑΙ ΟΧΙ CELERY TASK: η DB01 φιλοξενεί και τον Redis = broker του
Celery. Μόλις σβήσει, ο worker χάνει τον broker· με `task_acks_late` το μήνυμα ξαναδίνεται μετά
→ η μεταφορά θα έτρεχε ΔΕΥΤΕΡΗ φορά ή θα έμενε στη μέση. Εδώ τρέχει αυτόνομα (Mongo μέσω DB02,
Hetzner API) και ο φύλακας μόνο την ξεκινά.

ΔΙΚΛΕΙΔΕΣ: μία εκτέλεση (κλείδωμα στη Mongo) · προέλεγχος υγείας replica set (DB02 + MGMT01
συγχρονισμένοι) · ΟΜΑΛΟ σβήσιμο (ACPI → Mongo/Redis σώζουν) · ΠΑΝΤΑ άναμμα στο τέλος · έλεγχος
ότι Mongo & Redis της DB01 ξαναζωντάνεψαν · email ΜΟΝΟ σε αποτυχία. Αν η διεργασία πεθάνει
στη μέση, ο φύλακας (`capacity`) ανάβει την DB01 που βρήκε σβηστή.

Εκκίνηση: `python -m app.workers.db_move` (από τον φύλακα, detached).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger("db_move")

KEY = "capacity:db_move"
DB_NODE = "RxVisionDB01"
STANDBY_NODE = "RxVisionDB02"
VOTER_NODE = "RxVisionMGMT01"
TARGET = "cx33"
MAX_LAG_S = 15
_API = "https://api.hetzner.cloud/v1"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def lag_ok(primary_hello: dict, secondary_hello: dict, max_lag: int = MAX_LAG_S) -> bool:
    """Ο secondary είναι SECONDARY και πίσω από τον primary λιγότερο από `max_lag` δευτ."""
    if not secondary_hello.get("secondary"):
        return False
    p = ((primary_hello.get("lastWrite") or {}).get("lastWriteDate"))
    s = ((secondary_hello.get("lastWrite") or {}).get("lastWriteDate"))
    if not p or not s:
        return False
    return abs((p - s).total_seconds()) <= max_lag


def replica_ready(hellos: dict[str, dict]) -> bool:
    """Και τα 3 μέλη απαντούν, υπάρχει ΕΝΑΣ primary και οι άλλοι είναι συγχρονισμένοι (≤15″)."""
    if len(hellos) < 3:
        return False
    prim = [h for h in hellos.values() if h.get("isWritablePrimary")]
    if len(prim) != 1:
        return False
    return all(lag_ok(prim[0], h) for h in hellos.values() if not h.get("isWritablePrimary"))


def _hello(ip: str) -> dict:
    """`hello` απευθείας σε ένα μέλος (δεν θέλει αυθεντικοποίηση)."""
    from pymongo import MongoClient
    c = MongoClient(f"mongodb://{ip}:27017/?directConnection=true", serverSelectionTimeoutMS=5000)
    try:
        return c.admin.command("hello")
    finally:
        c.close()


def _redis_ok() -> bool:
    import redis

    from app.core.config import settings
    try:
        return bool(redis.Redis.from_url(settings.REDIS_URL, socket_timeout=3,
                                         socket_connect_timeout=3).ping())
    except Exception:  # noqa: BLE001
        return False


def _priv(server: dict) -> str | None:
    return next((n.get("ip") for n in (server.get("private_net") or []) if n.get("ip")), None)


async def _state(db, **fields) -> None:
    await db["ops_alerts"].update_one({"_id": KEY}, {"$set": {**fields, "updated_at": _now()}}, upsert=True)


async def _fail(db, step: str, detail: str) -> dict:
    from app.workers.capacity import _notify
    await _state(db, status="failed", step=step, error=detail[:500], finished_at=_now())
    await _notify(
        db, "🚨 RxVision — η αυτόματη μεταφορά της βάσης DB01 ΑΠΕΤΥΧΕ",
        f"<p>Βήμα: <b>{step}</b></p><p><code>{detail[:500]}</code></p>"
        f"<p>Η DB01 έχει ξαναναφτεί (ή θα ανάψει από τον φύλακα σε ≤10′). Η DB02 κρατά την "
        f"παραγωγή. Έλεγξε Mongo/Redis στη DB01.</p>")
    return {"ok": False, "step": step, "error": detail}


async def _wait_status(cl, h, sid: int, want: str, timeout: int) -> bool:
    end = _now() + timedelta(seconds=timeout)
    while _now() < end:
        s = (await cl.get(f"{_API}/servers/{sid}", headers=h)).json().get("server") or {}
        if s.get("status") == want:
            return True
        await asyncio.sleep(5)
    return False


async def _wait_action(cl, h, action_id: int, timeout: int) -> str:
    end = _now() + timedelta(seconds=timeout)
    while _now() < end:
        a = (await cl.get(f"{_API}/actions/{action_id}", headers=h)).json().get("action") or {}
        if a.get("status") in ("success", "error"):
            return a.get("status") + (f": {a.get('error')}" if a.get("error") else "")
        await asyncio.sleep(10)
    return "timeout"


async def run() -> dict:
    import httpx
    from pymongo.errors import DuplicateKeyError

    from app.services import hetzner_catalog as hc
    from app.workers.capacity import _token
    from app.workers.ingestion import _fresh_db

    client, db = _fresh_db()
    try:
        # ── ΚΛΕΙΔΩΜΑ: μία μεταφορά τη φορά (παλιό «running» > 1 ώρα = νεκρό → ξαναπαίρνεται)
        now = _now()
        try:
            await db["ops_alerts"].find_one_and_update(
                {"_id": KEY, "$or": [{"status": {"$ne": "running"}},
                                     {"updated_at": {"$lt": now - timedelta(hours=1)}}]},
                {"$set": {"status": "running", "step": "start", "started_at": now, "updated_at": now,
                          "error": None}}, upsert=True)
        except DuplicateKeyError:
            return {"ok": False, "reason": "already_running"}

        tok = await _token(db)
        h = {"Authorization": f"Bearer {tok}"}
        async with httpx.AsyncClient(timeout=30) as cl:
            servers = (await cl.get(f"{_API}/servers?per_page=50", headers=h)).json().get("servers", [])
            by = {s.get("name"): s for s in servers}
            node = by.get(DB_NODE)
            if not node:
                return await _fail(db, "find", "δεν βρέθηκε η DB01")
            if (node.get("server_type") or {}).get("name") == TARGET:
                await _state(db, status="done", step="already", finished_at=_now())
                return {"ok": True, "already": True}
            types, _ = await hc.fetch(cl, h)
            loc = (node.get("location") or {}).get("name")
            if loc not in hc.available_in(next((t for t in types if t.get("name") == TARGET), None)):
                await _state(db, status="skipped", step="no_stock", finished_at=_now())
                return {"ok": False, "reason": "no_stock"}

            # ── ΠΡΟΕΛΕΓΧΟΣ: χωρίς υγιείς DB02 + MGMT01, το σβήσιμο της DB01 = πλατφόρμα κάτω
            ips = {n: _priv(by.get(n) or {}) for n in (DB_NODE, STANDBY_NODE, VOTER_NODE)}
            try:
                hellos = {n: await asyncio.to_thread(_hello, ip) for n, ip in ips.items() if ip}
                ready = replica_ready(hellos)
            except Exception as exc:  # noqa: BLE001 — οποιοδήποτε μέλος δεν απαντά = όχι έτοιμο
                ready = False
                logger.warning("precheck failed: %s", exc)
            if not ready:
                await _state(db, status="skipped", step="replica_not_ready", finished_at=_now())
                return {"ok": False, "reason": "replica_not_ready"}   # ξαναδοκιμάζει στο επόμενο tick

            sid = node["id"]
            # ── 1. ΟΜΑΛΟ ΣΒΗΣΙΜΟ (ACPI): docker σταματά Mongo/Redis με SIGTERM → σώζουν δεδομένα
            await _state(db, step="shutdown")
            await cl.post(f"{_API}/servers/{sid}/actions/shutdown", headers=h)
            if not await _wait_status(cl, h, sid, "off", 300):
                return await _fail(db, "shutdown", "η DB01 δεν έσβησε σε 5′ — δεν άλλαξε τίποτα")
            changed = "not_started"
            try:
                # ── 2. ΑΛΛΑΓΗ ΤΥΠΟΥ, ΙΔΙΟΣ ΔΙΣΚΟΣ (ccx13 80 GB → cx33 80 GB)
                await _state(db, step="change_type")
                r = await cl.post(f"{_API}/servers/{sid}/actions/change_type", headers=h,
                                  json={"server_type": TARGET, "upgrade_disk": False})
                aid = ((r.json() or {}).get("action") or {}).get("id")
                changed = await _wait_action(cl, h, aid, 1800) if aid else f"refused: {r.text[:300]}"
            finally:
                # ── 3. ΑΝΑΜΜΑ — ΠΑΝΤΑ, ακόμη κι αν απέτυχε η αλλαγή
                await _state(db, step="poweron")
                await cl.post(f"{_API}/servers/{sid}/actions/poweron", headers=h)
                on = await _wait_status(cl, h, sid, "running", 600)
            if not on:
                return await _fail(db, "poweron", f"η DB01 δεν άναψε σε 10′ (αλλαγή τύπου: {changed})")

            # ── 4. ΕΠΑΛΗΘΕΥΣΗ: Mongo της DB01 ξαναμπήκε στο replica set + Redis απαντά
            await _state(db, step="verify")
            end = _now() + timedelta(minutes=15)
            mongo_ok = redis_ok = False
            while _now() < end and not (mongo_ok and redis_ok):
                try:
                    hd = await asyncio.to_thread(_hello, ips[DB_NODE])
                    mongo_ok = bool(hd.get("isWritablePrimary") or hd.get("secondary"))
                except Exception:  # noqa: BLE001
                    mongo_ok = False
                redis_ok = await asyncio.to_thread(_redis_ok)
                if not (mongo_ok and redis_ok):
                    await asyncio.sleep(15)
            if not changed.startswith("success"):
                return await _fail(db, "change_type", f"{changed} — η DB01 ξανάναψε ως {node['server_type']['name']}")
            if not (mongo_ok and redis_ok):
                return await _fail(db, "verify", f"μετά το άναμμα: mongo={mongo_ok} redis={redis_ok}")
            await _state(db, status="done", step="done", finished_at=_now(), new_type=TARGET)
            logger.info("DB01 moved to %s", TARGET)
            return {"ok": True, "moved": True}
    except Exception as exc:  # noqa: BLE001 — κάθε απρόβλεπτο: καταγραφή + email (ο φύλακας ανάβει)
        return await _fail(db, "unexpected", f"{type(exc).__name__}: {exc}")
    finally:
        client.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(asyncio.run(run()))
