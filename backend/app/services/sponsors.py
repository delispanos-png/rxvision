"""Χορηγοί ειδικών προσφορών (Φάση 3, 20/11/2026 — docs/special-offers-spec.md §9).

Χορηγός = τρίτος (π.χ. φαρμακαποθήκη) που πληρώνει όλη ή μέρος της συνδρομής για τα μέλη του. ΔΕΝ
είναι φαρμακείο ούτε έχει σύνδεση στην εφαρμογή: είναι μόνο στοιχεία τιμολόγησης.

ΧΡΕΩΣΗ (απόφαση ιδιοκτήτη: ανά ενεργοποίηση): όταν ένα ΑΦΜ της λίστας επιβεβαιωθεί από την ΗΔΥΚΑ,
γράφεται ΜΙΑ χρέωση (`sponsor_charges`, `_id` = <προσφορά>:<ΑΦΜ>:<φαρμακείο> → ποτέ διπλή) και ΕΝΑ
παραστατικό στο ΑΦΜ του χορηγού, επί πιστώσει (τραπεζική μεταφορά). Η εξόφληση σημειώνεται στο
παραστατικό (`settled`), ίδια διαδρομή με κάθε κατάθεση.

ΤΙ ΒΛΕΠΕΙ Ο ΧΟΡΗΓΟΣ (αναφορά): ΜΟΝΟ ΑΦΜ/επωνυμία/ημερομηνία/ποσό για τα ΑΦΜ της δικής του λίστας.
ΠΟΤΕ συνταγές, χρήση, όγκους — GDPR και εμπορικό απόρρητο του φαρμακείου.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.core.db import shared_db
from app.utils.afm import is_valid, normalize

SPONSOR_ITEM_KEY = "sponsor"          # είδος SoftOne «Χορηγία συνδρομής» (κανόνας MTRL)


class SponsorError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def validate(doc: dict) -> dict:
    name = (doc.get("name") or "").strip()
    if not name:
        raise SponsorError("name_required")
    afm = normalize(doc.get("afm"))
    if not is_valid(afm):
        raise SponsorError("afm_invalid")
    email = (doc.get("email") or "").strip()
    if email and "@" not in email:
        raise SponsorError("email_invalid")
    return {"name": name[:160], "afm": afm, "doy": (doc.get("doy") or "").strip()[:80],
            "address": (doc.get("address") or "").strip()[:160], "city": (doc.get("city") or "").strip()[:80],
            "postal_code": (doc.get("postal_code") or "").strip()[:10], "email": email[:160],
            "phone": (doc.get("phone") or "").strip()[:40], "contact": (doc.get("contact") or "").strip()[:120],
            "country": (doc.get("country") or "GR").upper()[:2], "active": bool(doc.get("active", True)),
            "notes": (doc.get("notes") or "").strip()[:1000]}


async def save(doc: dict, *, by: str, sid: str | None = None) -> dict:
    db = shared_db()
    clean = validate(doc)
    clash = await db["sponsors"].find_one({"afm": clean["afm"], "_id": {"$ne": sid}}, {"_id": 1})
    if clash:
        raise SponsorError("afm_taken")
    clean.update({"updated_at": _now(), "updated_by": by})
    if sid:
        res = await db["sponsors"].update_one({"_id": sid}, {"$set": clean})
        if not res.matched_count:
            raise SponsorError("not_found")
    else:
        sid = uuid.uuid4().hex[:12]
        await db["sponsors"].insert_one({"_id": sid, **clean, "created_at": _now(), "created_by": by})
    return {"_id": sid, **clean}


async def delete(sid: str) -> dict:
    """Χορηγός με προσφορές ή χρεώσεις δεν σβήνεται (ιστορικό τιμολόγησης): απενεργοποιείται."""
    db = shared_db()
    used = (await db["promotions"].find_one({"sponsor_id": sid}, {"_id": 1})
            or await db["sponsor_charges"].find_one({"sponsor_id": sid}, {"_id": 1}))
    if used:
        await db["sponsors"].update_one({"_id": sid}, {"$set": {"active": False, "updated_at": _now()}})
        return {"ok": True, "deactivated": True}
    await db["sponsors"].delete_one({"_id": sid})
    return {"ok": True, "deleted": True}


async def ids() -> set[str]:
    return {s["_id"] async for s in shared_db()["sponsors"].find({"active": {"$ne": False}}, {"_id": 1})}


async def get(sid: str | None) -> dict | None:
    return await shared_db()["sponsors"].find_one({"_id": sid}) if sid else None


async def list_all() -> list[dict]:
    """Χορηγοί + σύνοψη: ενεργοποιήσεις, χρεωμένο, ανοιχτό υπόλοιπο."""
    db = shared_db()
    rows = [s async for s in db["sponsors"].find({}).sort("name", 1)]
    stats: dict[str, dict] = {}
    async for c in db["sponsor_charges"].find({}, {"sponsor_id": 1, "gross": 1, "invoice_id": 1}):
        st = stats.setdefault(c["sponsor_id"], {"activations": 0, "billed": 0, "invoice_ids": []})
        st["activations"] += 1
        st["billed"] += int(c.get("gross") or 0)
        if c.get("invoice_id"):
            st["invoice_ids"].append(c["invoice_id"])
    for s in rows:
        st = stats.get(s["_id"], {"activations": 0, "billed": 0, "invoice_ids": []})
        settled = 0
        if st["invoice_ids"]:
            async for inv in db["invoices"].find({"_id": {"$in": st["invoice_ids"]}, "settled": True}, {"total": 1}):
                settled += int(inv.get("total") or 0)
        s["activations"], s["billed"], s["open"] = st["activations"], st["billed"], st["billed"] - settled
        s["offers"] = await db["promotions"].count_documents({"sponsor_id": s["_id"]})
    return rows


async def charges(sid: str) -> list[dict]:
    db = shared_db()
    rows = [c async for c in db["sponsor_charges"].find({"sponsor_id": sid}).sort("at", -1)]
    inv_ids = [c["invoice_id"] for c in rows if c.get("invoice_id")]
    invs = {i["_id"]: i async for i in db["invoices"].find(
        {"_id": {"$in": inv_ids}}, {"settled": 1, "status": 1, "aade_mark": 1, "number": 1, "series": 1})}
    for c in rows:
        inv = invs.get(c.get("invoice_id")) or {}
        c["invoice"] = {"id": str(inv["_id"]), "settled": bool(inv.get("settled")), "status": inv.get("status"),
                        "issued": bool(inv.get("aade_mark")),
                        "number": f"{inv.get('series') or ''}-{inv.get('number') or ''}"} if inv else None
    return rows


def report_csv(rows: list[dict], sponsor: dict) -> str:
    """Αναφορά προς τον χορηγό: ΜΟΝΟ ό,τι αφορά τη δική του λίστα (βλ. docstring)."""
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Χορηγός", sponsor.get("name"), "ΑΦΜ", sponsor.get("afm")])
    w.writerow([])
    w.writerow(["Προσφορά", "ΑΦΜ φαρμακείου", "Φαρμακείο", "Ενεργοποίηση", "Περίοδος έως",
                "Καθαρό €", "ΦΠΑ €", "Σύνολο €", "Εξοφλήθηκε"])
    for c in rows:
        inv = c.get("invoice") or {}
        w.writerow([c.get("promotion_name") or "", c.get("afm") or "", c.get("pharmacy_name") or "",
                    _d(c.get("at")), _d(c.get("period_until")),
                    _e(c.get("net")), _e(c.get("vat")), _e(c.get("gross")), "ναι" if inv.get("settled") else "όχι"])
    return "﻿" + buf.getvalue()             # BOM: το Excel διαβάζει σωστά τα ελληνικά


def _d(v) -> str:
    return v.strftime("%d/%m/%Y") if hasattr(v, "strftime") else ""


def _e(cents) -> str:
    return f"{int(cents or 0) / 100:.2f}".replace(".", ",")


async def bill_activation(row: dict) -> dict | None:
    """Μία επιβεβαιωμένη ενεργοποίηση → μία χρέωση + ένα παραστατικό στον χορηγό. Idempotent.
    `row` = η γραμμή `special_offer_afms` (μετά την επιβεβαίωση), με `sponsor` από την εξαργύρωση."""
    sp = row.get("sponsor") or {}
    net = int(sp.get("net") or 0)
    tid = row.get("tenant_id")
    if not sp.get("sponsor_id") or net <= 0 or not tid:
        return None
    from pymongo.errors import DuplicateKeyError

    from app.services import invoice_service
    db = shared_db()
    sponsor = await get(sp["sponsor_id"])
    if not sponsor:
        return None
    rate = invoice_service.VAT_BY_COUNTRY.get(sponsor.get("country") or "GR", invoice_service.DEFAULT_VAT)
    vat = round(net * rate / 100)
    tenant = await db["tenants"].find_one({"_id": tid}, {"name": 1}) or {}
    promo = await db["promotions"].find_one({"_id": row["promotion_id"]}, {"name": 1}) or {}
    sub = await db["subscriptions"].find_one({"tenant_id": tid}, {"current_period_end": 1, "started_at": 1}) or {}
    cid = f"{row['_id']}:{tid}"
    doc = {"_id": cid, "sponsor_id": sp["sponsor_id"], "promotion_id": row["promotion_id"],
           "promotion_name": promo.get("name"), "afm": row["afm"], "tenant_id": tid,
           "pharmacy_name": tenant.get("name"), "package": sp.get("package"), "cycle": sp.get("cycle"),
           "pct": sp.get("pct"), "net": net, "vat": vat, "gross": net + vat,
           "period_from": sub.get("started_at"), "period_until": sub.get("current_period_end"),
           "at": _now(), "invoice_id": None}
    try:
        await db["sponsor_charges"].insert_one(doc)
    except DuplicateKeyError:
        return await db["sponsor_charges"].find_one({"_id": cid})
    pkg = await db["packages"].find_one({"_id": sp.get("package")}, {"name": 1}) or {}
    inv = await invoice_service.create_for_sponsor(
        sponsor=sponsor, gross_cents=net + vat, source_ref=f"sponsor:{cid}",
        description=(f"Χορηγία συνδρομής RxVision «{pkg.get('name') or sp.get('package') or ''}» για το "
                     f"φαρμακείο {tenant.get('name') or ''} (ΑΦΜ {row['afm']})"
                     + (f" — {sp.get('pct')}% της συνδρομής" if int(sp.get("pct") or 100) < 100 else "")),
        comments=(f"Προσφορά «{promo.get('name') or ''}» · Περίοδος: {_d(sub.get('started_at'))} έως "
                  f"{_d(sub.get('current_period_end'))}"),
        package=sp.get("package"), cycle=sp.get("cycle"))
    if inv:
        await db["sponsor_charges"].update_one({"_id": cid}, {"$set": {"invoice_id": inv["_id"]}})
        doc["invoice_id"] = inv["_id"]
    return doc
