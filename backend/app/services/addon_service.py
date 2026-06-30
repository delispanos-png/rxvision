"""Add-on catalog + per-tenant activation.

An **add-on = a module sold à la carte** (its `_id` IS the module key it unlocks). Activating an
add-on does two things:
  1) entitlement — writes a tenant module override (`tenants.modules.{key}="enabled"`), reusing the
     exact gating system every feature already checks (no special-casing anywhere);
  2) billing — records the add-on on the subscription (`subscriptions.addons[]`) and recomputes
     `subscriptions.addons_total`, so the recurring charge = base + Σ active add-on prices.

Add-ons are NOT part of any package. A module that a tenant's plan already includes is shown as
«included» and is not purchasable. A module granted manually by the platform admin (override but no
billing record) is shown as «granted» (comp) and is not billed.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db
from app.services.auth_service import resolve_tenant_modules, tenant_has

# Seeded into the `addons` collection on first read if empty. _id == module key it unlocks.
# Prices in integer cents (project convention). Yearly ≈ 10× monthly (2 months free).
_DEFAULTS: list[dict] = [
    {"_id": "ai_assistant", "name": "AI Βοηθός", "icon": "✨", "category": "ai",
     "description": "Το AI που δουλεύει για εσένα: διαβάζει & ελέγχει συνταγές, σε συμβουλεύει κλινικά και καθοδηγεί τη χρήση.",
     "price_monthly": 3000, "price_yearly": 30000, "active": True,
     "features": ["Prescriptor — αυτόματη ανάγνωση & έλεγχος συνταγών",
                  "PharmaCat — κλινικός σύμβουλος", "AI Copilot — βοηθός χρήσης",
                  "AI συμβουλές ασθενούς (Εικόνα 360°)"]},
    {"_id": "pharmacat", "name": "PharmaCat", "icon": "🤖", "category": "ai",
     "description": "Κλινικός AI σύμβουλος στον πάγκο: συμπτώματα, αλληλεπιδράσεις, ασφάλεια, OTC.",
     "price_monthly": 1500, "price_yearly": 15000, "active": True,
     "features": ["Κλινικός σύμβουλος (CDSS)", "Έλεγχος αλληλεπιδράσεων", "Red-flag & παραπομπές"]},
    {"_id": "monthly_closing", "name": "Έλεγχος & Κλείσιμο ΕΟΠΥΥ", "icon": "🧾", "category": "ops",
     "description": "Reimbursement Intelligence: κλείσιμο μήνα, rebate, ανοιχτά υπόλοιπα, Έλεγχος Barcode.",
     "price_monthly": 2500, "price_yearly": 25000, "active": True,
     "features": ["Κλείσιμο μήνα & υποβολή", "Rebate / έκπτωση τζίρου", "Έλεγχος Barcode & ανοιχτά υπόλοιπα"]},
    {"_id": "patient_analytics", "name": "Patient Intelligence", "icon": "🧠", "category": "intelligence",
     "description": "Ανάλυση ασθενών: compliance, recall, win-back, VIP, segments + Εικόνα Πελάτη 360°.",
     "price_monthly": 2500, "price_yearly": 25000, "active": True,
     "features": ["Compliance / recall / win-back", "VIP & segments", "Εικόνα Πελάτη 360°"]},
    {"_id": "nutrition", "name": "Διατροφή", "icon": "🥗", "category": "ai",
     "description": "AI διατροφικό πλάνο ανά ασθενή με βάση τις παθήσεις & τη φαρμακευτική αγωγή.",
     "price_monthly": 1000, "price_yearly": 10000, "active": True,
     "features": ["AI διατροφικό πλάνο", "Προσαρμογή στις παθήσεις", "Αποστολή στον ασθενή"]},
    {"_id": "patient_portal", "name": "Πύλη Πελατών", "icon": "👥", "category": "consumer",
     "description": "Η δική σου εφαρμογή για τους πελάτες (my.rxvision.gr): ραντεβού, υπενθυμίσεις, διαθεσιμότητα.",
     "price_monthly": 1900, "price_yearly": 19000, "active": True,
     "features": ["Εφαρμογή ασθενούς my.rxvision.gr", "Ραντεβού & υπενθυμίσεις θεραπείας",
                  "Διασύνδεση με το φαρμακείο σου"]},
    {"_id": "loyalty", "name": "Πιστότητα", "icon": "🎁", "category": "consumer",
     "description": "Επιβράβευση πιστών πελατών: πόντοι που γίνονται €, gamified wallet στην εφαρμογή.",
     "price_monthly": 1900, "price_yearly": 19000, "active": True,
     "features": ["Πόντοι → €", "Επιβράβευση συνέπειας χρόνιων ασθενών", "Wallet στην εφαρμογή πελάτη"]},
    {"_id": "order_delivery", "name": "Παραγγελίες & Αποστολή", "icon": "🚚", "category": "consumer",
     "description": "Κατάλογος ειδών + e-shop + κύκλωμα παραγγελιών με παράδοση ή παραλαβή.",
     "price_monthly": 2900, "price_yearly": 29000, "active": True,
     "features": ["Κατάλογος OTC & παραφαρμακευτικών", "e-shop για τους πελάτες σου",
                  "Worklist παραγγελιών (delivery/pickup)"]},
]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _ensure_seed() -> None:
    db = shared_db()
    if await db["addons"].count_documents({}) == 0:
        for a in _DEFAULTS:
            await db["addons"].update_one({"_id": a["_id"]},
                                          {"$setOnInsert": {**a, "updated_at": _now()}}, upsert=True)


async def catalog(active_only: bool = True) -> list[dict]:
    await _ensure_seed()
    flt = {"active": True} if active_only else {}
    return [a async for a in shared_db()["addons"].find(flt).sort("price_monthly", 1)]


async def _recompute_total(tenant_id: str) -> int:
    """Sum the prices of the tenant's active add-ons for its billing cycle → addons_total (cents)."""
    db = shared_db()
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    yearly = sub.get("billing_cycle") == "yearly"
    ids = sub.get("addons", []) or []
    total = 0
    if ids:
        async for a in db["addons"].find({"_id": {"$in": ids}}):
            total += int(a.get("price_yearly" if yearly else "price_monthly", 0) or 0)
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$set": {"addons_total": total}})
    return total


def _status(key: str, *, in_plan: bool, in_addons: bool, entitled: bool) -> str:
    if in_plan:
        return "included"          # already part of the plan → not purchasable
    if in_addons:
        return "active"            # paid add-on, currently on
    if entitled:
        return "granted"           # comp grant by platform admin (entitled, not billed)
    return "available"             # purchasable


async def for_tenant(tenant_id: str) -> dict:
    """Catalog annotated for ONE tenant: per add-on status (included/active/granted/available)."""
    db = shared_db()
    mods = await resolve_tenant_modules(tenant_id)
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    active = set(sub.get("addons", []) or [])
    included = set(sub.get("modules_included", []) or [])
    yearly = sub.get("billing_cycle") == "yearly"
    cat = await catalog()
    # which add-ons THIS tenant's package offers (legacy: field absent → all are offered)
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
    offered = (set(pkg.get("available_addons") or []) if (pkg and pkg.get("available_addons") is not None)
               else {a["_id"] for a in cat})
    items = []
    for a in cat:
        key = a["_id"]
        items.append({**a, "offered": key in offered,
                      "status": _status(key, in_plan=key in included,
                                        in_addons=key in active, entitled=tenant_has(mods, key))})
    return {"addons": items, "addons_total": int(sub.get("addons_total", 0) or 0),
            "billing_cycle": "yearly" if yearly else "monthly"}


async def activate(tenant_id: str, addon_id: str) -> dict:
    """Turn an add-on ON for a tenant: entitlement (module override) + billing record."""
    db = shared_db()
    a = await db["addons"].find_one({"_id": addon_id, "active": True})
    if not a:
        return {"ok": False, "error": "unknown_addon"}
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    if addon_id in set(sub.get("modules_included", []) or []):
        return {"ok": False, "error": "included_in_plan"}
    await db["tenants"].update_one({"_id": tenant_id},
                                   {"$set": {f"modules.{addon_id}": "enabled"}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id},
                                         {"$addToSet": {"addons": addon_id}}, upsert=True)
    total = await _recompute_total(tenant_id)
    return {"ok": True, "addon": addon_id, "addons_total": total}


async def deactivate(tenant_id: str, addon_id: str) -> dict:
    """Turn an add-on OFF: remove the module override + the billing record, recompute total."""
    db = shared_db()
    await db["tenants"].update_one({"_id": tenant_id}, {"$unset": {f"modules.{addon_id}": ""}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$pull": {"addons": addon_id}})
    total = await _recompute_total(tenant_id)
    return {"ok": True, "addon": addon_id, "addons_total": total}
