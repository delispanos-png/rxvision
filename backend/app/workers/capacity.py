"""Φύλακας χωρητικότητας — ΜΕΤΡΑΕΙ, ΠΡΟΤΕΙΝΕΙ, και κάνει ΜΙΑ αυτόματη ενέργεια.

ΓΙΑΤΙ ΥΠΑΡΧΕΙ: ο στόλος είναι cx33 (4 vCPU / 8 GB, 8,49 €/μήνα) και ο τύπος είναι συχνά
**εξαντλημένος** στη Hetzner· όταν ανοίγει απόθεμα, το παράθυρο κρατά λεπτά.

ΤΙ ΚΑΝΕΙ (κάθε 10′):
  · cx43 διαθέσιμο για τους app nodes → ΕΙΔΟΠΟΙΗΣΗ (αναβάθμιση εποπτευόμενα).
  · κόμβος υπό πίεση + διαθέσιμο cx33 → ΠΡΟΤΑΣΗ προσθήκης κόμβου (όχι αγορά).
  · cx33 στο location της DB01 → ΑΥΤΟΜΑΤΗ μεταφορά της βάσης (`workers.db_move`, απόφαση
    ιδιοκτήτη 24/10/2026) + αυτο-θεραπεία αν η DB01 βρεθεί σβηστή.
  · Η Hetzner δεν απαντά/άλλαξε το API → email «ο φύλακας δεν βλέπει».

ΚΑΜΙΑ ΑΓΟΡΑ SERVER: ως 24/10/2026 ο φύλακας αγόραζε μόνος του κόμβο δοκιμών (RxVisionSTAGE01,
αγοράστηκε 22/10 χωρίς να το ξέρει ο ιδιοκτήτης). Ο ιδιοκτήτης τον διέγραψε («δεν τον
χρειαζόμαστε») και η αυτόματη αγορά αφαιρέθηκε. Κάθε δαπάνη σε νέο μηχάνημα = απόφαση ανθρώπου.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async

WANT_TYPE = "cx33"
UPGRADE_TYPE = "cx43"               # η αμέσως επόμενη κλίμακα: 8 vCPU/16 GB/160 GB, 15,99 €
# ΒΑΣΗ σε φθηνότερο τύπο (απόφαση ιδιοκτήτη 24/10/2026): η DB01 είναι ccx13 (2 dedicated, 42,99 €)
# αλλά χρησιμοποιεί ~5% CPU (p95 12%) και τα cx33 δεν έχουν «κλοπή» CPU → dedicated περιττό.
# Ίδια RAM (8 GB) = ίδια ταχύτητα Mongo. Μόλις ανοίξει cx33 στο hel1 → ΕΙΔΟΠΟΙΗΣΗ (όχι αυτόματα).
DB_NODE = "RxVisionDB01"
DB_TARGET_TYPE = "cx33"
APP_PREFIX = "RxVisionSRV"          # οι κόμβοι εφαρμογής, πίσω από τον LB
PRESSURE_P95 = 70.0                 # % της συνολικής CPU του κόμβου — πάνω από αυτό «πονάει»
METRIC_HOURS = 24                   # παράθυρο μέτρησης: p95 ημέρας, όχι στιγμιαίο
MAX_AUTO_SERVERS = 2                # πλαφόν αυτόματων αγορών — να μη συσσωρεύσει μηχανές
ALLOWED_ZONE = "eu-central"
_API = "https://api.hetzner.cloud/v1"
_ADMIN_FALLBACK = ["delis.panos@gmail.com"]


async def _token(db) -> str | None:
    from app.services.platform_secrets import decrypt_doc
    c = decrypt_doc("cloud", await db["platform_settings"].find_one({"_id": "cloud"})) or {}
    return c.get("hetzner_token") or None


async def _pressure(cl, h, servers: list[dict]) -> list[dict]:
    """p95 CPU ανά app node, σε % της ΣΥΝΟΛΙΚΗΣ χωρητικότητας του κόμβου.

    ΓΙΑΤΙ p95 ΚΑΙ ΟΧΙ ΣΤΙΓΜΙΑΙΟ: μια στιγμιαία μέτρηση έδειχνε 15-44% ενώ το p95 24ώρου ήταν
    52-62% με κορυφές 74%. Το στιγμιαίο λέει ψέματα για το αν ένας κόμβος πονάει.
    ΓΙΑΤΙ ΟΧΙ ΜΕΣΗ ΤΙΜΗ: η μέση κρύβει τις αιχμές, που είναι ακριβώς η στιγμή που ο πελάτης
    περιμένει μπροστά στην οθόνη.

    Το Hetzner δίνει CPU ως άθροισμα όλων των πυρήνων (4 πυρήνες → 400% = κορεσμός), οπότε
    κανονικοποιούμε στο πλήθος πυρήνων του τύπου.
    """
    from datetime import timedelta
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=METRIC_HOURS)
    out = []
    for s in servers:
        if not str(s.get("name", "")).startswith(APP_PREFIX):
            continue
        cores = ((s.get("server_type") or {}).get("cores") or 1)
        try:
            r = await cl.get(f"{_API}/servers/{s['id']}/metrics", headers=h,
                             params={"type": "cpu", "start": start.isoformat(),
                                     "end": end.isoformat(), "step": 300})
            vals = sorted(float(v[1]) for v in
                          r.json()["metrics"]["time_series"]["cpu"]["values"])
        except Exception:  # noqa: BLE001 — χωρίς μετρήσεις δεν παίρνουμε αποφάσεις δαπάνης
            continue
        if not vals:
            continue
        p95 = vals[max(int(len(vals) * 0.95) - 1, 0)] / cores
        out.append({"name": s["name"], "id": s["id"], "p95": round(p95, 1),
                    "peak": round(vals[-1] / cores, 1), "type": (s.get("server_type") or {}).get("name")})
    return sorted(out, key=lambda x: -x["p95"])


async def _watcher_blind(db, detail: str, now) -> None:
    """Ο φύλακας ΔΕΝ μπορεί να δει τη Hetzner — ειδοποίηση μία φορά/24ωρο.

    Μάθημα 22/10/2026: η κατάργηση του /datacenters τον άφησε τυφλό εβδομάδες χωρίς κανένα
    σημάδι. Σιωπή από φύλακα πρέπει να σημαίνει «όλα καλά», ποτέ «δεν βλέπω»."""
    key = {"_id": "capacity:watcher_blind"}
    last = await db["ops_alerts"].find_one(key)
    lt = (last or {}).get("ts")
    await db["ops_alerts"].update_one(key, {"$set": {"ts": lt or now, "seen": now, "msg": detail}},
                                      upsert=True)
    if lt and (now - lt.replace(tzinfo=timezone.utc)).total_seconds() < 86400:
        return
    await db["ops_alerts"].update_one(key, {"$set": {"ts": now}})
    await _notify(
        db, "🙈 RxVision — ο φύλακας χωρητικότητας ΔΕΝ βλέπει τη Hetzner",
        f"<p>Δεν μπορεί να ελέγξει διαθεσιμότητα {WANT_TYPE}/{UPGRADE_TYPE}: <code>{detail}</code></p>"
        f"<p>Μέχρι να διορθωθεί, <b>δεν θα ειδοποιηθείς</b> αν ανοίξει απόθεμα. Έλεγξε το token "
        f"Hetzner (adminpanel → Υποδομή) ή αν άλλαξε το API.</p>")


def _launch_db_move() -> None:
    """Η μεταφορά τρέχει ΑΥΤΟΝΟΜΑ (νέα συνεδρία διεργασιών) — όχι μέσα στο task: όταν σβήσει η
    DB01 χάνεται ο broker και το Celery θα την ξανάτρεχε ή θα την έκοβε στη μέση."""
    import subprocess
    import sys
    subprocess.Popen([sys.executable, "-m", "app.workers.db_move"], start_new_session=True,
                     stdout=open("/tmp/db_move.log", "ab"), stderr=subprocess.STDOUT, cwd="/app")


async def _notify(db, subject: str, body_html: str) -> None:
    from app.services import mailer
    admins = [a["email"] async for a in db["platform_admins"].find({}, {"email": 1})
              if a.get("email")]
    try:
        await mailer.send_bulk(admins or _ADMIN_FALLBACK, subject, body_html)
    except Exception:  # noqa: BLE001 — η ειδοποίηση δεν ρίχνει ποτέ την εργασία
        pass


@celery_app.task(name="app.workers.capacity.watch_node_type")
def watch_node_type() -> dict:
    """Ρωτά για διαθεσιμότητα cx33 και αγοράζει μόλις εμφανιστεί."""
    async def _run() -> dict:
        # ΠΡΟΣΟΧΗ: το _fresh_db() επιστρέφει (client, db) και ο client ΘΕΛΕΙ κλείσιμο — αλλιώς
        # διαρρέει σύνδεση κάθε 10 λεπτά. Ίδιο μοτίβο με ops_health/ingestion.
        client, db = _fresh_db()
        try:
            return await _check(db)
        finally:
            client.close()

    async def _check(db) -> dict:
        import httpx
        tok = await _token(db)
        if not tok:
            return {"ok": False, "reason": "no_hetzner_token"}
        h = {"Authorization": f"Bearer {tok}"}
        now = datetime.now(timezone.utc)

        async with httpx.AsyncClient(timeout=25) as cl:
            servers = (await cl.get(f"{_API}/servers?per_page=50", headers=h)).json().get(
                "servers", [])
            # Η διαθεσιμότητα έρχεται από το `hetzner_catalog` (το /datacenters καταργήθηκε και
            # μας άφησε τυφλούς — βλ. εκεί). «Δεν μπόρεσα να δω» ≠ «δεν υπάρχει»: το πρώτο
            # ειδοποιεί, γιατί ένας φύλακας που δεν βλέπει είναι χειρότερος από κανέναν.
            from app.services import hetzner_catalog as hc
            try:
                types, locs = await hc.fetch(cl, h)
            except hc.HetznerUnavailable as exc:
                await _watcher_blind(db, str(exc), now)
                return {"ok": False, "reason": "hetzner_unavailable", "detail": str(exc)}
            await db["ops_alerts"].delete_one({"_id": "capacity:watcher_blind"})
            want = next((t for t in types if t.get("name") == WANT_TYPE), None)
            if not want:
                return {"ok": False, "reason": "type_unknown"}
            # μόνο η ζώνη της παραγωγής
            hits = [ln for ln in hc.available_in(want)
                    if (locs.get(ln) or {}).get("network_zone") == ALLOWED_ZONE]
            # ── ΤΙ ΧΡΕΙΑΖΟΜΑΣΤΕ — μετρημένο, όχι υποτιθέμενο ─────────────────────────────
            load = await _pressure(cl, h, servers)
            hurting = [n for n in load if n["p95"] >= PRESSURE_P95]
            status = {"ok": True, "checked": now.isoformat(), "cx33_available": bool(hits),
                      "load": load}
            # ΑΝΑΒΑΘΜΙΣΗ ΣΕ cx43: ελέγχεται ΠΑΝΤΑ, ανεξάρτητα από τον κόμβο δοκιμών — ο
            # ιδιοκτήτης περιμένει να αλλάξει ΟΛΟΥΣ τους app servers μόλις ανοίξει (22/10/2026).
            worst = hurting[0] if hurting else (load[0] if load else None)
            app_nodes = [s for s in servers if str(s.get("name", "")).startswith(APP_PREFIX)]
            up = await _watch_upgrade(db, types, now, worst=worst, app_nodes=app_nodes)
            dbm = await _watch_db_downgrade(db, cl, h, types, now, servers)
            up = {**up, **dbm}
            # ΑΥΤΟΜΑΤΗ ΚΛΙΜΑΚΩΣΗ app nodes (24/10/2026) — `workers/autoscale.py`
            from app.workers import autoscale
            try:
                up.update(await autoscale.run(db, cl, h, types, servers, now, _notify,
                                              db_move_pending=bool(dbm.get("db_move_available"))))
            except Exception as exc:  # noqa: BLE001 — η κλιμάκωση δεν ρίχνει τον φύλακα
                up["autoscale_error"] = f"{type(exc).__name__}: {exc}"[:200]

            return {**status, **up,
                    "action": "upgrade_suggested" if up.get("upgrade_available") else "none"}

    async def _watch_db_downgrade(db, cl, h, types, now, servers) -> dict:
        """DB01 ccx13 → cx33 στο ΙΔΙΟ location — ΑΥΤΟΜΑΤΑ (απόφαση ιδιοκτήτη 24/10/2026).

        Η ίδια η μεταφορά τρέχει στο `workers.db_move` (αυτόνομη διεργασία — ο Redis/broker ζει
        στη DB01). Εδώ: (α) αυτο-θεραπεία — DB01 σβηστή χωρίς ενεργή μεταφορά → άναμμα,
        (β) εκκίνηση μόλις βρεθεί απόθεμα, μία φορά, με 24ωρη παύση μετά από αποτυχία."""
        from app.services import hetzner_catalog as hc
        node = next((s for s in servers if s.get("name") == DB_NODE), None)
        mv = await db["ops_alerts"].find_one({"_id": "capacity:db_move"}) or {}
        mv_ts = mv.get("updated_at")
        mv_age = (now - mv_ts.replace(tzinfo=timezone.utc)) if mv_ts else None
        if node and node.get("status") == "off" and not (
                mv.get("status") == "running" and mv_age is not None and mv_age < timedelta(hours=1)):
            # Η διεργασία μεταφοράς πέθανε στη μέση (deploy/restart) — η βάση ΔΕΝ μένει σβηστή.
            await cl.post(f"{_API}/servers/{node['id']}/actions/poweron", headers=h)
            await _notify(db, "🚨 RxVision — η DB01 βρέθηκε ΣΒΗΣΤΗ και ξανάναψε αυτόματα",
                          f"<p>Κατάσταση μεταφοράς: <code>{mv.get('status')} / {mv.get('step')}</code></p>"
                          f"<p>Η DB02 κρατούσε την παραγωγή. Έλεγξε Mongo/Redis στη DB01.</p>")
            return {"db_move_available": False, "db_selfheal": "powered_on"}
        if not node or (node.get("server_type") or {}).get("name") == DB_TARGET_TYPE:
            return {"db_move_available": False}
        loc = (node.get("location") or {}).get("name")
        target = next((t for t in types if t.get("name") == DB_TARGET_TYPE), None)
        if not target or loc not in hc.available_in(target):
            await db["ops_alerts"].delete_one({"_id": "capacity:db_move_available"})
            return {"db_move_available": False}
        # ΑΥΤΟΜΑΤΑ, χωρίς ειδοποίηση, ΟΠΟΙΑ ΩΡΑ βρεθεί απόθεμα (απόφαση ιδιοκτήτη 24/10/2026): η DB02
        # κρατά τη Mongo· ο Redis σβήνει για ~5–10′ → εργασίες παρασκηνίου περιμένουν, δεν χάνονται.
        # Το απόθεμα cx33 ανοίγει για λεπτά — μια «ήσυχη ώρα» θα το έχανε.
        if mv.get("status") == "running" and mv_age is not None and mv_age < timedelta(hours=1):
            return {"db_move_available": True, "db_move": "running"}
        if mv.get("status") == "failed" and mv_age is not None and mv_age < timedelta(hours=24):
            return {"db_move_available": True, "db_move": "cooldown_after_failure"}
        _launch_db_move()
        return {"db_move_available": True, "db_move": "launched"}

    async def _watch_upgrade(db, types, now, worst=None, app_nodes=()) -> dict:
        """Παρακολούθηση cx43 για ΑΝΑΒΑΘΜΙΣΗ των app nodes — ΕΙΔΟΠΟΙΗΣΗ, όχι αυτόματη εκτέλεση.

        ΓΙΑΤΙ ΟΧΙ ΑΥΤΟΜΑΤΑ: το rescale απαιτεί **σβήσιμο** του μηχανήματος. Αν ανοίξει παράθυρο
        στις 03:00 και ο κόμβος δεν γυρίσει, δεν κοιτάζει κανείς. Η αναβάθμιση γίνεται
        εποπτευόμενα, έναν κόμβο τη φορά, μέσα στο παράθυρο των 22:30.

        Μετράει μόνο η τοποθεσία ΤΩΝ ΔΙΚΩΝ ΜΑΣ app nodes (το rescale γίνεται επί τόπου): cx43 στο
        fsn1 δεν βοηθά κόμβο στο hel1.

        ⚠️ Και το «αναστρέψιμο» είναι υπό όρους: η επιστροφή σε cx33 απαιτεί ΤΟ cx33 να έχει
        διαθεσιμότητα — που σήμερα ΔΕΝ έχει. Άρα η αναβάθμιση αντιμετωπίζεται ως μόνιμη.
        """
        from app.services import hetzner_catalog as hc
        up = next((t for t in types if t.get("name") == UPGRADE_TYPE), None)
        pending = [n for n in app_nodes if (n.get("server_type") or {}).get("name") != UPGRADE_TYPE]
        if not up or not pending:
            return {"upgrade_available": False, "upgrade_pending": len(pending)}
        node_locs = {(n.get("location") or {}).get("name") for n in pending}
        where = [ln for ln in hc.available_in(up) if ln in node_locs]
        if not where:
            await db["ops_alerts"].delete_one({"_id": "capacity:upgrade_available"})
            return {"upgrade_available": False, "upgrade_pending": len(pending)}
        # μία ειδοποίηση ανά 24ωρο — το απόθεμα μπορεί να μείνει μέρες, δεν θέλουμε σπαμ.
        # Το κλειδί σβήνει όταν κλείσει το απόθεμα → το ΕΠΟΜΕΝΟ άνοιγμα ειδοποιεί ΑΜΕΣΑ.
        key = {"_id": "capacity:upgrade_available"}
        last = await db["ops_alerts"].find_one(key)
        lt = (last or {}).get("ts")
        if lt and (now - lt.replace(tzinfo=timezone.utc)).total_seconds() < 86400:
            return {"upgrade_available": True, "notified": False, "dcs": where}
        await db["ops_alerts"].update_one(key, {"$set": {"ts": now, "dcs": where}}, upsert=True)

        def _eur(t: dict | None, ln: str) -> float | None:
            for p in (t or {}).get("prices") or []:
                if p.get("location") == ln:
                    try:
                        return float((p.get("price_monthly") or {}).get("gross"))
                    except (TypeError, ValueError):
                        return None
            return None
        cur = next((t for t in types if t.get("name") == WANT_TYPE), None)
        new_eur, old_eur = _eur(up, where[0]), _eur(cur, where[0])
        price = (f"<b>{old_eur:.2f} € → {new_eur:.2f} €</b> τον μήνα ανά κόμβο"
                 if new_eur and old_eur else "δες την τιμή στο Hetzner")
        nodes = "".join(f"<li>{n.get('name')} ({(n.get('server_type') or {}).get('name')})</li>"
                        for n in sorted(pending, key=lambda n: n.get("name", "")))
        which = ""
        if worst:
            which = (f"<p><b>Ξεκίνα από τον {worst['name']}</b> — είναι ο πιο φορτωμένος: "
                     f"p95 {worst['p95']}% / κορυφή {worst['peak']}% σε {METRIC_HOURS} ώρες.</p>")
        await _notify(
            db, f"⬆️ RxVision — ΔΙΑΘΕΣΙΜΟ {UPGRADE_TYPE} ({', '.join(where)}): αναβάθμιση app servers",
            f"<h3>Άνοιξε απόθεμα {UPGRADE_TYPE} στην τοποθεσία των app servers</h3>"
            f"<p>{up.get('cores')} vCPU / {up.get('memory')} GB / {up.get('disk')} GB — {price}.</p>"
            f"<p>Προς αναβάθμιση:</p><ul>{nodes}</ul>{which}"
            f"<p><b>Δεν έγινε τίποτα αυτόματα.</b> Το rescale σβήνει το μηχάνημα, οπότε γίνεται "
            f"εποπτευόμενα, <b>έναν κόμβο τη φορά</b> (οι άλλοι σηκώνουν την κίνηση μέσω LB), "
            f"με resize <b>χωρίς δίσκο</b>.</p>"
            f"<p>⚠️ Το απόθεμα μπορεί να κλείσει σε λεπτά/ώρες. Η επιστροφή σε cx33 απαιτεί το cx33 "
            f"να έχει τότε διαθεσιμότητα — σήμερα δεν έχει. Θεώρησέ το μόνιμο.</p>")
        return {"upgrade_available": True, "notified": True, "dcs": where}

    try:
        return _run_async(_run())
    except Exception as exc:  # noqa: BLE001 — ποτέ δεν ρίχνει τον beat
        return {"ok": False, "error": str(exc)[:200]}
