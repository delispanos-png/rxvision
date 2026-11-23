"""Η ΜΙΑ πύλη του κυπριακού κομματιού.

Ένα κυπριακό endpoint απαντά ΜΟΝΟ όταν ισχύουν ΚΑΙ τα δύο:
1. ο διακόπτης `platform_settings/cy.enabled` είναι ανοιχτός (κλείνει με ένα κλικ, χωρίς deploy)·
2. το φαρμακείο του χρήστη έχει `country == "CY"`.

Σε κάθε άλλη περίπτωση: 404 — ένα ελληνικό φαρμακείο δεν μαθαίνει καν ότι υπάρχει.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from app.core.db import shared_db
from app.core.deps import TenantContext, get_current_context

SETTINGS_ID = "cy"


async def cy_enabled() -> bool:
    doc = await shared_db()["platform_settings"].find_one({"_id": SETTINGS_ID}, {"enabled": 1})
    return bool((doc or {}).get("enabled"))


#: Οι κανόνες των αλυσίδων ΓεΣΥ. ΥΠΟΘΕΣΕΙΣ μέχρι τον πιλότο → αλλάζουν από το adminpanel χωρίς
#: νέα έκδοση. Όρια: ό,τι έξω από αυτά είναι σχεδόν σίγουρα λάθος πληκτρολόγησης.
RULE_DEFAULTS = {"drug_interval_days": 28, "consumable_interval_days": 30, "lost_after_days": 14, "soon_days": 7}
RULE_BOUNDS = {"drug_interval_days": (7, 120), "consumable_interval_days": (7, 120),
               "lost_after_days": (1, 90), "soon_days": (1, 30)}


async def cy_rules() -> dict[str, int]:
    doc = await shared_db()["platform_settings"].find_one({"_id": SETTINGS_ID}, {"rules": 1})
    saved = (doc or {}).get("rules") or {}
    return {k: int(saved.get(k, v)) for k, v in RULE_DEFAULTS.items()}


async def set_cy_rules(patch: dict) -> dict[str, int]:
    """Αλλαγή κανόνων. Άγνωστο κλειδί ή τιμή εκτός ορίων → ValueError (καμία μερική αποθήκευση)."""
    from datetime import datetime, timezone
    cur = await cy_rules()
    for k, v in (patch or {}).items():
        if k not in RULE_DEFAULTS:
            raise ValueError(f"unknown_rule:{k}")
        lo, hi = RULE_BOUNDS[k]
        if not isinstance(v, int) or not lo <= v <= hi:
            raise ValueError(f"out_of_range:{k}:{lo}-{hi}")
        cur[k] = v
    await shared_db()["platform_settings"].update_one(
        {"_id": SETTINGS_ID}, {"$set": {"rules": cur, "rules_updated_at": datetime.now(tz=timezone.utc)}},
        upsert=True)
    return cur


async def set_cy_enabled(enabled: bool) -> bool:
    from datetime import datetime, timezone
    await shared_db()["platform_settings"].update_one(
        {"_id": SETTINGS_ID},
        {"$set": {"enabled": bool(enabled), "updated_at": datetime.now(tz=timezone.utc)}},
        upsert=True)
    return bool(enabled)


async def tenant_country(tenant_id: str) -> str:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"country": 1})
    return ((t or {}).get("country") or "GR").upper()


async def cy_tenant_ids() -> list[str]:
    """ΤΑ κυπριακά φαρμακεία — ο ΕΝΑΣ ορισμός για κάθε κύκλωμα που αγγίζει ΠΟΛΛΑ φαρμακεία μαζί
    (κεντρικός κατάλογος, κρατικές τιμές ΗΔΥΚΑ, AI κατηγοριοποίηση, δίκτυα). Η Ελλάδα και η Κύπρος
    δεν ανταλλάσσουν ΤΙΠΟΤΑ: ούτε είδη, ούτε τιμές, ούτε μέλη δικτύου (ρητή οδηγία 18/11/2026)."""
    return [t["_id"] async for t in shared_db()["tenants"].find({"country": "CY"}, {"_id": 1})]


async def same_country(a: str, b: str) -> bool:
    return await tenant_country(a) == await tenant_country(b)


# ── ΠΡΟΣΘΕΤΑ: ίδια συμπεριφορά με την Ελλάδα (23/11/2026) ────────────────────────────────────
# Κάθε κυπριακή οθόνη ελέγχεται από το ΙΔΙΟ πρόσθετο με την αντίστοιχη ελληνική (ό,τι κλείνει ο admin
# στο adminpanel κλείνει ΚΑΙ στην Κύπρο). Κλειδί = 1ο τμήμα της διαδρομής μετά το /cy. Λίστα = αρκεί ΕΝΑ
# ενεργό (όπως οι «Ασφαλισμένοι» της Ελλάδας). Νέο endpoint ΧΩΡΙΣ γραμμή εδώ → αποτυγχάνει τεστ.
_PATIENTS = ("patient_analytics", "advance_dispensing", "family_groups", "patient_portal")
CY_ROUTE_MODULES: dict[str, tuple[str, ...]] = {
    "overview": ("dashboard",), "dashboard": ("dashboard",), "staff": ("dashboard",),
    "dispensings": ("prescription_analytics",), "not-dispensed": ("prescription_analytics",),
    "recall": ("prescription_analytics",),
    "claim": ("monthly_closing",), "settlement": ("monthly_closing",), "pc2": ("monthly_closing",),
    "open-prescriptions": ("future_prescriptions",), "reorder": ("order_suggestions",),
    "patients": _PATIENTS, "lost-customers": ("patient_analytics",), "consumables": ("patient_analytics",),
    "campaigns": ("patient_analytics",),          # ίδιο με το ελληνικό «Καμπάνιες»
    "doctors": ("doctor_analytics",), "profitability": ("profitability",), "loans": ("advance_dispensing",),
}
# Χωρίς πρόσθετο: η ΤΡΟΦΟΔΟΣΙΑ δεδομένων (όπως η σύνδεση ΗΔΥΚΑ στην Ελλάδα).
CY_ROUTE_FREE = frozenset({"import", "pharmacyone"})


def route_key(path: str) -> str:
    rest = path.split("/cy/", 1)[1] if "/cy/" in path else ""
    return rest.split("/", 1)[0]


def _check_modules(ctx: TenantContext, path: str) -> None:
    from app.core.deps import _module_locked
    key = route_key(path)
    if key in CY_ROUTE_FREE:
        return
    mods = CY_ROUTE_MODULES.get(key)
    if mods is None:                           # άγνωστη κυπριακή διαδρομή: κλείνει (ποτέ σιωπηλά ανοιχτή)
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"error": "module_locked", "module": key})
    if all(_module_locked(ctx, m) for m in mods):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"error": "module_locked", "module": mods[0]})


async def require_cy(request: Request, ctx: TenantContext = Depends(get_current_context)) -> TenantContext:
    if not await cy_enabled() or await tenant_country(ctx.tenant_id) != "CY":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    if getattr(request, "url", None) is not None:
        _check_modules(ctx, request.url.path)
    request.state.cy_demo = bool(getattr(ctx, "demo", False))     # «Λειτουργία παρουσίασης» → CyMaskedRoute κρύβει πρόσωπα
    return ctx
