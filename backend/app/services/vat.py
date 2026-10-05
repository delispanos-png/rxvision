"""ΦΠΑ λιανικής των συνταγογραφούμενων — ΕΝΑΣ ορισμός για κάθε υπολογισμό κέρδους (05/10/2026).

Η ΧΟΝΔΡΙΚΗ είναι ΧΩΡΙΣ ΦΠΑ, η ΛΙΑΝΙΚΗ ΜΕ ΦΠΑ. Μετρημένο σε 12.729 φάρμακα του καταλόγου ΗΔΥΚΑ:
λιανική = χονδρική × (1 + περιθώριο) × 1,06 — π.χ. χονδρική ≤ 50 € → λόγος 1,3784 = 1,30 × 1,06.
Ο ΦΠΑ δεν είναι έσοδο του φαρμακείου (τον αποδίδει, συμψηφισμένο με τον ΦΠΑ της χονδρικής), άρα:

    ΜΕΙΚΤΟ ΚΕΡΔΟΣ = λιανική ΧΩΡΙΣ ΦΠΑ − χονδρική      ΠΕΡΙΘΩΡΙΟ = κέρδος ÷ λιανική ΧΩΡΙΣ ΦΠΑ

Πριν: λιανική ΜΕ ΦΠΑ − χονδρική → κέρδος φουσκωμένο κατά ~5,7% των πωλήσεων.

Συντελεστής: όλα τα είδη της ΗΔΥΚΑ (κανονικά, ναρκωτικά, γαληνικά, ΙΦΕΤ) είναι φάρμακα → 6%.
Εξαιρέσεις ανά φαρμακείο: `tenants.medicine_vat_pct` (π.χ. νησιά με μειωμένο ΦΠΑ 4%)· Κύπρος 5%.
"""

from __future__ import annotations

DEFAULT_PCT = 6.0
#: ΦΠΑ ανά κατηγορία είδους ΗΔΥΚΑ. Όλα φάρμακα σήμερα — νέα κατηγορία με άλλον ΦΠΑ μπαίνει ΕΔΩ.
CATEGORY_PCT = {"normal": 6.0, "narcotic": 6.0, "galenic": 6.0, "ifet": 6.0}
COUNTRY_PCT = {"GR": 6.0, "CY": 5.0}


def divisor(pct: float) -> float:
    """Λιανική με ΦΠΑ ÷ divisor = λιανική χωρίς ΦΠΑ."""
    return 1 + float(pct) / 100


def net(gross: float, pct: float = DEFAULT_PCT) -> float:
    return (gross or 0) / divisor(pct)


def gross_profit(gross_value: float, cost: float, pct: float = DEFAULT_PCT) -> float:
    return net(gross_value, pct) - (cost or 0)


def margin_pct(gross_value: float, cost: float, pct: float = DEFAULT_PCT) -> float:
    n = net(gross_value, pct)
    return (n - (cost or 0)) / n * 100 if n else 0.0


def net_expr(field: str | dict, pct: float = DEFAULT_PCT) -> dict:
    """Mongo: λιανική χωρίς ΦΠΑ από πεδίο/έκφραση με ΦΠΑ."""
    return {"$divide": [{"$ifNull": [field, 0]}, divisor(pct)]}


def profit_expr(value_field: str | dict, cost_field: str | dict, pct: float = DEFAULT_PCT) -> dict:
    """Mongo: μεικτό κέρδος = λιανική χωρίς ΦΠΑ − χονδρική."""
    return {"$subtract": [net_expr(value_field, pct), {"$ifNull": [cost_field, 0]}]}


def tenant_pct(tenant: dict | None) -> float:
    t = tenant or {}
    if t.get("medicine_vat_pct") is not None:
        return float(t["medicine_vat_pct"])
    return COUNTRY_PCT.get(str(t.get("country") or "GR").upper(), DEFAULT_PCT)


async def pct_for(tenant_id: str | None, db=None) -> float:
    """Ο συντελεστής του φαρμακείου (ρύθμιση → χώρα → 6%). `db` = η βάση του καλούντος (repository/engine)."""
    if not tenant_id:
        return DEFAULT_PCT
    if db is None:
        from app.core.db import shared_db
        db = shared_db()
    coll = db["tenants"]
    if not hasattr(coll, "find_one"):      # βάση χωρίς πίνακα φαρμακείων (π.χ. δοκιμαστική) → φάρμακα 6%
        return DEFAULT_PCT
    t = await coll.find_one({"_id": tenant_id}, {"medicine_vat_pct": 1, "country": 1})
    return tenant_pct(t)
