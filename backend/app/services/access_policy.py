"""Πολιτική πρόσβασης: AI browsers, αυτοματισμοί, μαζική άντληση (οδηγία 25/11/2026).

ΚΑΝΟΝΑΣ ΙΔΙΟΚΤΗΤΗ (25/11/2026): «το Claude Desktop απαγορεύεται εντελώς να πάρει δεδομένα — ούτε ένα».

ΦΑΣΗ 1 — ΑΠΟΚΛΕΙΣΜΟΣ
  * AI browser / scripted browser (`AI_BROWSER_RE`: Claude/, Comet/, Atlas, Operator/, HeadlessChrome,
    Playwright…) → 403 σε ΚΑΘΕ αίτημα API, ΠΡΙΝ από οποιονδήποτε έλεγχο token (ούτε το login απαντά).
    Fail CLOSED: σκέτο regex, καμία εξάρτηση από Redis/Mongo, καμία εξαίρεση. Οι σελίδες κόβονται από
    τον middleware του Next (frontend/src/middleware.ts) με τον ΙΔΙΟ κανόνα.
  * Εργαλεία script (`SCRIPT_RE`: curl/, python-requests, Go-http-client) → 403 ΜΟΝΟ με token χρήστη:
    τα χρησιμοποιούν νόμιμα webhooks/SoftOne/ICS (χωρίς token χρήστη).
  * Beacon `navigator.webdriver` (`POST /access/beacon`) → κλείδωμα λογαριασμού 24 ωρών (Mongo = πηγή
    αλήθειας, Redis = γρήγορο κόψιμο κάθε αιτήματος), ακύρωση ΟΛΩΝ των refresh tokens/συνεδριών, email
    στους διαχειριστές. Ξεκλείδωμα ΜΟΝΟ από το adminpanel με αιτιολογία. Admin & «σύνδεση ως πελάτης»
    (imp) → μόνο καταγραφή (QA/υποστήριξη).

ΦΑΣΗ 0 — ΜΕΤΡΗΣΗ (συνεχίζει): αιτήματα/λεπτό ανά χρήστη → p99 → από εκεί τα όρια της Φάσης 2.

Partner API (`/api/partner`) εκτός (μηχανή-προς-μηχανή, δικά του κλειδιά/όρια).
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta, timezone

from app.core.ratelimit import _redis, client_ip

log = logging.getLogger(__name__)

AI_BROWSER_RE = re.compile(
    r"Claude/\d|Comet/\d|ChatGPT-Atlas|Atlas/\d|HeadlessChrome|Playwright|Puppeteer|Selenium|"
    r"PhantomJS|WebDriver|BrowserUse|Operator/\d",
    re.I)
SCRIPT_RE = re.compile(r"python-requests|Go-http-client|curl/", re.I)
AGENT_RE = re.compile(AI_BROWSER_RE.pattern + "|" + SCRIPT_RE.pattern, re.I)   # για αναφορές

BLOCK_MSG = ("Η πρόσβαση μέσω AI browser ή αυτοματοποιημένου εργαλείου δεν επιτρέπεται. "
             "Το RxVision επεξεργάζεται δεδομένα υγείας.")
LOCK_MSG = ("Ο λογαριασμός κλειδώθηκε προσωρινά επειδή εντοπίστηκε αυτοματοποιημένη πρόσβαση. "
            "Επικοινωνήστε με την υποστήριξη του RxVision.")

EXEMPT_PREFIXES = ("/api/partner",)
# Εκτός ορίων ρυθμού (όχι εκτός μέτρησης): ο έλεγχος «ποιος είναι μέσα» της ζωντανής υποστήριξης ανά 10″,
# το refresh token και το beacon/καταγραφή εξαγωγών — δεν είναι άντληση δεδομένων.
LIMIT_EXEMPT = ("/api/v1/support-live/incoming", "/api/v1/auth/refresh", "/api/v1/patient/auth/refresh",
                "/api/v1/access/")
RATE_MSG = "Πάρα πολλά αιτήματα σε σύντομο χρόνο. Περιμένετε λίγο και δοκιμάστε ξανά."
BIG_LIMIT = 50                      # το μελλοντικό ανώτατο `limit` ανά σελίδα από browser
LOCK_HOURS = 24
_TTL = 3 * 3600                     # τα λεπτά ζουν 3 ώρες στο Redis — ο aggregator τρέχει ανά 5′
_HIST_CAP = 300                     # >300/λεπτό → ένας κάδος «300»

DAILY = "access_metrics_daily"      # {_id: "YYYY-MM-DD:kind", hist: {"<αιτήματα/λεπτό>": λεπτά}}
USERS = "access_user_daily"         # ανά χρήστη/ημέρα: max/λεπτό, σύνολο, ενεργά λεπτά, big_limit
EVENTS = "access_events"            # agent_blocked / automation_flagged / account_locked / unlocked
LOCKS = "access_locks"              # {kind, uid, tenant_id, until, reason, released_at…}


def _minute(now: datetime) -> str:
    return now.strftime("%Y%m%d%H%M")


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def classify(ua: str | None) -> str | None:
    """'ai' (403 παντού) | 'script' (403 με token χρήστη) | None."""
    if not ua:
        return None
    if AI_BROWSER_RE.search(ua):
        return "ai"
    if SCRIPT_RE.search(ua):
        return "script"
    return None


def identify_claims(auth_header: str | None) -> tuple[str, str, str | None, dict] | None:
    """(kind, uid, tenant_id, claims) από ΕΠΑΛΗΘΕΥΜΕΝΟ token — ποτέ από ανυπόγραφο (αλλιώς κάποιος θα
    «φόρτωνε» μετρητές ή κλείδωνε άλλον χρήστη). None = όχι αίτημα χρήστη (webhook, ICS, ανώνυμο)."""
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return None
    tok = auth_header[7:].strip()
    from app.core.security import decode_patient_token, decode_platform_token, decode_token
    for kind, fn in (("tenant", decode_token), ("admin", decode_platform_token),
                     ("patient", decode_patient_token)):
        try:
            c = fn(tok)
        except Exception:  # noqa: BLE001
            continue
        if c.get("scope") not in (None, "access"):
            return None
        if kind == "tenant" and c.get("padmin"):
            kind = "admin"
        return kind, str(c.get("sub")), (str(c["tid"]) if c.get("tid") else None), c
    return None


def identify(auth_header: str | None) -> tuple[str, str, str | None] | None:
    w = identify_claims(auth_header)
    return w[:3] if w else None


def _limit_of(query: str) -> int:
    m = re.search(r"(?:^|&)(?:limit|size|page_size)=(\d+)", query or "")
    return int(m.group(1)) if m else 0


# Throttle γεγονότων ΜΕΣΑ στη διεργασία: δουλεύει και χωρίς Redis (ένας agent που χτυπά χιλιάδες φορές
# δεν γράφει χιλιάδες γραμμές).
_SEEN: dict[str, float] = {}


def _first_in(key: str, seconds: int) -> bool:
    now = time.monotonic()
    if len(_SEEN) > 5000:
        _SEEN.clear()
    if now - _SEEN.get(key, -1e9) < seconds:
        return False
    _SEEN[key] = now
    return True


async def record(type_: str, *, kind: str | None = None, uid: str | None = None, tid: str | None = None,
                 ua: str = "", ip: str = "", path: str = "", extra: dict | None = None,
                 throttle_key: str | None = None) -> None:
    """Γεγονός ασφαλείας (best-effort, ποτέ δεν ρίχνει αίτημα)."""
    if throttle_key and not _first_in(f"{type_}:{throttle_key}", 3600):
        return
    try:
        from app.core.db import shared_db
        sig = AGENT_RE.search(ua or "")
        await shared_db()[EVENTS].insert_one({  # tenant-ok: platform security log
            "type": type_, "at": _now(), "kind": kind, "uid": uid, "tenant_id": tid,
            "signature": sig.group(0) if sig else None, "ua": (ua or "")[:300], "ip": (ip or "")[:64],
            "path": (path or "")[:200], **(extra or {})})
    except Exception as exc:  # noqa: BLE001
        log.debug("access event skipped: %s", exc)


async def observe(*, path: str, query: str, auth: str | None, ua: str, ip: str,
                  now: datetime | None = None, who: tuple | None = None) -> int:
    """Μέτρηση ενός αιτήματος (Φάση 0). Επιστρέφει τον μετρητή του λεπτού (0 = άγνωστος). Fail-open."""
    if path.startswith(EXEMPT_PREFIXES):
        return 0
    who = who or identify(auth)
    if not who:
        return 0
    kind, uid, tid = who[:3]
    now = now or _now()
    m = _minute(now)
    member = f"{kind}|{uid}|{tid or ''}"
    try:
        r = _redis()
        pipe = r.pipeline(transaction=False)
        pipe.incr(f"acc:c:{m}:{member}")
        pipe.expire(f"acc:c:{m}:{member}", _TTL)
        pipe.sadd(f"acc:mins:{m}", member)
        pipe.expire(f"acc:mins:{m}", _TTL)
        if _limit_of(query) > BIG_LIMIT:
            pipe.incr(f"acc:big:{m}:{member}")
            pipe.expire(f"acc:big:{m}:{member}", _TTL)
        res = await pipe.execute()
        return int(res[0] or 0)
    except Exception as exc:  # noqa: BLE001 — η μέτρηση δεν ρίχνει ΠΟΤΕ αίτημα
        log.debug("access observe skipped: %s", exc)
        return 0


# ── κλείδωμα λογαριασμού ─────────────────────────────────────────────────────────────────────
def _lock_key(kind: str, uid: str) -> str:
    return f"acc:lock:{kind}:{uid}"


async def locked_fast(kind: str, uid: str) -> bool:
    """Γρήγορος έλεγχος (Redis) σε ΚΑΘΕ αίτημα. Fail-open: τα login/refresh ελέγχουν τη Mongo."""
    try:
        return bool(await _redis().exists(_lock_key(kind, uid)))
    except Exception:  # noqa: BLE001
        return False


async def is_locked(db, kind: str, uid: str) -> bool:
    """Πηγή αλήθειας (Mongo) — login/refresh."""
    return bool(await db[LOCKS].find_one({  # tenant-ok: platform security locks
        "kind": kind, "uid": str(uid), "until": {"$gt": _now()}, "released_at": None}, {"_id": 1}))


async def lock_account(db, *, kind: str, uid: str, tid: str | None, reason: str, ua: str = "",
                       ip: str = "") -> dict:
    """Κλείδωμα 24 ωρών + ακύρωση ΟΛΩΝ των συνεδριών/refresh tokens + email στους διαχειριστές."""
    now = _now()
    until = now + timedelta(hours=LOCK_HOURS)
    if await is_locked(db, kind, uid):
        return {"locked": True, "already": True}
    doc = {"kind": kind, "uid": str(uid), "tenant_id": tid, "reason": reason, "at": now, "until": until,
           "ua": (ua or "")[:300], "ip": (ip or "")[:64], "released_at": None}
    await db[LOCKS].insert_one(doc)  # tenant-ok: platform security locks
    try:
        await _redis().set(_lock_key(kind, uid), "1", ex=LOCK_HOURS * 3600)
    except Exception:  # noqa: BLE001 — η Mongo είναι η πηγή αλήθειας (login/refresh)
        pass
    await _revoke(db, kind, uid)
    await record("account_locked", kind=kind, uid=str(uid), tid=tid, ua=ua, ip=ip, extra={"reason": reason})
    await _email_admins(db, kind=kind, uid=str(uid), tid=tid, reason=reason, ua=ua, ip=ip)
    return {"locked": True, "until": until}


async def _revoke(db, kind: str, uid: str) -> None:
    from bson import ObjectId
    try:
        if kind == "tenant" and ObjectId.is_valid(uid):
            await db["users"].update_one(  # tenant-ok: ο ίδιος ο χρήστης (κλείδωμα ασφαλείας)
                {"_id": ObjectId(uid)}, {"$inc": {"refresh_token_version": 1}})
            from app.services import session_service
            await session_service.close_user_sessions(uid)
        elif kind == "patient":
            from app.repositories.patient_portal import PatientAccountRepository
            await PatientAccountRepository().revoke_tokens(uid)
    except Exception as exc:  # noqa: BLE001 — το κλείδωμα ισχύει ούτως ή άλλως (Mongo + Redis)
        log.warning("access lock revoke failed %s:%s: %s", kind, uid, exc)


async def _email_admins(db, *, kind, uid, tid, reason, ua, ip) -> None:
    try:
        from app.services import mailer
        admins = [a["email"] async for a in db["platform_admins"].find(  # tenant-ok
            {"status": "active"}, {"email": 1}) if a.get("email")]
        tname = None
        if tid:
            t = await db["tenants"].find_one({"_id": tid}, {"name": 1})  # tenant-ok
            tname = (t or {}).get("name")
        who = {"tenant": "Χρήστης φαρμακείου", "patient": "Πελάτης πύλης"}.get(kind, kind)
        html = ("<h3>🔒 RxVision — Κλείδωμα λογαριασμού (αυτοματοποιημένη πρόσβαση)</h3>"
                f"<p><b>{who}</b> · id {uid}{f' · φαρμακείο {tname}' if tname else ''}</p>"
                f"<p>Αιτία: {reason}<br>IP: {ip}<br>User agent: {ua}</p>"
                f"<p>Κλειδωμένος για {LOCK_HOURS} ώρες. Ξεκλείδωμα μόνο από adminpanel → "
                "Λειτουργία & Παρακολούθηση → Πρόσβαση & αυτοματισμοί.</p>")
        if admins:
            await mailer.send_bulk(admins, "🔒 RxVision — Κλείδωμα λογαριασμού (αυτοματισμός)", html)
    except Exception as exc:  # noqa: BLE001
        log.warning("access lock email failed: %s", exc)


async def unlock(db, lock_id: str, *, admin_id: str, reason: str) -> bool:
    from bson import ObjectId
    if not ObjectId.is_valid(lock_id):
        return False
    lk = await db[LOCKS].find_one({"_id": ObjectId(lock_id), "released_at": None})  # tenant-ok
    if not lk:
        return False
    await db[LOCKS].update_one({"_id": lk["_id"]}, {"$set": {  # tenant-ok
        "released_at": _now(), "released_by": admin_id, "release_reason": reason[:500]}})
    try:
        await _redis().delete(_lock_key(lk["kind"], lk["uid"]))
    except Exception:  # noqa: BLE001
        pass
    await record("unlocked", kind=lk["kind"], uid=lk["uid"], tid=lk.get("tenant_id"),
                 extra={"by": admin_id, "reason": reason[:500]})
    return True


def _deny(status: int, error: str, message: str):
    from starlette.responses import JSONResponse
    return JSONResponse({"detail": {"error": error, "message": message}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


async def guard(scope) -> object | None:
    """Απόφαση για ένα αίτημα: None = πέρνα, αλλιώς Response 403. Μετρά και (Φάση 0)."""
    path = scope.get("path") or ""
    if path.startswith(EXEMPT_PREFIXES):
        return None
    from starlette.requests import Request
    req = Request(scope)
    ua = req.headers.get("user-agent") or ""
    ip = client_ip(req)
    cls = classify(ua)
    if cls == "ai":   # ΠΡΙΝ από token — fail closed, καμία εξαίρεση
        who = identify(req.headers.get("authorization"))
        await record("agent_blocked", kind=who[0] if who else None, uid=who[1] if who else None,
                     tid=who[2] if who else None, ua=ua, ip=ip, path=path,
                     throttle_key=f"{ip}:{AI_BROWSER_RE.search(ua).group(0)}")
        return _deny(403, "ai_browser_blocked", BLOCK_MSG)
    who = identify(req.headers.get("authorization"))
    if who and cls == "script":
        await record("agent_blocked", kind=who[0], uid=who[1], tid=who[2], ua=ua, ip=ip, path=path,
                     throttle_key=f"{who[0]}:{who[1]}:script")
        return _deny(403, "automation_blocked", BLOCK_MSG)
    if who and who[0] != "admin" and await locked_fast(who[0], who[1]):
        return _deny(403, "account_locked", LOCK_MSG)
    if who:
        query = (scope.get("query_string") or b"").decode("latin-1")
        n = await observe(path=path, query=query, auth=None, ua=ua, ip=ip, who=who)
        if n and not path.startswith(LIMIT_EXEMPT):
            # ΦΑΣΗ 2: όρια ρυθμού (μέτρηση/επιβολή). Fail-open: σφάλμα → κανένα 429.
            try:
                from app.services import access_limits
                claims = identify_claims(req.headers.get("authorization"))
                rule, retry = await access_limits.check(
                    _redis(), member=f"{who[0]}|{who[1]}|{who[2] or ''}", kind=who[0], tid=who[2],
                    exempt=bool(claims and claims[3].get("imp")), method=scope.get("method") or "GET",
                    path=path, query=query, minute_count=n, now=_now())
            except Exception as exc:  # noqa: BLE001
                log.debug("access limits skipped: %s", exc)
                rule, retry = None, 0
            if rule:
                if await locked_fast(who[0], who[1]):          # το strike μόλις κλείδωσε τον λογαριασμό
                    return _deny(403, "account_locked", LOCK_MSG)
                from starlette.responses import JSONResponse
                return JSONResponse({"detail": {"error": "rate_limited", "rule": rule, "retry_after": retry,
                                                "message": RATE_MSG}}, status_code=429,
                                    headers={"Retry-After": str(retry), "Cache-Control": "no-store"})
    return None


class AccessGuardMiddleware:
    """Pure ASGI (όχι BaseHTTPMiddleware): δεν αγγίζει το σώμα/streaming (SSE, ζωντανή υποστήριξη).
    Ο ΜΟΝΟΣ κλάδος που μπορεί να «σκάσει» είναι ο έλεγχος AI browser — και εκεί ΑΠΑΓΟΡΕΥΕΙ (fail closed)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            try:
                deny = await guard(scope)
            except Exception:  # noqa: BLE001
                deny = None
                try:   # fail CLOSED μόνο για AI browser (σκέτο regex — δεν μπορεί να εξαρτάται από τίποτα)
                    ua = dict(scope.get("headers") or []).get(b"user-agent", b"").decode("latin-1")
                    if classify(ua) == "ai":
                        deny = _deny(403, "ai_browser_blocked", BLOCK_MSG)
                except Exception:  # noqa: BLE001
                    pass
            if deny is not None:
                await deny(scope, receive, send)
                return
        await self.app(scope, receive, send)


# ── aggregator (beat ανά 5′) ─────────────────────────────────────────────────────────────────
async def aggregate(db, *, r=None, now: datetime | None = None) -> int:
    """Μεταφέρει στη Mongo τα λεπτά που ΕΚΛΕΙΣΑΝ (όχι το τρέχον) και δεν έχουν μεταφερθεί. Ιδεμποτεντικό:
    σημαία `acc:done:<λεπτό>` (SET NX) → ένα λεπτό δεν μετριέται ποτέ δύο φορές."""
    now = now or datetime.now(tz=timezone.utc)
    r = r or _redis()
    done = 0
    for back in range(2, 150):
        t = now - timedelta(minutes=back)
        m = _minute(t)
        if not await r.exists(f"acc:mins:{m}"):
            continue
        if not await r.set(f"acc:done:{m}", "1", nx=True, ex=_TTL):
            continue
        members = sorted(await r.smembers(f"acc:mins:{m}"))
        if not members:
            continue
        counts = await r.mget([f"acc:c:{m}:{x}" for x in members])
        bigs = await r.mget([f"acc:big:{m}:{x}" for x in members])
        day = t.strftime("%Y-%m-%d")
        for member, c, b in zip(members, counts, bigs):
            kind, uid, tid = (member.split("|") + ["", "", ""])[:3]
            n = int(c or 0)
            if n <= 0:
                continue
            await db[DAILY].update_one(  # tenant-ok: platform metrics (όλοι οι χρήστες)
                {"_id": f"{day}:{kind}"},
                {"$inc": {f"hist.{min(n, _HIST_CAP)}": 1}, "$set": {"day": day, "kind": kind}},
                upsert=True)
            await db[USERS].update_one(  # tenant-ok: platform metrics ανά χρήστη
                {"_id": f"{day}:{kind}:{uid}:{tid}"},
                {"$max": {"max_per_min": n}, "$inc": {"total": n, "minutes": 1, "big_limit": int(b or 0)},
                 "$set": {"day": day, "kind": kind, "uid": uid, "tenant_id": tid or None}},
                upsert=True)
        done += 1
    return done


def percentiles(hist: dict[str, int]) -> dict:
    """p50/p95/p99/max από ιστόγραμμα {αιτήματα/λεπτό: πλήθος λεπτών}."""
    pts = sorted((int(k), int(v)) for k, v in (hist or {}).items())
    total = sum(v for _, v in pts)
    out = {"minutes": total, "p50": 0, "p95": 0, "p99": 0, "max": pts[-1][0] if pts else 0}
    if not total:
        return out
    for q, key in ((0.50, "p50"), (0.95, "p95"), (0.99, "p99")):
        need, run = q * total, 0
        for k, v in pts:
            run += v
            if run >= need:
                out[key] = k
                break
    return out


async def report(db, *, days: int = 7) -> dict:
    """Αναφορά adminpanel: κατανομή ρυθμού ανά είδος χρήστη, κορυφαίοι χρήστες, ύποπτες συνεδρίες."""
    now = datetime.now(tz=timezone.utc)
    since = (now - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    merged: dict[str, dict[str, int]] = {}
    async for d in db[DAILY].find({"day": {"$gte": since}}):  # tenant-ok: platform metrics
        h = merged.setdefault(d["kind"], {})
        for k, v in (d.get("hist") or {}).items():
            h[k] = h.get(k, 0) + int(v)
    kinds = {k: percentiles(h) for k, h in merged.items()}

    top = await db[USERS].find({"day": {"$gte": since}}).sort(  # tenant-ok: platform metrics
        "max_per_min", -1).limit(25).to_list(25)
    names = await _names(db, top)
    top_rows = [{"day": t["day"], "kind": t["kind"], "user": names.get((t["kind"], t["uid"])) or t["uid"],
                 "tenant_id": t.get("tenant_id"), "tenant": names.get(("tenant_name", t.get("tenant_id"))),
                 "max_per_min": t.get("max_per_min", 0), "total": t.get("total", 0),
                 "minutes": t.get("minutes", 0), "big_limit": t.get("big_limit", 0)} for t in top]

    events = await db[EVENTS].find({"at": {"$gte": now - timedelta(days=30)}}).sort(  # tenant-ok
        "at", -1).limit(100).to_list(100)
    ev_names = await _names(db, events)
    ev_rows = [{"at": e["at"], "type": e["type"], "kind": e["kind"], "signature": e.get("signature"),
                "user": ev_names.get((e["kind"], e["uid"])) or e["uid"], "tenant_id": e.get("tenant_id"),
                "tenant": ev_names.get(("tenant_name", e.get("tenant_id"))), "ip": e.get("ip"),
                "ua": e.get("ua"), "path": e.get("path")} for e in events]

    sessions = []
    cutoff = now - timedelta(days=30)
    for coll, uaf, tf in (("session_log", "ua", "last_seen_at"), ("patient_sessions", "user_agent", "last_seen")):
        async for s in db[coll].find({uaf: {"$regex": AGENT_RE.pattern, "$options": "i"},  # tenant-ok
                                      "$or": [{tf: {"$gte": cutoff}}, {"created_at": {"$gte": cutoff}},
                                              {"started_at": {"$gte": cutoff}}]},
                                     {uaf: 1, tf: 1, "created_at": 1, "started_at": 1, "tenant_id": 1,
                                      "ip": 1}).limit(100):
            sessions.append({"surface": "app" if coll == "session_log" else "portal",
                             "tenant_id": s.get("tenant_id"), "ua": s.get(uaf), "ip": s.get("ip"),
                             "at": s.get(tf) or s.get("started_at") or s.get("created_at")})
    blank = await db["session_log"].count_documents({"started_at": {"$gte": cutoff},  # tenant-ok
                                                     "ua": {"$in": [None, ""]}})
    locks = await db[LOCKS].find({"$or": [{"released_at": None, "until": {"$gt": now}},  # tenant-ok
                                          {"at": {"$gte": now - timedelta(days=30)}}]}).sort(
        "at", -1).limit(100).to_list(100)
    lk_names = await _names(db, locks)
    lock_rows = [{"id": str(lk["_id"]), "kind": lk["kind"], "user": lk_names.get((lk["kind"], lk["uid"])) or lk["uid"],
                  "tenant_id": lk.get("tenant_id"), "tenant": lk_names.get(("tenant_name", lk.get("tenant_id"))),
                  "reason": lk.get("reason"), "at": lk.get("at"), "until": lk.get("until"), "ip": lk.get("ip"),
                  "ua": lk.get("ua"), "active": lk.get("released_at") is None and _aware(lk["until"]) > now,
                  "released_at": lk.get("released_at"), "release_reason": lk.get("release_reason")}
                 for lk in locks]
    from app.services import access_limits
    cfg = await access_limits.settings(db, fresh=True)
    exp = await access_limits.exports_report(db, days=days)
    exp_names = await _names(db, exp)
    exp_rows = [{"at": e["at"], "kind": e["kind"], "user": exp_names.get((e["kind"], e["uid"])) or e["uid"],
                 "tenant": exp_names.get(("tenant_name", e.get("tenant_id"))), "format": e.get("format"),
                 "screen": e.get("screen"), "rows": e.get("rows"), "rows_requested": e.get("rows_requested"),
                 "status": e.get("status"), "over_limit": e.get("over_limit"), "sha256": e.get("sha256")}
                for e in exp]
    over = await db[USERS].find({"day": {"$gte": since}, "over": {"$exists": True}}).sort(  # tenant-ok
        "day", -1).limit(100).to_list(100)
    ov_names = await _names(db, over)
    over_rows = [{"day": o["day"], "kind": o["kind"], "user": ov_names.get((o["kind"], o["uid"])) or o["uid"],
                  "tenant": ov_names.get(("tenant_name", o.get("tenant_id"))), "over": o.get("over") or {},
                  "max_per_min": o.get("max_per_min", 0)} for o in over]
    return {"days": days, "kinds": kinds, "top_users": top_rows, "events": ev_rows,
            "suspicious_sessions": sessions, "sessions_without_ua_30d": blank, "locks": lock_rows,
            "exports": exp_rows, "over_limit": over_rows, "settings": cfg, "mode": cfg["mode"]}


async def _names(db, rows: list[dict]) -> dict:
    """Ονόματα για ανθρώπινη ανάγνωση (μόνο στο adminpanel): χρήστες φαρμακείου, admins, φαρμακεία.
    Οι πελάτες πύλης ΔΕΝ ονομάζονται εδώ (υγεία/PII) — μόνο το id λογαριασμού."""
    from bson import ObjectId
    out: dict = {}
    by_kind: dict[str, set] = {}
    for r in rows:
        by_kind.setdefault(r.get("kind"), set()).add(r.get("uid"))
        if r.get("tenant_id"):
            by_kind.setdefault("tenant_name", set()).add(r["tenant_id"])

    def _oids(ids):
        return [ObjectId(i) for i in ids if i and ObjectId.is_valid(i)]
    for coll, kind in (("users", "tenant"), ("platform_admins", "admin")):
        ids = by_kind.get(kind) or set()
        if ids:
            async for u in db[coll].find({"_id": {"$in": _oids(ids)}}, {"email": 1, "full_name": 1}):  # tenant-ok
                out[(kind, str(u["_id"]))] = u.get("email") or u.get("full_name")
    tids = list(by_kind.get("tenant_name") or [])
    if tids:
        async for t in db["tenants"].find({"_id": {"$in": tids}}, {"name": 1}):  # tenant-ok
            out[("tenant_name", t["_id"])] = t.get("name")
    return out
