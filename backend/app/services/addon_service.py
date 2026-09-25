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

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.services.auth_service import resolve_tenant_modules, tenant_has

_TRIAL_DAYS = 14

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
    {"_id": "care_homes", "name": "Δομές Φροντίδας", "icon": "🏠",
     "category": "intelligence",
     "description": "Γηροκομεία, ξενώνες, δομές φιλοξενίας, κατ' οίκον φροντίδα: βλέπεις τι "
                    "ανοίγει τον επόμενο μήνα ανά τρόφιμο, τι να παραγγείλεις συγκεντρωτικά, "
                    "και κρατάς τον λογαριασμό της δομής — χρεώσεις συμμετοχών, εισπράξεις, "
                    "ανοιχτό υπόλοιπο.",
     "price_monthly": 2000, "price_yearly": 20000, "active": True,
     "features": ["Τι ανοίγει τον επόμενο κύκλο, ανά τρόφιμο",
                  "Λίστα παραγγελίας αθροισμένη ανά σκεύασμα",
                  "Λογαριασμός με μεταφορά υπολοίπου, σαν εκκαθαριστικό",
                  "Πορτφόλιο: όλες οι δομές και τι χρωστούν"]},
    {"_id": "family_groups", "name": "Οικογένειες", "icon": "👨‍👩‍👧",
     "category": "intelligence",
     "description": "Βλέπεις ένα ολόκληρο σπίτι με μια ματιά: ποιος πήρε τι, τι έμεινε "
                    "ανεκτέλεστο, ποιος χρωστά δανεικά και πότε ανοίγει η επόμενη επανάληψη. "
                    "Γράφεις το ΑΜΚΑ κάθε μέλους — ακόμη κι αν δεν έχει έρθει ποτέ, θα συνδεθεί "
                    "μόνο του με την πρώτη του συνταγή.",
     "price_monthly": 1500, "price_yearly": 15000, "active": True,
     "features": ["Όλα τα μέλη σε μία οθόνη", "Μέλος χωρίς δεδομένα συνδέεται αυτόματα",
                  "Εκκρεμότητες πρώτες: ανεκτέλεστα & δανεικά",
                  "Σήμανση ανηλίκων και πότε ενηλικιώνονται"]},
    {"_id": "advance_dispensing", "name": "Προχορηγήσεις (δανεικά)", "icon": "🤝",
     "category": "intelligence",
     "description": "Καταγραφή σκευασμάτων που έδωσες χωρίς συνταγή: σαρώνεις τα κουτιά το ένα "
                    "μετά το άλλο, τα χρεώνεις στον πελάτη, και όταν έρθει η συνταγή το σύστημα "
                    "σου προτείνει την ξεχρέωση.",
     "price_monthly": 2500, "price_yearly": 25000, "active": True,
     "features": ["Σάρωση QR ή ταινίας ΕΟΦ, χωρίς πάτημα", "Χρέωση σε υπαρκτό πελάτη",
                  "Ειδοποίηση στην καρτέλα του πελάτη",
                  "Πρόταση ξεχρέωσης όταν κατέβει η συνταγή"]},
    {"_id": "catalog_seed", "name": "Έτοιμος κατάλογος ειδών", "icon": "📦",
     "category": "ops",
     "description": "Σου φορτώνουμε έτοιμο κατάλογο ειδών — φάρμακα, ΜΗ.ΣΥ.ΦΑ. και παραφάρμακα "
                    "— με ονόματα, barcodes, τιμές, κατηγορίες και φωτογραφίες. Δεν χρειάζεται "
                    "να καταχωρήσεις τίποτα με το χέρι για να ξεκινήσεις.",
     "price_monthly": 1500, "price_yearly": 15000, "active": True, "no_trial": True,
     "features": ["Δεκάδες χιλιάδες είδη με barcode & φωτογραφία",
                  "Διαλέγεις κατηγορίες: μόνο φάρμακα, μόνο παραφάρμακα, ή όλα",
                  "Αυτόματη κατηγοριοποίηση και για ό,τι νέο μπαίνει",
                  "Το απόθεμα ξεκινά στο μηδέν — δεν πειράζει ό,τι έχεις ήδη"]},
    {"_id": "connect", "name": "RxVision Connect", "icon": "🤝", "category": "ops",
     "description": "Το δίκτυό σου: ζητάς ένα σκεύασμα από τα συνεργαζόμενα φαρμακεία σου και "
                    "βλέπεις αμέσως ποιος μπορεί να το καλύψει. Κάθε κίνηση καταγράφεται — τι "
                    "έλαβες, τι διέθεσες, τι μένει ανοιχτό.",
     "price_monthly": 3000, "price_yearly": 30000, "active": True,
     "features": ["Δικά σου δίκτυα — πρόσκληση με ΑΦΜ και αποδοχή",
                  "Αίτημα σε όλο το δίκτυο, με μερική κάλυψη από πολλούς",
                  "Αυτόματη απάντηση από το απόθεμα που ξέρουμε",
                  "Εσύ ορίζεις πόσο δίνεις: ποσοστό ανά δίκτυο + απόθεμα ασφαλείας",
                  "Ανοιχτά υπόλοιπα, επιστροφές και τακτοποίηση"]},
    {"_id": "therapy_programs", "name": "Θεραπείες με Επανάληψη", "icon": "🔁",
     "category": "intelligence",
     "description": "Θεραπείες που επαναλαμβάνονται κάθε λίγους μήνες (Prolia κάθε 6, "
                    "Ajovy κάθε 3, Stelara, Eylea): ορίζεις ποιες παρακολουθείς με ηλικία "
                    "και φύλο, και το σύστημα σου λέει ποιος έχει καθυστερήσει και πόσο. "
                    "Φαίνεται και στην Εικόνα Πελάτη.",
     "price_monthly": 1000, "price_yearly": 10000, "active": True,
     "features": ["Επανάληψη σε μήνες, όχι μόνο έτη", "Ηλικία & φύλο ανά θεραπεία",
                  "Καταγραφή δόσης που έγινε αλλού", "Λίστα εκπρόθεσμων με καθυστέρηση σε ημέρες"]},
    {"_id": "vaccination_programs", "name": "Περιοδικός Εμβολιασμός", "icon": "💉", "category": "intelligence",
     "description": "Παρακολούθηση μη εποχικών εμβολίων (έρπης ζωστήρας, τέτανος, πνευμονιόκοκκος): "
                    "ορίζεις ποια παρακολουθείς, το σύστημα βρίσκει πότε τα έκανε ο καθένας και "
                    "ειδοποιεί όταν λήγουν. Περιλαμβάνει αναδρομή 5ετίας.",
     "price_monthly": 1000, "price_yearly": 10000, "active": True,
     "features": ["Επιλογή εμβολίων ανά ομάδα ATC", "Σειρά δόσεων & αναμνηστικές",
                  "Αναδρομική άντληση 5ετίας", "Ειδοποιήσεις λήξης"]},
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
    {"_id": "marketing", "name": "Στοχευμένη Προώθηση", "icon": "📣", "category": "consumer",
     "description": "Εμπορικό κύκλωμα: στοχευμένες καμπάνιες ανά θεραπευτική κατηγορία, δωρεάν push, κουπόνια & μέτρηση απόδοσης.",
     "price_monthly": 2500, "price_yearly": 25000, "active": True,
     "features": ["Στόχευση ανά θεραπευτική κατηγορία (1 κλικ)", "Κανάλι Push ΔΩΡΕΑΝ",
                  "Κουπόνια + μέτρηση απόδοσης (ROI)"]},
    {"_id": "daily_coach", "name": "Ο Σύμβουλός σου", "icon": "🧭", "category": "intelligence",
     "description": "Κάθε μέρα σου λέει τι ξέφυγε, ποιον πρέπει να πάρεις τηλέφωνο και τι σου κόστισε — σε ανθρώπινη γλώσσα, με όνομα και ενέργεια. Και σε επιβραβεύει για ό,τι πήγε καλά.",
     # Άνοιξε 21/09/2026: ολοκληρώθηκε (κύκλωμα καθημερινής αξιολόγησης, 15-16/09) και
     # πωλείται κανονικά ως πρόσθετη υπηρεσία σε κάθε συνδρομή.
     "price_monthly": 2500, "price_yearly": 25000, "active": True,
     "features": ["Καθημερινή αξιολόγηση του φαρμακείου σε απλά ελληνικά",
                  "Κάθε γραμμή = ένας άνθρωπος, μία ενέργεια, ένα κόστος",
                  "Επιβράβευση για ό,τι έγινε σωστά + γραμμή αυτοβελτίωσης",
                  "Ο τόνος σκληραίνει στα λάθη που επαναλαμβάνονται"]},
    {"_id": "drug_interactions", "name": "Έλεγχος Αλληλεπιδράσεων", "icon": "🧪", "category": "ai",
     "description": "Έλεγχος αλληλεπιδράσεων φαρμάκων σε μία συνταγή ή σε ΟΛΗ την ενεργή αγωγή του ασθενή (DrugBank curated / AI).",
     "price_monthly": 1500, "price_yearly": 15000, "active": True,
     "features": ["Έλεγχος αλληλεπιδράσεων ανά συνταγή", "Έλεγχος σε όλη την ενεργή αγωγή του ασθενή",
                  "Βαρύτητα · μηχανισμός · κίνδυνος · ενέργεια"]},
]


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _ensure_seed() -> None:
    # Upsert-missing: κάθε default μπαίνει ΜΟΝΟ αν λείπει ($setOnInsert) — έτσι νέα add-ons (π.χ.
    # drug_interactions) σπέρνονται και σε ΗΔΗ γεμάτη addons collection, χωρίς να πειράζουν τα υπάρχοντα.
    db = shared_db()
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
    # extended retention (>36μ) — κλιμακωτή επιβάρυνση στο ίδιο addons_total (billing = base + addons_total).
    # Το AI ΔΕΝ επιβαρύνει πλέον τη συνδρομή: το included ορίζεται από το πακέτο, το overage = AI credits.
    # Μηνιαίες τιμές × 12 σε yearly cycle.
    from app.services.data_retention import retention_surcharge_monthly
    extra = await retention_surcharge_monthly(db, tenant_id)
    total += extra * 12 if yearly else extra
    # επιπλέον χρήστες (seats) — η τιμή/χρήστη είναι ΤΟΥ ΠΑΚΕΤΟΥ του πελάτη & ήδη ανά κύκλο
    # (ετήσια τιμή ανά έτος), οπότε προστίθεται ΑΠΕΥΘΕΙΑΣ (όχι ×12).
    from app.services.seats_service import seat_surcharge_for_cycle
    total += await seat_surcharge_for_cycle(db, tenant_id)
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
    from app.services import billing_service
    return {"addons": items, "addons_total": int(sub.get("addons_total", 0) or 0),
            "billing_cycle": "yearly" if yearly else "monthly",
            # Το UI πρέπει να ΞΕΡΕΙ από πριν ότι λείπει κάρτα, αντί να το ανακαλύπτει ο πελάτης
            # πατώντας «Ενεργοποίηση» και τρώγοντας άρνηση.
            "card_on_file": await billing_service.card_on_file(tenant_id)}


def _prorated_addon(price_cents: int, sub: dict, yearly: bool) -> tuple[int, int]:
    """(αναλογικό ποσό, μέρες που απομένουν) για ένα πρόσθετο στο υπόλοιπο της τρέχουσας περιόδου.

    ΓΙΑΤΙ ΥΠΑΡΧΕΙ: χωρίς αυτό, πελάτης με ΕΤΗΣΙΑ συνδρομή που μόλις ανανέωσε μπορούσε να
    ενεργοποιήσει πρόσθετο και να το χρησιμοποιεί έντεκα μήνες ΔΩΡΕΑΝ — η πρώτη χρέωση θα
    ερχόταν στην επόμενη ανανέωση. Ίδια λογική με τα seats (services/seats_service.py).
    """
    period_days = 365 if yearly else 30
    period_end = sub.get("current_period_end")
    remaining = max(0, (period_end - _now()).days) if period_end else period_days
    frac = min(1.0, max(0.0, remaining / period_days))
    return max(0, round(price_cents * frac)), remaining


async def activation_quote(tenant_id: str, addon_id: str) -> dict:
    """Τι ΑΚΡΙΒΩΣ θα χρεωθεί τώρα η κάρτα — για να το δει ο πελάτης ΠΡΙΝ πατήσει.

    Ποτέ δεν χρεώνουμε κάρτα με ποσό που ο πελάτης δεν έχει δει γραμμένο.
    """
    from app.services import billing_service
    from app.services.invoice_service import gross_from_price
    db = shared_db()
    a = await db["addons"].find_one({"_id": addon_id, "active": True})
    if not a:
        return {"ok": False, "error": "unknown_addon"}
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    yearly = sub.get("billing_cycle") == "yearly"
    price = int(a.get("price_yearly" if yearly else "price_monthly") or 0)
    tenant = await db["tenants"].find_one({"_id": tenant_id}, {"country": 1}) or {}
    pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
    inc_vat = bool((pkg or {}).get("price_includes_vat") or sub.get("price_includes_vat"))
    net, remaining = _prorated_addon(price, sub, yearly)
    return {"ok": True, "addon": addon_id, "name": a.get("name"),
            "cycle": "yearly" if yearly else "monthly",
            "full_price_cents": gross_from_price(price, inc_vat, tenant.get("country")),
            "charge_now_cents": gross_from_price(net, inc_vat, tenant.get("country")),
            "remaining_days": remaining,
            "card_on_file": await billing_service.card_on_file(tenant_id)}


async def activate(tenant_id: str, addon_id: str) -> dict:
    """Turn an add-on ON for a tenant: entitlement (module override) + billing record.

    ΑΠΑΙΤΕΙΤΑΙ ΚΑΡΤΑ. Το πρόσθετο είναι ΕΠΑΝΑΛΑΜΒΑΝΟΜΕΝΗ μηνιαία χρέωση που μπαίνει στη
    συνδρομή. Χωρίς αποθηκευμένη κάρτα δεν υπάρχει τρόπος να εισπραχθεί, οπότε ο πελάτης θα
    χρησιμοποιούσε τη δυνατότητα και εμείς θα κυνηγούσαμε την πληρωμή εκ των υστέρων. Ίδιος
    κανόνας με τα χρεώσιμα extras (όριο AI / διατήρηση δεδομένων) — ένα gate, ένας ορισμός.
    """
    from app.services import billing_service
    db = shared_db()
    a = await db["addons"].find_one({"_id": addon_id, "active": True})
    if not a:
        return {"ok": False, "error": "unknown_addon"}
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id}) or {}
    if addon_id in set(sub.get("modules_included", []) or []):
        return {"ok": False, "error": "included_in_plan"}
    # Δωρεάν πρόσθετα δεν χρειάζονται κάρτα — δεν χρεώνονται ποτέ.
    yearly = sub.get("billing_cycle") == "yearly"
    price = int(a.get("price_yearly" if yearly else "price_monthly") or 0)
    if price > 0:
        from app.services import billable_gate
        reason = await billable_gate.blocked_reason(tenant_id, "addons")
        if reason:
            return {"ok": False, "error": "card_required", "message": reason}

    # ── ΑΜΕΣΗ ΑΝΑΛΟΓΙΚΗ ΧΡΕΩΣΗ για ό,τι απομένει στην περίοδο ───────────────────────────────
    charged = 0
    if price > 0:
        from app.services.invoice_service import gross_from_price
        tenant = await db["tenants"].find_one({"_id": tenant_id}, {"country": 1}) or {}
        pkg = await db["packages"].find_one({"_id": sub.get("plan")}) if sub.get("plan") else None
        inc_vat = bool((pkg or {}).get("price_includes_vat") or sub.get("price_includes_vat"))
        net, remaining = _prorated_addon(price, sub, yearly)
        gross = gross_from_price(net, inc_vat, tenant.get("country"))
        if gross > 0:
            res = await billing_service._charge_recurring(sub, gross, tenant_id)
            if not res.get("ok"):
                # ΔΕΝ ανοίγουμε τη δυνατότητα αν δεν πληρώθηκε. Αλλιώς ο πελάτης τη χρησιμοποιεί
                # και εμείς κυνηγάμε την είσπραξη — ακριβώς αυτό που θέλαμε να αποφύγουμε.
                return {"ok": False, "error": "charge_failed",
                        "message": "Η χρέωση της κάρτας δεν ολοκληρώθηκε. Έλεγξε την κάρτα σου "
                                   "στις Ρυθμίσεις → Χρέωση και δοκίμασε ξανά."}
            charged = gross
            from app.services import invoice_service, receipts
            label = f"{a.get('name') or addon_id} — αναλογικά για {remaining} ημέρες"
            await receipts.record(tenant_id, "extra", f"Πρόσθετο RxVision: {label}", gross,
                                  method="card", provider=res.get("provider", "viva"),
                                  provider_order_id=res.get("order_id"))
            await invoice_service.create_for_payment(
                tenant_id=tenant_id, kind="extra", gross_cents=gross,
                description=f"Πρόσθετο RxVision: {label}",
                payment={"method": "card", "provider": res.get("provider", "viva"),
                         "transaction_id": res.get("order_id")},
                item_key=f"addon:{addon_id}")

    await db["tenants"].update_one({"_id": tenant_id},
                                   {"$set": {f"modules.{addon_id}": "enabled"}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id},
                                         {"$addToSet": {"addons": addon_id}}, upsert=True)
    total = await _recompute_total(tenant_id)
    return {"ok": True, "addon": addon_id, "addons_total": total, "charged_now": charged}


#: Πρόσθετα ΕΚΤΟΣ δωρεάν δοκιμής — αγοράζονται απευθείας.
#: Ο «Έτοιμος κατάλογος» δεν είναι δυνατότητα που δοκιμάζεις και μετά την αφήνεις: τη στιγμή που
#: θα τον δοκίμαζε, δεκάδες χιλιάδες είδη θα είχαν ήδη μπει στον κατάλογό του. Δεν υπάρχει
#: «τέλος δοκιμής» που να τα ξαναπαίρνει πίσω χωρίς να καταστρέψει δουλειά του.
NO_TRIAL = {"catalog_seed"}


async def start_trial(tenant_id: str, module: str) -> dict:
    """Self-service trial of the SMALLEST package that unlocks `module` — grants that package's
    still-missing modules as time-limited trials (auth resolution downgrades expired trials to locked).
    Already-owned modules are left untouched, so an expiring trial can never remove a paid feature.

    ΦΡΟΥΡΟΣ — ΜΙΑ ΔΟΚΙΜΗ ΠΡΟΣΘΕΤΟΥ ΑΝΑ ΠΕΛΑΤΗ.

    ⚠️ ΔΙΟΡΘΩΣΗ 22/09/2026: ο έλεγχος κοίταζε το `subscriptions.trial_ends_at` — δηλαδή τη
    ΔΟΚΙΜΑΣΤΙΚΗ ΠΕΡΙΟΔΟ ΤΗΣ ΣΥΝΔΡΟΜΗΣ, που την έχει ΚΑΘΕ φαρμακείο επειδή όλα ξεκινούν με
    trial. Αποτέλεσμα: **14 από τα 15 φαρμακεία** ήταν μπλοκαρισμένα από την πρώτη μέρα και
    καμία δοκιμή προσθέτου δεν μπορούσε να ξεκινήσει ποτέ. Τα δύο «trial» είναι ΔΙΑΦΟΡΕΤΙΚΑ
    πράγματα: το ένα είναι η δοκιμή του ΠΡΟΪΟΝΤΟΣ, το άλλο η δοκιμή μιας ΔΥΝΑΤΟΤΗΤΑΣ.

    Πηγή αλήθειας πλέον = `addon_grants` με `by="self-service"`: έχει ΑΥΤΟΣ ο πελάτης πάρει
    ξανά δοκιμή προσθέτου μόνος του;"""
    if module in NO_TRIAL:
        return {"ok": False, "error": "no_trial",
                "message": "Αυτό το πρόσθετο δεν έχει δωρεάν δοκιμή — ενεργοποιείται απευθείας."}
    db = shared_db()
    prior = await db["addon_grants"].find_one({"tenant_id": tenant_id, "by": "self-service"})
    if prior:
        return {"ok": False, "error": "trial_used",
                "message": "Έχεις ήδη χρησιμοποιήσει τη δωρεάν δοκιμή δυνατοτήτων — οι επιπλέον "
                           "δυνατότητες αγοράζονται απευθείας (χωρίς δοκιμή)."}
    # smallest PAID active package that unlocks the module (skip the €0 free-trial package, which
    # bundles everything — we don't want a click to trial the entire catalogue).
    pkgs = [p async for p in db["packages"].find({"active": True}).sort("price_monthly", 1)
            if (p.get("price_monthly") or 0) > 0]
    target = next((p for p in pkgs if module in (p.get("modules") or [])), None)
    grant = (target.get("modules") if target else [module]) or [module]
    current = await resolve_tenant_modules(tenant_id)
    exp = datetime.now(tz=timezone.utc) + timedelta(days=_TRIAL_DAYS)
    sets: dict = {}
    granted: list[str] = []
    for m in grant:
        if m in NO_TRIAL:               # δεν μπαίνει ούτε «μαζί με το πακέτο» σε δοκιμή
            continue
        if tenant_has(current, m):      # already owned → don't shadow with a trial that would expire
            continue
        sets[f"modules.{m}"] = "trial"
        sets[f"module_trials.{m}"] = exp
        granted.append(m)
    if not sets:
        return {"ok": True, "package": (target or {}).get("_id"), "trial_days": _TRIAL_DAYS, "modules": [], "already": True}
    sets["updated_at"] = datetime.now(tz=timezone.utc)
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": sets})
    # Καταγραφή ΕΝΑΡΞΗΣ: χωρίς αυτήν ξέρουμε μόνο πότε λήγει η δοκιμή, όχι πότε ξεκίνησε —
    # και το κύκλωμα παρακολούθησης (module_trials_service) δεν μπορεί να πει «πότε το πήρε».
    await db["addon_grants"].insert_many([{
        "tenant_id": tenant_id, "module": m, "days": _TRIAL_DAYS, "expires_at": exp,
        "by": "self-service", "at": sets["updated_at"]} for m in granted])
    return {"ok": True, "package": (target or {}).get("_id"), "trial_days": _TRIAL_DAYS, "modules": granted}


async def grant_preview(tenant_id: str, module: str, *, days: int = 30,
                        by: str | None = None) -> dict:
    """Παραχώρηση δυνατότητας «για να τη δει» — απόφαση της πλατφόρμας, όχι αυτοεξυπηρέτηση.

    Γιατί ΔΕΝ ξαναχρησιμοποιούμε το start_trial(): εκείνο έχει φρουρό «μία δοκιμή ανά πελάτη»
    (σωστό για self-service) που θα απέκλειε ΚΑΘΕ υπάρχοντα συνδρομητή — δηλαδή ακριβώς αυτούς
    στους οποίους θέλουμε να δείξουμε κάτι νέο. Εδώ ανοίγει ΜΟΝΟ το ζητούμενο module, για
    συγκεκριμένες μέρες, και κλείνει μόνο του (expired trial → locked στο login/refresh).
    """
    db = shared_db()
    t = await db["tenants"].find_one({"_id": tenant_id}, {"modules": 1})
    if not t:
        return {"ok": False, "error": "tenant_not_found"}
    if (t.get("modules") or {}).get(module) == "enabled":
        return {"ok": False, "error": "already_enabled"}
    exp = _now() + timedelta(days=int(days))
    await db["tenants"].update_one({"_id": tenant_id}, {"$set": {
        f"modules.{module}": "trial", f"module_trials.{module}": exp,
        "updated_at": _now()}})
    await db["addon_grants"].insert_one({
        "tenant_id": tenant_id, "module": module, "days": int(days),
        "expires_at": exp, "by": by, "at": _now()})
    return {"ok": True, "module": module, "days": int(days), "expires_at": exp}


async def deactivate(tenant_id: str, addon_id: str) -> dict:
    """Turn an add-on OFF: remove the module override + the billing record, recompute total."""
    db = shared_db()
    await db["tenants"].update_one({"_id": tenant_id}, {"$unset": {f"modules.{addon_id}": ""}})
    await db["subscriptions"].update_one({"tenant_id": tenant_id}, {"$pull": {"addons": addon_id}})
    total = await _recompute_total(tenant_id)
    return {"ok": True, "addon": addon_id, "addons_total": total}
