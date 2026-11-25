"""Πολιτική πρόσβασης — ΦΑΣΗ 2: όρια ρυθμού, strikes, εξαγωγές (οδηγία 25/11/2026, ενότητες 4.3–4.4).

ΔΙΑΚΟΠΤΗΣ «μέτρηση / επιβολή» (platform_settings/access_policy.mode):
  * observe (προεπιλογή): ΚΑΝΕΝΑ 429. Καταγράφεται ποιος ΘΑ έπαιρνε 429 (`would_limit`, ανά χρήστη/ημέρα)
    → ο ιδιοκτήτης βλέπει ότι κανένας κανονικός χρήστης δεν επηρεάζεται ΠΡΙΝ ενεργοποιήσει (κριτήριο 6).
  * enforce: υπέρβαση → 429 + strike· `strikes_to_lock` strikes μέσα σε `strike_window_min` → κλείδωμα
    24 ωρών (ίδιο με το webdriver: ξεκλείδωμα ΜΟΝΟ από adminpanel).

Κανόνες ανά χρήστη (κλειδί = χρήστης από ΕΠΑΛΗΘΕΥΜΕΝΟ token, όχι IP):
  per_min · per_hour · list_per_min (GET με limit/page/offset) · detail_per_min (GET …/<id>).
Admin & «σύνδεση ως πελάτης» → εκτός ορίων (ΟΧΙ εκτός καταγραφής). Ανά φαρμακείο: ΜΟΝΟ αυστηρότερα
(`tenants.access_limits`) — ποτέ χαλαρότερα (4.7).

Fail OPEN για τους μετρητές (Redis κάτω → καμία άρνηση, το AI-browser μπλοκ μένει fail closed).
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

DEFAULTS: dict = {
    "mode": "observe",          # observe | enforce
    "per_min": 25,
    "per_hour": 300,
    "list_per_min": 4,
    "detail_per_min": 15,
    "exports_per_day": 3,
    "export_max_rows": 2000,
    "strikes_to_lock": 2,
    "strike_window_min": 10,
}
RULES = ("per_min", "per_hour", "list_per_min", "detail_per_min")
INT_KEYS = tuple(k for k in DEFAULTS if k != "mode")
SETTINGS_ID = "access_policy"
EXPORTS = "access_exports"

_LIST_Q = re.compile(r"(?:^|&)(?:limit|size|page_size|page|offset|skip)=", re.I)
# τελευταίο τμήμα που μοιάζει με αναγνωριστικό εγγραφής: ObjectId, UUID, αριθμός ≥5 ψηφίων, barcode
_ID_SEG = re.compile(r"/(?:[0-9a-f]{24}|[0-9a-f-]{32,36}|\d{5,}[A-Za-z0-9:]*)/?$", re.I)

_cache: dict = {"at": 0.0, "val": None}
_tcache: dict[str, tuple[float, dict]] = {}


def classify_request(method: str, path: str, query: str) -> str | None:
    """'list' | 'detail' | None — για τους κανόνες list_per_min / detail_per_min."""
    if method != "GET":
        return None
    if _LIST_Q.search(query or ""):
        return "list"
    if _ID_SEG.search(path or ""):
        return "detail"
    return None


def _clean(doc: dict | None) -> dict:
    out = dict(DEFAULTS)
    for k, v in (doc or {}).items():
        if k == "mode" and v in ("observe", "enforce"):
            out["mode"] = v
        elif k in INT_KEYS:
            try:
                iv = int(v)
            except (TypeError, ValueError):
                continue
            if iv > 0:
                out[k] = iv
    return out


async def settings(db=None, *, fresh: bool = False) -> dict:
    """Ρυθμίσεις πλατφόρμας (cache 30″ ανά διεργασία)."""
    if not fresh and _cache["val"] is not None and time.monotonic() - _cache["at"] < 30:
        return _cache["val"]
    try:
        if db is None:
            from app.core.db import shared_db
            db = shared_db()
        doc = await db["platform_settings"].find_one({"_id": SETTINGS_ID})  # tenant-ok: platform settings
        val = _clean(doc)
    except Exception:  # noqa: BLE001 — fail-open: προεπιλογές (observe)
        val = dict(DEFAULTS)
    _cache.update(at=time.monotonic(), val=val)
    return val


async def save_settings(db, data: dict, *, admin_id: str) -> dict:
    val = _clean({**(await settings(db, fresh=True)), **(data or {})})
    await db["platform_settings"].update_one(  # tenant-ok: platform settings
        {"_id": SETTINGS_ID}, {"$set": {**val, "updated_at": datetime.now(tz=timezone.utc),
                                        "updated_by": admin_id}}, upsert=True)
    _cache.update(at=0.0, val=None)
    return val


async def tenant_limits(db, tenant_id: str | None, base: dict) -> dict:
    """Όρια για το φαρμακείο: ΜΟΝΟ αυστηρότερα από της πλατφόρμας (min) — ποτέ χαλαρότερα."""
    if not tenant_id:
        return base
    hit = _tcache.get(tenant_id)
    if hit and time.monotonic() - hit[0] < 60:
        own = hit[1]
    else:
        try:
            if db is None:
                from app.core.db import shared_db
                db = shared_db()
            t = await db["tenants"].find_one({"_id": tenant_id}, {"access_limits": 1})  # tenant-ok
            own = (t or {}).get("access_limits") or {}
        except Exception:  # noqa: BLE001
            own = {}
        _tcache[tenant_id] = (time.monotonic(), own)
    out = dict(base)
    for k in INT_KEYS:
        try:
            v = int(own.get(k) or 0)
        except (TypeError, ValueError):
            continue
        if 0 < v < out[k]:
            out[k] = v
    return out


def stricter_only(platform: dict, requested: dict) -> dict:
    """Επικύρωση ορίων ανά φαρμακείο: κρατά μόνο τιμές ΑΥΣΤΗΡΟΤΕΡΕΣ από της πλατφόρμας."""
    out = {}
    for k in INT_KEYS:
        if k not in (requested or {}):
            continue
        try:
            v = int(requested[k])
        except (TypeError, ValueError):
            continue
        if 0 < v <= platform[k]:
            out[k] = v
    return out


async def check(r, *, member: str, kind: str, tid: str | None, exempt: bool, method: str, path: str,
                query: str, minute_count: int, now: datetime, db=None) -> tuple[str | None, int]:
    """Ελέγχει τους κανόνες για ΕΝΑ αίτημα (ο μετρητής λεπτού έχει ήδη αυξηθεί από τη μέτρηση).
    Επιστρέφει (κανόνας που παραβιάστηκε ή None, retry_after δευτερόλεπτα). Στο observe ΠΟΤΕ δεν αρνείται."""
    if exempt or kind == "admin":
        return None, 0
    cfg = await tenant_limits(db, tid, await settings(db))
    hour = now.strftime("%Y%m%d%H")
    minute = now.strftime("%Y%m%d%H%M")
    cls = classify_request(method, path, query)
    pipe = r.pipeline(transaction=False)
    pipe.incr(f"acc:h:{hour}:{member}")
    pipe.expire(f"acc:h:{hour}:{member}", 7200)
    if cls:
        pipe.incr(f"acc:{cls}:{minute}:{member}")
        pipe.expire(f"acc:{cls}:{minute}:{member}", 180)
    res = await pipe.execute()
    counts = {"per_min": minute_count, "per_hour": int(res[0])}
    if cls:
        counts[f"{cls}_per_min"] = int(res[2])
    broken = next((k for k in RULES if k in counts and counts[k] > cfg[k]), None)
    if not broken:
        return None, 0
    first = counts[broken] == cfg[broken] + 1          # ΠΡΩΤΗ υπέρβαση στο παράθυρο → ένα strike, όχι ανά αίτημα
    retry = 3600 - (now.minute * 60 + now.second) if broken == "per_hour" else 60 - now.second
    day = now.strftime("%Y-%m-%d")
    if first:
        await _note(db, day=day, member=member, rule=broken, enforce=cfg["mode"] == "enforce")
    if cfg["mode"] != "enforce":
        return None, 0
    if first:
        await _strike(r, db, member=member, kind=kind, tid=tid, rule=broken, cfg=cfg)
    return broken, max(1, retry)


async def _note(db, *, day: str, member: str, rule: str, enforce: bool) -> None:
    """Ανά χρήστη/ημέρα: πόσες φορές ξεπέρασε (ή ΘΑ ξεπερνούσε) κάθε όριο."""
    try:
        if db is None:
            from app.core.db import shared_db
            db = shared_db()
        kind, uid, tid = (member.split("|") + ["", "", ""])[:3]
        from app.services.access_policy import USERS
        await db[USERS].update_one(  # tenant-ok: platform metrics ανά χρήστη
            {"_id": f"{day}:{kind}:{uid}:{tid}"},
            {"$inc": {f"over.{rule}": 1}, "$set": {"day": day, "kind": kind, "uid": uid,
                                                   "tenant_id": tid or None}}, upsert=True)
        from app.services.access_policy import record
        await record("rate_limit_exceeded" if enforce else "would_limit", kind=kind, uid=uid, tid=tid or None,
                     extra={"rule": rule}, throttle_key=f"{member}:{rule}")
    except Exception as exc:  # noqa: BLE001
        log.debug("access over-limit note skipped: %s", exc)


async def _strike(r, db, *, member: str, kind: str, tid: str | None, rule: str, cfg: dict) -> None:
    key = f"acc:strike:{member}"
    n = int(await r.incr(key))
    if n == 1:
        await r.expire(key, cfg["strike_window_min"] * 60)
    if n >= cfg["strikes_to_lock"]:
        await r.delete(key)
        if db is None:
            from app.core.db import shared_db
            db = shared_db()
        uid = member.split("|")[1]
        from app.services.access_policy import lock_account
        await lock_account(db, kind=kind, uid=uid, tid=tid,
                           reason=f"{n} υπερβάσεις ορίων μέσα σε {cfg['strike_window_min']}′ (τελευταία: {rule})")


# ── εξαγωγές (4.4) ───────────────────────────────────────────────────────────────────────────
async def export_authorize(db, *, kind: str, uid: str, tid: str | None, exempt: bool, fmt: str,
                           screen: str, rows: int, filters: str, ip: str, ua: str,
                           user_label: str | None) -> dict:
    """Πριν από κάθε εξαγωγή: όριο ανά ημέρα (σε επιβολή), όριο γραμμών, υδατογράφημα, καταγραφή.
    Επιστρέφει {allowed, id, watermark, max_rows, used_today, limit}."""
    cfg = await tenant_limits(db, tid, await settings(db))
    now = datetime.now(tz=timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    used = await db[EXPORTS].count_documents({  # tenant-ok: platform security log (ανά χρήστη)
        "kind": kind, "uid": uid, "at": {"$gte": start}, "status": {"$ne": "denied"}})
    over = used >= cfg["exports_per_day"] and not exempt and kind != "admin"
    enforce = cfg["mode"] == "enforce"
    status = "denied" if (over and enforce) else "allowed"
    from zoneinfo import ZoneInfo
    local = now.astimezone(ZoneInfo("Europe/Athens")).strftime("%d/%m/%Y %H:%M")
    watermark = f"Εξαγωγή RxVision · {user_label or uid} · {local} · εμπιστευτικό (δεδομένα υγείας)"
    doc = {"kind": kind, "uid": uid, "tenant_id": tid, "format": (fmt or "")[:10], "screen": (screen or "")[:200],
           "filters": (filters or "")[:500], "rows_requested": int(rows or 0),
           "rows": min(int(rows or 0), cfg["export_max_rows"]), "at": now, "ip": (ip or "")[:64],
           "ua": (ua or "")[:300], "status": status, "over_limit": over, "sha256": None}
    res = await db[EXPORTS].insert_one(doc)  # tenant-ok: platform security log
    if over:
        from app.services.access_policy import record
        await record("export_limit" if enforce else "would_limit", kind=kind, uid=uid, tid=tid, ip=ip, ua=ua,
                     extra={"rule": "exports_per_day", "used": used}, throttle_key=f"{kind}:{uid}:exports")
        if enforce:
            from app.services.access_policy import _email_admins
            await _email_admins(db, kind=kind, uid=uid, tid=tid,
                                reason=f"υπέρβαση ορίου εξαγωγών ({used + 1}η σήμερα, όριο {cfg['exports_per_day']})",
                                ua=ua, ip=ip)
    return {"allowed": status == "allowed", "id": str(res.inserted_id), "watermark": watermark,
            "max_rows": cfg["export_max_rows"], "used_today": used + (1 if status == "allowed" else 0),
            "limit": cfg["exports_per_day"], "mode": cfg["mode"]}


async def export_done(db, export_id: str, *, uid: str, sha256: str, rows: int) -> bool:
    from bson import ObjectId
    if not ObjectId.is_valid(export_id) or not re.fullmatch(r"[0-9a-f]{64}", sha256 or ""):
        return False
    r = await db[EXPORTS].update_one(  # tenant-ok: ο ίδιος ο χρήστης (uid) ολοκληρώνει τη δική του εγγραφή
        {"_id": ObjectId(export_id), "uid": uid, "sha256": None},
        {"$set": {"sha256": sha256, "rows": int(rows or 0), "done_at": datetime.now(tz=timezone.utc)}})
    return r.modified_count == 1


async def exports_report(db, *, days: int = 7) -> list[dict]:
    since = datetime.now(tz=timezone.utc) - timedelta(days=days)
    return await db[EXPORTS].find({"at": {"$gte": since}}).sort(  # tenant-ok: platform security log
        "at", -1).limit(200).to_list(200)
