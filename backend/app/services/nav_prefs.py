"""Προσωπικό μενού & μενού ανά ρόλο.

ΤΟ ΠΡΟΒΛΗΜΑ: το μενού έχει 10 ομάδες και πάνω από 40 επιλογές. Ένας υπάλληλος ταμείου
χρησιμοποιεί τρεις από αυτές — και τις ψάχνει κάθε φορά.

ΔΥΟ ΣΤΡΩΣΕΙΣ, ΔΙΑΦΟΡΕΤΙΚΟΣ ΙΔΙΟΚΤΗΤΗΣ Η ΚΑΘΕΜΙΑ:
  1. **Ανά ρόλο** — το αποφασίζει ο ιδιοκτήτης του φαρμακείου: τι βλέπει ο «Φαρμακοποιός»,
     τι το «Προσωπικό». Μειώνει τον θόρυβο για όλους μαζί.
  2. **Προσωπικό** — το αποφασίζει ο ίδιος ο χειριστής: καρφιτσώνει τις 5-6 δουλειές που
     κάνει κάθε μέρα και τις έχει πρώτες. Κανείς δεν του το επιβάλλει.

⚠️ ΚΡΙΣΙΜΟ: αυτό είναι ΕΜΦΑΝΙΣΗ, ΟΧΙ ΑΣΦΑΛΕΙΑ. Το να κρύψεις μια επιλογή από το μενού δεν
εμποδίζει κανέναν να ανοίξει τη διεύθυνση. Τα δικαιώματα επιβάλλονται στον server
(`require(...)`) και δεν αλλάζουν από εδώ. Αν κάτι πρέπει να ΑΠΑΓΟΡΕΥΕΤΑΙ, αφαιρείται
δικαίωμα — δεν κρύβεται μενού.

Ο κατάλογος των επιλογών ζει στο frontend (`Sidebar.tsx`). Εδώ αποθηκεύονται μόνο **κλειδιά**
— έτσι δεν υπάρχουν δύο λίστες μενού που αποκλίνουν με τον καιρό.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

COLL = "nav_prefs"
MAX_PINNED = 8            # πάνω από αυτό παύει να είναι «τα δικά μου» και ξαναγίνεται μενού


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _user_key(user_id: str) -> str:
    return f"u|{user_id}"


def _role_key(tenant_id: str, role: str) -> str:
    return f"r|{tenant_id}|{role}"


async def get_for(tenant_id: str, user_id: str, roles: list[str]) -> dict:
    """Ό,τι χρειάζεται το μενού για να ζωγραφιστεί: καρφιτσωμένα + κρυμμένες ομάδες."""
    db = shared_db()
    doc = await db[COLL].find_one({"_id": _user_key(user_id)}) or {}
    hidden: set[str] = set()
    # Αν ο χρήστης έχει ΠΟΛΛΟΥΣ ρόλους, βλέπει την ΕΝΩΣΗ. Κρύβουμε μόνο ό,τι κρύβουν ΟΛΟΙ οι
    # ρόλοι του — αλλιώς ένας περιοριστικός ρόλος θα έκοβε πρόσβαση που δίνει ο άλλος.
    per_role: list[set[str]] = []
    for r in roles or []:
        rd = await db[COLL].find_one({"_id": _role_key(tenant_id, r)})
        per_role.append(set((rd or {}).get("hidden_groups") or []))
    if per_role:
        hidden = set.intersection(*per_role) if len(per_role) > 1 else per_role[0]
    pinned = list(doc.get("pinned") or [])[:MAX_PINNED]
    mode = doc.get("mode") if doc.get("mode") in ("central", "personal") else "central"
    # ΑΣΦΑΛΙΣΤΙΚΟ: «μόνο τα δικά μου» χωρίς καρφιτσωμένα = άδειο μενού και ο χειριστής
    # κολλάει χωρίς τρόπο να πάει πουθενά. Πέφτουμε πίσω στο κεντρικό.
    if mode == "personal" and not pinned:
        mode = "central"
    return {
        "pinned": pinned,
        "mode": mode,
        "hidden_groups": sorted(hidden),
        "max_pinned": MAX_PINNED,
    }


async def set_mode(user_id: str, mode: str) -> dict:
    """Τι βλέπει ο χειριστής: το κεντρικό μενού ή μόνο τα δικά του."""
    if mode not in ("central", "personal"):
        return {"ok": False, "error": "bad_mode"}
    await shared_db()[COLL].update_one(
        {"_id": _user_key(user_id)},
        {"$set": {"mode": mode, "updated_at": _now(), "kind": "user"}}, upsert=True)
    return {"ok": True, "mode": mode}


async def set_pinned(user_id: str, items: list[dict]) -> dict:
    """Τα καρφιτσωμένα του χειριστή. Κρατάμε href + ετικέτα ώστε το μενού να τα δείχνει
    χωρίς να ψάχνει τον κατάλογο — και να μη σπάει αν μια επιλογή μετονομαστεί."""
    clean: list[dict] = []
    seen: set[str] = set()
    for it in (items or [])[: MAX_PINNED * 2]:
        href = str((it or {}).get("href") or "").strip()
        if not href.startswith("/") or href in seen:
            continue
        seen.add(href)
        clean.append({"href": href,
                      "label": str(it.get("label") or "")[:60],
                      "en": str(it.get("en") or "")[:60]})
        if len(clean) >= MAX_PINNED:
            break
    await shared_db()[COLL].update_one(
        {"_id": _user_key(user_id)},
        {"$set": {"pinned": clean, "updated_at": _now(), "kind": "user"}}, upsert=True)
    return {"ok": True, "pinned": clean}


async def role_menus(tenant_id: str, roles: list[str]) -> dict:
    """Τι κρύβει κάθε ρόλος — για την οθόνη ρυθμίσεων του ιδιοκτήτη."""
    db = shared_db()
    out: dict = {}
    for r in roles:
        rd = await db[COLL].find_one({"_id": _role_key(tenant_id, r)}) or {}
        out[r] = sorted(rd.get("hidden_groups") or [])
    return out


async def set_role_menu(tenant_id: str, role: str, hidden_groups: list[str], *,
                        by: str | None = None) -> dict:
    hidden = sorted({str(g).strip() for g in (hidden_groups or []) if str(g).strip()})[:40]
    await shared_db()[COLL].update_one(
        {"_id": _role_key(tenant_id, role)},
        {"$set": {"hidden_groups": hidden, "tenant_id": tenant_id, "role": role,
                  "kind": "role", "updated_at": _now(), "updated_by": by}}, upsert=True)
    return {"ok": True, "role": role, "hidden_groups": hidden}
