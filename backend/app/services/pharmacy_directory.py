"""Εύρεση φαρμακείου με ΑΦΜ + φρουρός συμμετοχής σε δίκτυο — ΕΝΑ σημείο για όλα τα κυκλώματα.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟ ΑΡΧΕΙΟ: δύο κυκλώματα προσκαλούν φαρμακεία με ΑΦΜ — η «Συνομιλία
συνεργαζόμενων φαρμακείων» (δωρεάν) και το «RxVision Connect» (πληρωμένο). Αν ο μηχανισμός
γραφόταν δύο φορές, θα απέκλιναν: ένα φαρμακείο θα βρισκόταν στο ένα κύκλωμα και «δεν θα
υπήρχε» στο άλλο, χωρίς προφανή λόγο.

ΔΕΝ ΕΙΝΑΙ ΚΑΤΑΛΟΓΟΣ ΦΑΡΜΑΚΕΙΩΝ: δεν υπάρχει αναζήτηση «δείξε μου τα φαρμακεία». Η μόνη
λειτουργία είναι «ξέρω το ΑΦΜ — υπάρχει;», που είναι ταυτοποίηση, όχι περιήγηση.
"""

from __future__ import annotations

import re
from typing import Any

from app.core.db import shared_db

# Τα πεδία όπου έχει βρεθεί ΑΦΜ στην παραγωγή. Κοιτάμε όλα: αλλιώς η πρόσκληση αποτυγχάνει
# για μισούς πελάτες χωρίς ο φαρμακοποιός να μπορεί να καταλάβει γιατί.
_AFM_FIELDS = ("company.vat", "company.afm", "billing_profile.vat", "billing_profile.afm",
               "vat", "afm")


def normalize_afm(v: Any) -> str:
    """ΑΦΜ = μόνο ψηφία. Ο φαρμακοποιός το γράφει με κενά/τελείες και δεν πρέπει να αποτύχει."""
    return re.sub(r"\D", "", str(v or ""))[:20]


async def find_tenant_by_afm(afm: str) -> str | None:
    """→ tenant_id ή None. Τα αρχικά μηδενικά αγνοούνται (`^0*<αφμ>$`)."""
    num = normalize_afm(afm)
    if not num:
        return None
    db = shared_db()
    for f in _AFM_FIELDS:
        t = await db["tenants"].find_one({f: {"$regex": f"^0*{num}$"}}, {"_id": 1})
        if t:
            return t["_id"]
    return None


async def tenant_name(tenant_id: str) -> str:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"name": 1}) or {}
    return t.get("name") or tenant_id


async def names_of(tenant_ids: list[str]) -> dict[str, str]:
    return {t["_id"]: t.get("name") or t["_id"] async for t in
            shared_db()["tenants"].find({"_id": {"$in": list(tenant_ids)}}, {"name": 1})}


async def join_block(target: str, *, module: str, require_module: bool) -> dict | None:
    """Μπορεί αυτό το φαρμακείο να μπει στο δίκτυο; None = ναι, αλλιώς το μήνυμα άρνησης.

    ΔΥΟ ΑΥΣΤΗΡΟΤΗΤΕΣ, μία συνάρτηση:

    · `require_module=False` (συνομιλία, δωρεάν): αρκεί **ενεργή συνδρομή**. Η δοκιμαστική ΔΕΝ
      αρκεί — αλλιώς μπαίνει στο δίκτυο κάποιος που σε δεκαπέντε μέρες φεύγει, και τα μηνύματά
      του μένουν σε ομάδες πληρωμένων πελατών. Ρητή παραχώρηση του module τον περνά.

    · `require_module=True` (Connect, πληρωμένο): πρέπει να έχει **το ίδιο το module ενεργό**.
      Απόφαση ιδιοκτήτη 24/09/2026: «όλοι πληρώνουν Connect· αν δεν έχεις το Connect δεν
      μπορείς να δεχτείς κλήση». Έτσι δεν υπάρχει ποτέ μέλος που βλέπει μισό κύκλωμα.
    """
    from app.services.auth_service import resolve_tenant_modules, tenant_has
    from app.services.billing_service import effective_status

    db = shared_db()
    name = await tenant_name(target)
    mods = await resolve_tenant_modules(target)

    if require_module:
        if tenant_has(mods, module):
            return None
        return {"ok": False, "error": "no_module",
                "message": f"Το «{name}» δεν έχει ενεργό το RxVision Connect. Μπορεί να το "
                           "ενεργοποιήσει από τα Πρόσθετα και μετά να ξαναστείλεις πρόσκληση."}

    if tenant_has(mods, module):
        return None
    sub = await db["subscriptions"].find_one({"tenant_id": target})
    st = effective_status(sub)
    if st == "active":
        return None
    if st == "trial":
        return {"ok": False, "error": "trial_only",
                "message": f"Το «{name}» είναι σε δοκιμαστική περίοδο. Επικοινώνησε μαζί μας "
                           "για να ενεργοποιηθεί η συμμετοχή του σε ομάδες."}
    return {"ok": False, "error": "no_subscription",
            "message": f"Το «{name}» δεν έχει ενεργή συνδρομή RxVision."}
