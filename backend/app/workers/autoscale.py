"""Αυτόματη κλιμάκωση των app nodes (απόφαση ιδιοκτήτη 24/10/2026). Καλείται από τον φύλακα
(`workers.capacity`, κάθε 10′). Η ΕΚΤΕΛΕΣΗ γίνεται από τον ops-agent του MGMT01 (systemd,
ανεξάρτητος από Celery/Redis) με τα δοκιμασμένα scripts:
  · add_node    → infra/scripts/provision-app-node.sh  (δημιουργία, ίδιες εικόνες, υγεία, LB, λίστα deploy)
  · remove_node → infra/scripts/remove-app-node.sh     (εκτός LB, ομαλό σταμάτημα, διαγραφή)

ΚΑΝΟΝΕΣ (όπως τους όρισε ο ιδιοκτήτης):
  1. Ένας κόμβος ψηλά = τίποτα: ο LB και οι κοινές ουρές μοιράζουν ήδη τη δουλειά στους άλλους.
  2. ΟΛΟΙ οι app nodes ≥ 80% CPU ΣΥΝΕΧΩΣ για 30′ → +1 κόμβος (cx33 αν υπάρχει, αλλιώς ο
     φθηνότερος x86 με ≥4 vCPU/8 GB — έστω ακριβότερος). Πλαφόν: 2 αυτόματοι κόμβοι.
  3. Αυτόματος κόμβος ΟΧΙ cx33 + βρέθηκε cx33 → νέος cx33, και ΜΟΛΙΣ είναι υγιής στον LB
     αφαιρείται ο ακριβός.
  4. 7 ημέρες με ΟΛΟΥΣ τους app nodes < 40% (p95) → αφαίρεση του ακριβότερου αυτόματου κόμβου.
  5. Email σε ΚΑΘΕ προσθήκη/αφαίρεση/αντικατάσταση (αφορά χρήματα).
  ΠΟΤΕ αφαίρεση των αρχικών SRV01-03 (cx33 σπάνια) — φραγμός εδώ ΚΑΙ στο script.
  Μία ενέργεια τη φορά: όσο τρέχει add/remove, ή για 1 ώρα μετά, δεν γίνεται τίποτα άλλο.

ΟΠΛΙΣΗ: ενεργεί ΜΟΝΟ αν `platform_settings/autoscale.armed = true`. Μέχρι να περάσει η δοκιμή
δημιουργίας/αφαίρεσης από άκρη σε άκρη (θέλει έγκριση ιδιοκτήτη — πραγματική χρέωση), ο μηχανισμός
υπολογίζει και ΚΑΤΑΓΡΑΦΕΙ τι θα έκανε («would_*»), χωρίς να αγοράζει ή να διαγράφει.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

APP_PREFIX = "RxVisionSRV"
BASE_APP_NODES = {"RxVisionSRV01", "RxVisionSRV02", "RxVisionSRV03"}
MGMT_NODE = "RxVisionMGMT01"
LOCATION = "hel1"
CHEAP = "cx33"
LB_ID = 6614941
MAX_AUTO = 2
HOT_PCT, HOT_MINUTES = 80.0, 30
COLD_PCT, COLD_DAYS = 40.0, 7
COOLDOWN = timedelta(hours=1)
_API = "https://api.hetzner.cloud/v1"


# ── ΚΑΘΑΡΕΣ ΑΠΟΦΑΣΕΙΣ (τεστάρονται χωρίς δίκτυο) ───────────────────────────────────────────
def sustained_hot(values: list[float], cores: int, pct: float = HOT_PCT, minutes: int = HOT_MINUTES) -> bool:
    """ΟΛΑ τα δείγματα του διαστήματος ≥ pct (κανονικοποιημένα στους πυρήνες). Λιγότερα από
    τα 2/3 των αναμενόμενων δειγμάτων (60″) = άγνωστο = ΟΧΙ (δεν αγοράζουμε στα τυφλά)."""
    if len(values) < minutes * 2 // 3:
        return False
    return min(values) / max(cores, 1) >= pct


def p95(values: list[float], cores: int) -> float | None:
    if not values:
        return None
    v = sorted(values)
    return v[max(int(len(v) * 0.95) - 1, 0)] / max(cores, 1)


def price(t: dict | None, location: str = LOCATION) -> float:
    for p in (t or {}).get("prices") or []:
        if p.get("location") == location:
            try:
                return float((p.get("price_monthly") or {}).get("gross"))
            except (TypeError, ValueError):
                return 9e9
    return 9e9


def choose_type(types: list[dict], available: dict[str, list[str]], location: str = LOCATION) -> dict | None:
    """cx33 αν υπάρχει· αλλιώς ο ΦΘΗΝΟΤΕΡΟΣ x86, μη-καταργημένος, ≥4 vCPU, ≥8 GB, διαθέσιμος εδώ."""
    ok = [t for t in types if location in available.get(t.get("name"), [])
          and t.get("architecture") == "x86" and not t.get("deprecation") and not t.get("deprecated")
          and (t.get("cores") or 0) >= 4 and (t.get("memory") or 0) >= 8]
    cheap = next((t for t in ok if t.get("name") == CHEAP), None)
    return cheap or (min(ok, key=lambda t: price(t, location)) if ok else None)


def autoscaled(servers: list[dict]) -> list[dict]:
    return [s for s in servers if str(s.get("name", "")).startswith(APP_PREFIX)
            and s.get("name") not in BASE_APP_NODES]


def most_expensive(nodes: list[dict], types_by_name: dict[str, dict]) -> dict | None:
    if not nodes:
        return None
    return max(nodes, key=lambda s: (price(types_by_name.get((s.get("server_type") or {}).get("name"))),
                                     s.get("created") or ""))


# ── ΔΙΚΤΥΟ ────────────────────────────────────────────────────────────────────────────────
async def _cpu(cl, h, sid: int, start: datetime, end: datetime, step: int) -> list[float]:
    try:
        r = await cl.get(f"{_API}/servers/{sid}/metrics", headers=h,
                         params={"type": "cpu", "start": start.isoformat(), "end": end.isoformat(), "step": step})
        return [float(v[1]) for v in r.json()["metrics"]["time_series"]["cpu"]["values"]]
    except Exception:  # noqa: BLE001 — χωρίς μετρήσεις, καμία απόφαση δαπάνης
        return []


async def _lb_healthy(cl, h) -> set[int]:
    try:
        lb = (await cl.get(f"{_API}/load_balancers/{LB_ID}", headers=h)).json().get("load_balancer") or {}
    except Exception:  # noqa: BLE001
        return set()
    out = set()
    for t in lb.get("targets") or []:
        sid = (t.get("server") or {}).get("id")
        if sid and t.get("health_status") and all(x.get("status") == "healthy" for x in t["health_status"]):
            out.add(sid)
    return out


async def _event(db, kind: str, now: datetime, **kw) -> None:
    await db["autoscale_events"].insert_one({"kind": kind, "at": now, **kw})


class _Unarmed(Exception):
    """Απόφαση ελήφθη, αλλά ο μηχανισμός δεν είναι οπλισμένος — μόνο καταγραφή."""


async def _enqueue(db, now: datetime, typ: str, **kw) -> None:
    if not (await db["platform_settings"].find_one({"_id": "autoscale"}) or {}).get("armed"):
        await db["autoscale_events"].insert_one({"kind": f"would_{typ}", "at": now, **kw})
        raise _Unarmed(typ)
    await db["ops_commands"].insert_one({"type": typ, "node": MGMT_NODE, "status": "pending",
                                         "requested_at": now, "requested_by": "autoscale", **kw})


async def run(db, cl, h, types: list[dict], servers: list[dict], now: datetime, notify,
              *, db_move_pending: bool = False) -> dict:
    try:
        await _report_failed_adds(db, notify)
        return await _decide(db, cl, h, types, servers, now, notify, db_move_pending=db_move_pending)
    except _Unarmed as u:
        return {"autoscale": f"would_{u}", "armed": False}


async def _report_failed_adds(db, notify) -> None:
    """Αυτόματη προσθήκη που ΑΠΕΤΥΧΕ (provision: ΣΦΑΛΜΑ/unhealthy) → email μία φορά."""
    async for c in db["ops_commands"].find({"requested_by": "autoscale", "status": "done",
                                            "reported": {"$ne": True}}):
        res = str(c.get("result") or "")
        if c.get("type") in ("add_node", "remove_node") and ("ΣΦΑΛΜΑ" in res or "unhealthy" in res
                                                            or "refused" in res or "failed" in res):
            await notify(db, f"🚨 RxVision — αυτόματο {c['type']} ΑΠΕΤΥΧΕ",
                         f"<p><code>{res[:300]}</code></p><p>Έλεγξε αν έμεινε server εκτός Load "
                         f"Balancer στη Hetzner (χρεώνεται).</p>")
        await db["ops_commands"].update_one({"_id": c["_id"]}, {"$set": {"reported": True}})


async def _decide(db, cl, h, types: list[dict], servers: list[dict], now: datetime, notify,
                  *, db_move_pending: bool = False) -> dict:
    from app.services import hetzner_catalog as hc

    by_name = {t.get("name"): t for t in types}
    avail = {t.get("name"): hc.available_in(t) for t in types}
    app = [s for s in servers if str(s.get("name", "")).startswith(APP_PREFIX) and s.get("status") == "running"]
    auto = autoscaled(servers)

    # ── 0. ΜΙΑ ΕΝΕΡΓΕΙΑ ΤΗ ΦΟΡΑ ──────────────────────────────────────────────────────────
    busy = await db["ops_commands"].find_one({"type": {"$in": ["add_node", "remove_node"]},
                                             "status": {"$in": ["pending", "running"]}})
    recent = await db["ops_commands"].find_one({"type": {"$in": ["add_node", "remove_node"]},
                                               "requested_at": {"$gte": now - COOLDOWN}})
    rep = await db["ops_alerts"].find_one({"_id": "autoscale:replace"})

    # ── 3β. ΑΝΤΙΚΑΤΑΣΤΑΣΗ σε εξέλιξη: ο νέος cx33 είναι υγιής στον LB → έξω ο ακριβός ──────────
    if rep and not busy:
        old = next((s for s in auto if s.get("name") == rep.get("old")), None)
        newer = [s for s in auto if (s.get("server_type") or {}).get("name") == CHEAP
                 and (s.get("created") or "") > (old or {}).get("created", "")]
        healthy = await _lb_healthy(cl, h)
        if not old:
            await db["ops_alerts"].delete_one({"_id": "autoscale:replace"})
        elif any(s["id"] in healthy for s in newer):
            await _enqueue(db, now, "remove_node", name=old["name"], reason="replaced_by_cx33")
            await db["ops_alerts"].delete_one({"_id": "autoscale:replace"})
            await _event(db, "replace_remove", now, name=old["name"])
            await notify(db, f"🔁 RxVision — αντικατάσταση: αφαιρείται ο {old['name']} ({old['server_type']['name']})",
                         f"<p>Ο νέος {CHEAP} είναι υγιής στον Load Balancer· ο ακριβότερος "
                         f"<b>{old['name']}</b> ({old['server_type']['name']}, "
                         f"{price(by_name.get(old['server_type']['name'])):.2f} €/μήνα) αφαιρείται.</p>")
            return {"autoscale": "replace_remove", "name": old["name"]}
        elif rep.get("requested_at") and now - rep["requested_at"].replace(tzinfo=timezone.utc) > timedelta(hours=2):
            await db["ops_alerts"].delete_one({"_id": "autoscale:replace"})   # απέτυχε — ξαναδοκιμάζει αργότερα
            return {"autoscale": "replace_timeout"}
        else:
            return {"autoscale": "replace_waiting"}
    if busy or recent:
        return {"autoscale": "busy_or_cooldown"}

    end = now
    # ── 2. ΟΛΟΙ ΖΕΣΤΟΙ για 30′ → +1 κόμβος ───────────────────────────────────────────────
    hot = []
    for s in app:
        vals = await _cpu(cl, h, s["id"], end - timedelta(minutes=HOT_MINUTES), end, 60)
        hot.append(sustained_hot(vals, (s.get("server_type") or {}).get("cores") or 1))
    if app and all(hot):
        if len(auto) >= MAX_AUTO:
            await _event(db, "cap_reached", now, nodes=len(app))
            key = {"_id": "autoscale:cap_alert"}
            last = await db["ops_alerts"].find_one(key)
            if not last or now - last["ts"].replace(tzinfo=timezone.utc) > timedelta(hours=24):
                await db["ops_alerts"].update_one(key, {"$set": {"ts": now}}, upsert=True)
                await notify(db, "⚠️ RxVision — όλοι οι app servers στο 80% και έφτασε το όριο αυτόματων",
                             f"<p>{len(app)} κόμβοι, όλοι ≥{HOT_PCT:.0f}% για {HOT_MINUTES}′. Υπάρχουν ήδη "
                             f"{len(auto)} αυτόματοι (όριο {MAX_AUTO}). Χρειάζεται απόφαση.</p>")
            return {"autoscale": "cap_reached"}
        t = choose_type(types, avail)
        if not t:
            return {"autoscale": "no_type_available"}
        await _enqueue(db, now, "add_node", server_type=t["name"], location=LOCATION, reason="all_hot")
        await _event(db, "add", now, type=t["name"], eur=price(t))
        await notify(db, f"➕ RxVision — προστίθεται app server ({t['name']}, {price(t):.2f} €/μήνα)",
                     f"<p>Όλοι οι {len(app)} app servers ήταν ≥{HOT_PCT:.0f}% CPU για {HOT_MINUTES}′.</p>"
                     f"<p>Νέος κόμβος <b>{t['name']}</b> ({t.get('cores')} vCPU / {t.get('memory')} GB) "
                     f"στο {LOCATION}, <b>{price(t):.2f} €/μήνα</b>. Μπαίνει στον Load Balancer μόλις "
                     f"απαντήσει υγιής (~15′).</p>"
                     + ("" if t["name"] == CHEAP else
                        f"<p>Δεν υπήρχε {CHEAP}· μόλις βρεθεί, αντικαθίσταται αυτόματα.</p>"))
        return {"autoscale": "add", "type": t["name"]}

    # ── 3α. ΑΚΡΙΒΟΣ αυτόματος κόμβος + βρέθηκε cx33 → νέος cx33 (η βάση έχει προτεραιότητα) ──────
    pricey = [s for s in auto if (s.get("server_type") or {}).get("name") != CHEAP]
    if pricey and LOCATION in avail.get(CHEAP, []) and not db_move_pending:
        old = most_expensive(pricey, by_name)
        await _enqueue(db, now, "add_node", server_type=CHEAP, location=LOCATION, reason=f"replace:{old['name']}")
        await db["ops_alerts"].update_one({"_id": "autoscale:replace"},
                                          {"$set": {"old": old["name"], "requested_at": now}}, upsert=True)
        await _event(db, "replace_add", now, old=old["name"])
        await notify(db, f"🔁 RxVision — βρέθηκε {CHEAP}: αντικατάσταση του {old['name']}",
                     f"<p>Δημιουργείται νέος <b>{CHEAP}</b> ({price(by_name.get(CHEAP)):.2f} €/μήνα). Μόλις "
                     f"είναι υγιής στον Load Balancer, αφαιρείται ο <b>{old['name']}</b> "
                     f"({old['server_type']['name']}, {price(by_name.get(old['server_type']['name'])):.2f} €/μήνα).</p>")
        return {"autoscale": "replace_add", "old": old["name"]}

    # ── 4. 7 ΗΜΕΡΕΣ ΚΡΥΟΙ → αφαίρεση του ακριβότερου αυτόματου ─────────────────────────────
    if auto:
        last_change = await db["autoscale_events"].find_one(
            {"kind": {"$in": ["add", "remove", "replace_add", "replace_remove"]}}, sort=[("at", -1)])
        if last_change and now - last_change["at"].replace(tzinfo=timezone.utc) < timedelta(days=COLD_DAYS):
            return {"autoscale": "steady"}
        cold = []
        for s in app:
            vals = await _cpu(cl, h, s["id"], end - timedelta(days=COLD_DAYS), end, 3600)
            v = p95(vals, (s.get("server_type") or {}).get("cores") or 1)
            cold.append(v is not None and len(vals) >= COLD_DAYS * 24 * 2 // 3 and v < COLD_PCT)
        if app and all(cold):
            old = most_expensive(auto, by_name)
            await _enqueue(db, now, "remove_node", name=old["name"], reason="cold_7d")
            await _event(db, "remove", now, name=old["name"])
            await notify(db, f"➖ RxVision — αφαιρείται app server {old['name']} (χαμηλός φόρτος 7 ημερών)",
                         f"<p>Όλοι οι app servers κάτω από {COLD_PCT:.0f}% (p95) για {COLD_DAYS} ημέρες.</p>"
                         f"<p>Αφαιρείται ο <b>{old['name']}</b> ({old['server_type']['name']}) — "
                         f"εξοικονόμηση <b>{price(by_name.get(old['server_type']['name'])):.2f} €/μήνα</b>.</p>")
            return {"autoscale": "remove", "name": old["name"]}
    return {"autoscale": "steady"}
