"""Φύλακας διαθεσιμότητας τύπου κόμβου — αρπάζει cx33 μόλις ξαναβγεί σε απόθεμα.

ΓΙΑΤΙ ΥΠΑΡΧΕΙ: όλος ο στόλος είναι **cx33** (4 vCPU / 8 GB / 80 GB, 8,49 €/μήνα). Ο τύπος ΔΕΝ
έχει καταργηθεί — είναι απλώς **εξαντλημένος** (26/09/2026: δεν παραγγέλνεται σε κανένα
datacenter). Η επόμενη φθηνότερη x86 επιλογή στο hel1 είναι cpx32 στα 35,49 € — **τετραπλάσια
τιμή για ΤΑ ΙΔΙΑ χαρακτηριστικά**. Άρα όταν ξαναβγεί απόθεμα, το παράθυρο μπορεί να είναι λεπτά
και δεν μπορεί να το φυλάει άνθρωπος.

ΤΙ ΚΑΝΕΙ: κάθε 10′ ρωτά τη Hetzner. Μόλις βρει cx33 διαθέσιμο, **το αγοράζει αμέσως** και
στέλνει email. Μετά αυτο-απενεργοποιείται (βλέπει ότι ο κόμβος υπάρχει και δεν ξαναγοράζει).

ΦΡΑΓΜΟΙ — γιατί μια αυτόματη αγορά πρέπει να είναι βαρετή και προβλέψιμη:
  · ΜΟΝΟ τύπος `cx33`· καμία «αναβάθμιση» σε ακριβότερο αν λείπει ο φθηνός.
  · ΜΟΝΟ network zone `eu-central` (ίδιο ιδιωτικό δίκτυο με την παραγωγή).
  · ΑΚΡΙΒΩΣ ΕΝΑΣ κόμβος, με σταθερό όνομα → αν υπάρχει, δεν αγοράζει ΤΙΠΟΤΑ (idempotent).
  · **Χωρίς δημόσια IP.** Ο κόμβος γεννιέται μόνο στο ιδιωτικό δίκτυο: μηδενική έκθεση, και τα
    deploy γίνονται ούτως ή άλλως από το ιδιωτικό δίκτυο. Δημόσια πρόσβαση μπαίνει αργότερα,
    συνειδητά, με firewall.
  · Πρότυπο (image, κλειδί SSH, δίκτυο) **αντιγράφεται από υπάρχοντα κόμβο** — δεν είναι
    σκληρο-κωδικοποιημένο, ώστε να μη ξεφύγει από τον στόλο.
  · Κάθε σφάλμα καταπίνεται: ο beat δεν πέφτει ποτέ εξαιτίας του φύλακα.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async

WANT_TYPE = "cx33"
UPGRADE_TYPE = "cx43"               # η αμέσως επόμενη κλίμακα: 8 vCPU/16 GB/160 GB, 15,99 €
APP_PREFIX = "RxVisionSRV"          # οι κόμβοι εφαρμογής, πίσω από τον LB
PRESSURE_P95 = 70.0                 # % της συνολικής CPU του κόμβου — πάνω από αυτό «πονάει»
METRIC_HOURS = 24                   # παράθυρο μέτρησης: p95 ημέρας, όχι στιγμιαίο
MAX_AUTO_SERVERS = 2                # πλαφόν αυτόματων αγορών — να μη συσσωρεύσει μηχανές
TARGET_NAME = "RxVisionSTAGE01"     # ο κόμβος δοκιμών που περιμένουμε
TEMPLATE_FROM = "RxVisionSRV03"     # από ποιον αντιγράφουμε image/κλειδί/δίκτυο
ALLOWED_ZONE = "eu-central"
PREFERRED_LOCATION = "hel1"         # ίδιο location με την παραγωγή
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


async def _suggest_app_node(db, hurting: list[dict], where: list[str], now) -> None:
    """Πρόταση προσθήκης κόμβου — ΔΕΝ αγοράζει. Μία ειδοποίηση ανά 24ωρο."""
    key = {"_id": "capacity:app_node_suggested"}
    last = await db["ops_alerts"].find_one(key)
    lt = (last or {}).get("ts")
    if lt and (now - lt.replace(tzinfo=timezone.utc)).total_seconds() < 86400:
        return
    await db["ops_alerts"].update_one(key, {"$set": {"ts": now, "nodes": hurting}}, upsert=True)
    rows = "".join(f"<li>{n['name']}: p95 <b>{n['p95']}%</b>, κορυφή {n['peak']}%</li>"
                   for n in hurting)
    await _notify(
        db, f"⚠️ RxVision — κόμβος υπό πίεση, και υπάρχει απόθεμα {WANT_TYPE}",
        f"<h3>Ξεπέρασαν το {PRESSURE_P95}% σε p95 {METRIC_HOURS}ώρου</h3><ul>{rows}</ul>"
        f"<p>Υπάρχει απόθεμα <b>{WANT_TYPE}</b> ({', '.join(where)}) για προσθήκη κόμβου.</p>"
        f"<p><b>Δεν αγοράστηκε τίποτα.</b> Ένας κόμβος χωρίς <code>bootstrap-node.sh</code> + "
        f"<code>adopt-node.sh</code> δεν σηκώνει κίνηση — θα πλήρωνες μηχάνημα που κάθεται.</p>"
        f"<p>Προτίμησε πρώτα <b>αναβάθμιση</b> του πιο φορτωμένου αν υπάρχει cx43: δεν "
        f"προσθέτει κόμβο να συντηρείς.</p>")


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
            # ΦΡΑΓΜΟΣ 1 — υπάρχει ήδη; τότε τέλος, καμία αγορά.
            if any(s.get("name") == TARGET_NAME for s in servers):
                return {"ok": True, "done": True, "reason": "already_exists"}

            tmpl = next((s for s in servers if s.get("name") == TEMPLATE_FROM), None)
            if not tmpl:
                return {"ok": False, "reason": "no_template_node"}

            types = (await cl.get(f"{_API}/server_types?per_page=80", headers=h)).json().get(
                "server_types", [])
            want = next((t for t in types if t.get("name") == WANT_TYPE), None)
            if not want:
                return {"ok": False, "reason": "type_unknown"}

            dcs = (await cl.get(f"{_API}/datacenters", headers=h)).json().get("datacenters", [])
            hits = []
            for d in dcs:
                loc = d.get("location") or {}
                # ΦΡΑΓΜΟΣ 2 — μόνο η ζώνη της παραγωγής
                if loc.get("network_zone") != ALLOWED_ZONE:
                    continue
                if want["id"] in ((d.get("server_types") or {}).get("available") or []):
                    hits.append(loc.get("name"))
            # ── ΤΙ ΧΡΕΙΑΖΟΜΑΣΤΕ — μετρημένο, όχι υποτιθέμενο ─────────────────────────────
            need_staging = not any(s.get("name") == TARGET_NAME for s in servers)
            load = await _pressure(cl, h, servers)
            hurting = [n for n in load if n["p95"] >= PRESSURE_P95]
            status = {"ok": True, "checked": now.isoformat(), "cx33_available": bool(hits),
                      "load": load, "need_staging": need_staging}

            # ── ΚΛΙΜΑΚΑ ΠΡΟΤΕΡΑΙΟΤΗΤΑΣ ───────────────────────────────────────────────────
            # ΠΟΙΟΣ ΞΟΔΕΥΕΙ: αυτόματη αγορά γίνεται ΜΟΝΟ για τον έναν κόμβο δοκιμών, που είναι
            # ρητά εγκεκριμένος και φραγμένος στο ένα μηχάνημα. Κάθε ΑΛΛΗ δαπάνη (επιπλέον app
            # node, αναβάθμιση) απαιτεί άνθρωπο, για δύο λόγους:
            #   · ένας αγορασμένος κόμβος εφαρμογής ΔΕΝ δουλεύει μόνος του — θέλει
            #     bootstrap-node.sh + adopt-node.sh· θα πλήρωνες μηχάνημα που κάθεται.
            #   · το φορτίο είναι αιχμιακό — ένα βαρύ backfill περνά το κατώφλι για μία ώρα
            #     και θα αγόραζε υλικό για πρόβλημα που λύνεται μόνο του.
            # Ο φύλακας ΜΕΤΡΑΕΙ και ΠΡΟΤΕΙΝΕΙ· η δέσμευση χρημάτων μένει στον ιδιοκτήτη.

            # 1) ΔΟΚΙΜΕΣ ΠΡΩΤΑ — δεν υπάρχει κανένα περιβάλλον δοκιμών και κάθε αλλαγή
            #    δοκιμάζεται πάνω σε πραγματικά φαρμακεία. Προηγείται της χωρητικότητας,
            #    που έχει ακόμη περιθώριο.
            if hits and need_staging:
                pass   # συνεχίζει παρακάτω στην αγορά του κόμβου δοκιμών
            else:
                # 2) ΠΟΝΑΕΙ ΚΑΠΟΙΟΣ; Η χωρητικότητα πάει εκεί. Προτιμάμε ΑΝΑΒΑΘΜΙΣΗ του πιο
                #    φορτωμένου (δεν προσθέτει κόμβο να συντηρείς)· αλλιώς προσθήκη κόμβου.
                worst = hurting[0] if hurting else (load[0] if load else None)
                up = await _watch_upgrade(db, cl, h, types, now, worst=worst)
                if hurting and hits:
                    await _suggest_app_node(db, hurting, hits, now)
                    return {**status, **up, "action": "suggest_app_node"}
                return {**status, **up,
                        "action": "upgrade_suggested" if up.get("upgrade_available") else "none"}

            # Προτίμηση στο location της παραγωγής (ίδιο ιδιωτικό δίκτυο, μηδενική καθυστέρηση)
            location = PREFERRED_LOCATION if PREFERRED_LOCATION in hits else sorted(hits)[0]
            net_ids = [n.get("network") for n in (tmpl.get("private_net") or []) if n.get("network")]
            payload = {
                "name": TARGET_NAME,
                "server_type": WANT_TYPE,
                "image": (tmpl.get("image") or {}).get("name") or "ubuntu-22.04",
                "location": location,
                "ssh_keys": [k["id"] for k in (await cl.get(f"{_API}/ssh_keys",
                                                            headers=h)).json().get("ssh_keys", [])],
                "networks": net_ids,
                # ΦΡΑΓΜΟΣ 3 — κανένα δημόσιο πρόσωπο. Μόνο ιδιωτικό δίκτυο.
                "public_net": {"enable_ipv4": False, "enable_ipv6": False},
                "labels": {"role": "staging", "bought_by": "capacity-watcher"},
                "start_after_create": True,
            }
            r = await cl.post(f"{_API}/servers", headers=h, json=payload)
            if r.status_code not in (200, 201):
                detail = str(r.text)[:200]
                await db["ops_alerts"].update_one(
                    {"_id": "capacity:buy_failed"},
                    {"$set": {"ts": now, "msg": detail}}, upsert=True)
                return {"ok": False, "available": True, "bought": False, "error": detail}

            srv = (r.json() or {}).get("server") or {}
            ip = next((n.get("ip") for n in (srv.get("private_net") or []) if n.get("ip")), "—")
            await db["ops_alerts"].update_one(
                {"_id": "capacity:bought"},
                {"$set": {"ts": now, "name": TARGET_NAME, "location": location, "ip": ip}},
                upsert=True)
            await _notify(
                db, f"✅ RxVision — αγοράστηκε {WANT_TYPE} για staging",
                f"<h3>Βρέθηκε απόθεμα {WANT_TYPE} και αγοράστηκε αμέσως</h3>"
                f"<ul><li>Όνομα: <b>{TARGET_NAME}</b></li>"
                f"<li>Τοποθεσία: {location}</li>"
                f"<li>Ιδιωτική IP: <b>{ip}</b></li>"
                f"<li>Χωρίς δημόσια IP — πρόσβαση από MGMT01</li></ul>"
                f"<p>Ο φύλακας απενεργοποιείται μόνος του από εδώ και πέρα.</p>")
            return {"ok": True, "bought": True, "location": location, "ip": ip}

    async def _watch_upgrade(db, cl, h, types, now, worst=None) -> dict:
        """Παρακολούθηση cx43 για ΑΝΑΒΑΘΜΙΣΗ των app nodes — ΕΙΔΟΠΟΙΗΣΗ, όχι αυτόματη εκτέλεση.

        ΓΙΑΤΙ ΟΧΙ ΑΥΤΟΜΑΤΑ: το rescale απαιτεί **σβήσιμο** του μηχανήματος. Αν ανοίξει παράθυρο
        στις 03:00 και ο κόμβος δεν γυρίσει, δεν κοιτάζει κανείς. Η πρώτη αναβάθμιση γίνεται
        εποπτευόμενα, έναν κόμβο τη φορά, μέσα στο παράθυρο των 22:30.

        ⚠️ Και το «αναστρέψιμο» είναι υπό όρους: η επιστροφή σε cx33 απαιτεί ΤΟ cx33 να έχει
        διαθεσιμότητα μετάπτωσης — που σήμερα ΔΕΝ έχει. Άρα η αναβάθμιση αντιμετωπίζεται ως
        πιθανώς μόνιμη.
        """
        up = next((t for t in types if t.get("name") == UPGRADE_TYPE), None)
        if not up:
            return {"upgrade_available": False}
        dcs = (await cl.get(f"{_API}/datacenters", headers=h)).json().get("datacenters", [])
        where = [d["name"] for d in dcs
                 if up["id"] in ((d.get("server_types") or {}).get("available_for_migration") or [])]
        if not where:
            return {"upgrade_available": False}
        # μία ειδοποίηση ανά 24ωρο — το απόθεμα μπορεί να μείνει μέρες, δεν θέλουμε σπαμ
        key = {"_id": "capacity:upgrade_available"}
        last = await db["ops_alerts"].find_one(key)
        lt = (last or {}).get("ts")
        if lt and (now - lt.replace(tzinfo=timezone.utc)).total_seconds() < 86400:
            return {"upgrade_available": True, "notified": False}
        await db["ops_alerts"].update_one(key, {"$set": {"ts": now, "dcs": where}}, upsert=True)
        which = ""
        if worst:
            which = (f"<p><b>Ξεκίνα από τον {worst['name']}</b> — είναι ο πιο φορτωμένος: "
                     f"p95 {worst['p95']}% / κορυφή {worst['peak']}% σε {METRIC_HOURS} ώρες.</p>")
        await _notify(
            db, f"⬆️ RxVision — διαθέσιμο {UPGRADE_TYPE} για αναβάθμιση των app nodes",
            f"<h3>Άνοιξε παράθυρο μετάπτωσης σε {UPGRADE_TYPE}</h3>"
            f"<p>8 vCPU / 16 GB / 160 GB — <b>+7,50 €/κόμβο</b> (από 8,49 σε 15,99 €).</p>"
            f"<p>Datacenters: {', '.join(where)}</p>"
            f"{which}"
            f"<p><b>Δεν έγινε τίποτα αυτόματα.</b> Το rescale σβήνει το μηχάνημα, οπότε γίνεται "
            f"εποπτευόμενα, <b>έναν κόμβο τη φορά</b>, στο παράθυρο των 22:30, με resize "
            f"<b>χωρίς δίσκο</b>.</p>"
            f"<p>⚠️ Η επιστροφή σε cx33 απαιτεί το cx33 να έχει τότε διαθεσιμότητα — σήμερα δεν "
            f"έχει. Θεώρησέ το μόνιμο.</p>")
        return {"upgrade_available": True, "notified": True, "dcs": where}

    try:
        return _run_async(_run())
    except Exception as exc:  # noqa: BLE001 — ποτέ δεν ρίχνει τον beat
        return {"ok": False, "error": str(exc)[:200]}
