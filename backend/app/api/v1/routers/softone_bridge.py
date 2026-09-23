"""Γέφυρα SoftOne — ΑΝΤΕΣΤΡΑΜΜΕΝΗ ροή: η SoftOne μάς καλεί, όχι εμείς αυτήν.

ΓΙΑΤΙ: το domain `*.oncloud.gr` της εγκατάστασης είναι κοινό μεταξύ live και R&D και δείχνει στην
R&D — οπότε **καμία εισερχόμενη κλήση δεν φτάνει στη live** (404 σε κάθε web service). Αντί να
χτυπάμε εμείς, μια προγραμματισμένη εργασία ΜΕΣΑ στη live SoftOne:

  1. καλεί `GET /softone/pull`  → παίρνει τα εκκρεμή παραστατικά
  2. τα εκδίδει ΕΣΩΤΕΡΙΚΑ με `X.WEBREQUEST({SERVICE:"setData", OBJECT:"SALDOC"})`
     → πλήρης φορολογική διαδικασία → ΠΡΑΓΜΑΤΙΚΟ ΜΑΡΚ
  3. καλεί `POST /softone/ack`  → μας γράφει πίσω findoc/MARK ή το σφάλμα

Έτσι δεν χρειάζεται ΚΑΜΙΑ εισερχόμενη πρόσβαση στη live, ούτε αλλαγή DNS, ούτε άνοιγμα βάσης.
Το script της πλευράς SoftOne: `docs/softone-pull-bridge.js`.

ΑΣΦΑΛΕΙΑ: κοινό μυστικό (`platform_settings.softone.pull_token`) σε header `X-S1-Token`, σύγκριση
σταθερού χρόνου. Η SoftOne δεν μπορεί να κάνει JWT, οπότε αυτό είναι το διαπιστευτήριο — γι' αυτό
είναι ΜΟΝΟ για αυτά τα δύο endpoints και δεν δίνει καμία άλλη πρόσβαση.
"""

from __future__ import annotations

import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.repositories.base import jsonsafe

router = APIRouter()
log = logging.getLogger(__name__)

# Πόση ώρα «κρατιέται» ένα παραστατικό αφού δοθεί, πριν ξαναδοθεί (αν η SoftOne δεν απαντήσει).
_CLAIM_MINUTES = 15


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _config() -> dict:
    from app.services.platform_secrets import decrypt_doc
    return decrypt_doc("softone", await shared_db()["platform_settings"].find_one({"_id": "softone"})) or {}


async def ensure_pull_token() -> str:
    """Το κοινό μυστικό της γέφυρας. Δημιουργείται μία φορά· φαίνεται στο adminpanel για να το
    δώσει ο διαχειριστής στη CloudOn."""
    cfg = await _config()
    tok = (cfg.get("pull_token") or "").strip()
    if not tok:
        tok = secrets.token_urlsafe(32)
        from app.services.platform_secrets import encrypt_fields
        await shared_db()["platform_settings"].update_one(
            {"_id": "softone"},
            {"$set": encrypt_fields("softone", {"pull_token": tok})}, upsert=True)
    return tok


async def _auth(x_s1_token: str | None = Header(None, alias="X-S1-Token")) -> None:
    expected = await ensure_pull_token()
    if not x_s1_token or not hmac.compare_digest(str(x_s1_token), expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_token")


@router.get("/ping", dependencies=[Depends(_auth)])
async def ping():
    """Έλεγχος σύνδεσης & token. ΔΕΝ δεσμεύει και ΔΕΝ αλλάζει τίποτε — ασφαλές να καλείται όσο θες.

    ΓΙΑΤΙ ΧΩΡΙΣΤΟ: δοκιμή με `/pull` θα «κρατούσε» ένα πραγματικό παραστατικό για 15′ χωρίς να το
    εκδώσει — δηλαδή ο έλεγχος θα καθυστερούσε την έκδοση.
    """
    db = shared_db()
    pending = await db["invoices"].count_documents(
        {"status": {"$in": ["pending", "sending", "error"]}, "aade_mark": {"$in": [None, ""]}})
    return {"ok": True, "pending": pending, "server_time": _now().isoformat()}


@router.get("/pull", dependencies=[Depends(_auth)])
async def pull(limit: int = Query(10, ge=1, le=50)):
    """Τα εκκρεμή παραστατικά προς έκδοση, στη μορφή που περιμένει το script της SoftOne.

    «Κρατά» ό,τι δίνει (status=sending + sending_at) ώστε δύο διαδοχικές εκτελέσεις να μην
    στείλουν το ίδιο δύο φορές. Αν η SoftOne δεν απαντήσει σε `_CLAIM_MINUTES`, ξαναδίδεται.
    """
    from app.services.invoice_service import _build_payload
    db = shared_db()
    stale = _now() - timedelta(minutes=_CLAIM_MINUTES)
    q = {"status": {"$in": ["pending", "sending", "error"]},
         "aade_mark": {"$in": [None, ""]},
         "$or": [{"sending_at": None}, {"sending_at": {"$lt": stale}},
                 {"sending_at": {"$exists": False}}]}
    out = []
    async for inv in db["invoices"].find(q).sort("created_at", 1).limit(limit):
        await db["invoices"].update_one({"_id": inv["_id"]}, {"$set": {
            "status": "sending", "sending_at": _now(), "updated_at": _now()}})
        out.append(_build_payload(inv))
    if out:
        log.info("softone bridge: δόθηκαν %d παραστατικά", len(out))
    return {"items": jsonsafe(out), "count": len(out)}


class AckIn(BaseModel):
    ref: str                       # το _id του παραστατικού μας (POSGUID στη SoftOne)
    ok: bool = False
    findoc: str | None = None      # εσωτερικό id παραστατικού SoftOne
    mark: str | None = None        # ΑΑΔΕ MARK — ΜΟΝΟ αυτό κλειδώνει το παραστατικό
    uid: str | None = None
    aa: str | None = None
    series: str | None = None
    number: str | None = None
    error: str | None = None


@router.post("/ack", dependencies=[Depends(_auth)])
async def ack(body: AckIn):
    """Αποτέλεσμα έκδοσης από τη SoftOne. Idempotent: δεύτερη κλήση για το ίδιο ref δεν χαλάει τίποτε."""
    db = shared_db()
    try:
        oid = ObjectId(body.ref)
    except (InvalidId, TypeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_ref")
    inv = await db["invoices"].find_one({"_id": oid})
    if not inv:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown_ref")
    now = _now()
    if not body.ok:
        await db["invoices"].update_one({"_id": oid}, {"$set": {
            "status": "error", "last_error": (body.error or "άγνωστο σφάλμα")[:300],
            "sending_at": None, "updated_at": now},
            "$inc": {"attempts": 1}})
        log.warning("softone bridge: αποτυχία έκδοσης %s — %s", body.ref, body.error)
        return {"ok": True, "recorded": "error"}
    upd = {"status": "issued", "issued_at": inv.get("issued_at") or now,
           "sending_at": None, "last_error": None, "updated_at": now}
    for k, v in (("softone_findoc", body.findoc), ("aade_mark", body.mark),
                 ("mydata_uid", body.uid), ("mydata_aa", body.aa)):
        if v:
            upd[k] = v
    if body.series:
        upd["series"] = body.series
    if body.number:
        upd["number"] = body.number
    # ΑΑΔΕ: «transmitted» ΜΟΝΟ με πραγματικό MARK — αλλιώς το παραστατικό δεν έχει διαβιβαστεί
    # (π.χ. προτιμολόγιο). Ίδιος κανόνας με το invoice-lock: κλειδώνει μόνο το MARK.
    upd["aade_status"] = "transmitted" if body.mark else (inv.get("aade_status") or "not_transmitted")
    if body.mark:
        upd["aade_transmitted_at"] = now
    await db["invoices"].update_one({"_id": oid}, {"$set": upd})
    log.info("softone bridge: εκδόθηκε %s findoc=%s mark=%s", body.ref, body.findoc, body.mark)
    return {"ok": True, "recorded": "issued", "mark": bool(body.mark)}
