"""«Τι νέο υπάρχει» — ενημέρωση πελατών ανά έκδοση.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΑ ΑΠΟ ΤΙΣ ΑΝΑΚΟΙΝΩΣΕΙΣ: οι ανακοινώσεις είναι ΣΤΟΧΕΥΜΕΝΗ πρόσκληση («δοκίμασε
αυτό το πρόσθετο»), με κοινό, συχνότητα και CTA. Αυτό εδώ είναι ΙΣΤΟΡΙΚΟ — τι άλλαξε, πότε, για
όλους. Ίδιο εργαλείο για τα δύο θα κατέληγε είτε σε σπαμ είτε σε ιστορικό που κανείς δεν βλέπει.

ΔΗΜΟΣΙΕΥΣΗ ΜΕ ΤΟ ΧΕΡΙ: οι σημειώσεις γράφονται/παράγονται ως `published=False` και τις εγκρίνει
άνθρωπος. Ένα changelog που βγαίνει αυτόματα από commits λέει στον πελάτη και τι ΧΑΛΑΣΕ («τώρα
διορθώθηκε το Χ»), που είναι η πιο γρήγορη διαδρομή για να χάσεις την εμπιστοσύνη του.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

COLL = "release_notes"
SEEN = "release_notes_seen"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _vkey(v: str) -> tuple:
    """Ταξινόμηση έκδοσης ως ΑΡΙΘΜΩΝ: αλφαβητικά, η 1.9.0 έβγαινε μετά την 1.10.0."""
    parts = []
    for p in str(v or "").split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    return tuple(parts + [0, 0, 0])[:3]


async def upsert(version: str, *, date: datetime | None = None, title: str = "",
                 items: list[dict] | None = None, published: bool = False) -> dict:
    """Δημιουργία/ενημέρωση σημείωσης έκδοσης. `items`: [{title, body, icon?}]."""
    v = str(version or "").strip()
    if not v:
        return {"ok": False, "error": "no_version"}
    clean = []
    for it in (items or []):
        t = str((it or {}).get("title") or "").strip()[:160]
        if not t:
            continue
        clean.append({"title": t, "body": str((it or {}).get("body") or "").strip()[:600],
                      "icon": str((it or {}).get("icon") or "")[:8] or None})
    await shared_db()[COLL].update_one({"_id": v}, {"$set": {
        "date": date or _now(), "title": str(title or "").strip()[:160],
        "items": clean, "published": bool(published), "updated_at": _now(),
        "vkey": list(_vkey(v))}}, upsert=True)
    return {"ok": True, "version": v, "items": len(clean)}


async def admin_list(limit: int = 300) -> list[dict]:
    rows = [r async for r in shared_db()[COLL].find({}).sort("vkey", -1).limit(limit)]
    for r in rows:
        r["version"] = r.pop("_id")
        r.pop("vkey", None)
    return rows


async def set_published(version: str, published: bool) -> dict:
    r = await shared_db()[COLL].update_one({"_id": version},
                                           {"$set": {"published": bool(published)}})
    return {"ok": bool(r.matched_count), "version": version, "published": published}


async def delete(version: str) -> dict:
    r = await shared_db()[COLL].delete_one({"_id": version})
    return {"ok": bool(r.deleted_count)}


# ── πλευρά πελάτη ────────────────────────────────────────────────────────────────────────────
async def for_tenant(tenant_id: str, limit: int = 40) -> dict:
    """Δημοσιευμένες σημειώσεις + πόσες δεν έχει δει ακόμη αυτό το φαρμακείο."""
    db = shared_db()
    rows = [r async for r in db[COLL].find({"published": True}).sort("vkey", -1).limit(limit)]
    seen = await db[SEEN].find_one({"_id": tenant_id}) or {}
    last = seen.get("last_version")
    lastk = _vkey(last) if last else (0, 0, 0)
    out, unseen = [], 0
    for r in rows:
        v = r["_id"]
        is_new = _vkey(v) > lastk
        unseen += 1 if is_new else 0
        out.append({"version": v, "date": r.get("date"), "title": r.get("title"),
                    "items": r.get("items") or [], "is_new": is_new})
    return {"items": out, "unseen": unseen,
            "latest": out[0]["version"] if out else None}


async def mark_seen(tenant_id: str) -> dict:
    """Ο πελάτης είδε τη λίστα → όλα μέχρι την τελευταία δημοσιευμένη παύουν να είναι «νέα»."""
    db = shared_db()
    top = await db[COLL].find({"published": True}).sort("vkey", -1).limit(1).to_list(length=1)
    if not top:
        return {"ok": True, "last_version": None}
    v = top[0]["_id"]
    await db[SEEN].update_one({"_id": tenant_id},
                              {"$set": {"last_version": v, "at": _now()}}, upsert=True)
    return {"ok": True, "last_version": v}
