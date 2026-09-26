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
        import httpx
        db = _fresh_db()
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
            if not hits:
                return {"ok": True, "available": False, "checked": now.isoformat()}

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

    try:
        return _run_async(_run())
    except Exception as exc:  # noqa: BLE001 — ποτέ δεν ρίχνει τον beat
        return {"ok": False, "error": str(exc)[:200]}
