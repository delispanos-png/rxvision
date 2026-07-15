"""Μηχανή εκπτώσεων e-shop — ΚΑΘΑΡΕΣ συναρτήσεις (χωρίς DB) ώστε να ελέγχονται εύκολα.

ΣΕΙΡΑ ΕΦΑΡΜΟΓΗΣ (ρητή — να μη σωρεύονται εκπτώσεις ανεξέλεγκτα):
  1. Ανά γραμμή : max(δική του έκπτωση, καμπάνια ομάδας)  [+ έκπτωση συνδρομής στα παραφάρμακα]
  2. Πακέτα     : «2+1» ή combo → έκπτωση σε ΤΕΜΑΧΙΑ/γραμμές του πακέτου  (αθροίζεται με το 1)
  3. Καλάθι     : ΚΑΛΥΤΕΡΟ από (κλιμακωτή έκπτωση, κουπόνι) — ΟΧΙ και τα δύο
  4. Πόντοι     : αφαιρούνται τελευταίοι από το σύνολο

ΒΑΣΗ ΥΠΟΛΟΓΙΣΜΟΥ: παντού μόνο η αξία των ΜΗ-συνταγογραφούμενων ειδών («eligible»).
Τα συνταγογραφούμενα (`rx_medicine`) δεν παίρνουν ΠΟΤΕ καμία από τις παραπάνω εκπτώσεις.
"""

from __future__ import annotations

from app.services.catalog_taxonomy import discount_allowed


def eligible_cents(items: list[dict]) -> int:
    """Αξία γραμμών που ΕΠΙΤΡΕΠΟΥΝ έκπτωση (μη-συνταγογραφούμενα), μετά τις εκπτώσεις γραμμής."""
    return sum(int(it.get("line_cents") or 0) for it in items if discount_allowed(it.get("type") or ""))


def bundle_savings(items: list[dict], bundles: list[dict]) -> tuple[int, list[str]]:
    """Όφελος από πακέτα (σε cents) + ονόματα όσων εφαρμόστηκαν.

    Κάθε πακέτο εφαρμόζεται το πολύ μία «φορά ανά σετ» που χωράει στο καλάθι. Τα
    συνταγογραφούμενα αγνοούνται εντελώς (δεν μπαίνουν σε πακέτο).
    """
    by_bc = {str(it.get("barcode")): it for it in items if discount_allowed(it.get("type") or "")}
    total, applied = 0, []
    for b in bundles:
        if b.get("kind") == "nplusm":
            it = by_bc.get(str(b.get("barcode") or ""))
            if not it:
                continue
            buy, free = max(1, int(b.get("buy_qty") or 2)), max(1, int(b.get("free_qty") or 1))
            qty = int(it.get("qty") or 0)
            sets = qty // (buy + free)
            if sets <= 0:
                continue
            unit = int(it.get("line_cents") or 0) // max(1, qty)   # τιμή τεμαχίου ΜΕΤΑ τις εκπτώσεις γραμμής
            save = sets * free * unit
            if save > 0:
                total += save
                applied.append(str(b.get("name") or "Πακέτο"))
        else:                                  # combo — χρειάζονται ΟΛΑ τα είδη στις ζητούμενες ποσότητες
            lines = b.get("lines") or []
            if not lines:
                continue
            sets = None
            for ln in lines:
                it = by_bc.get(str(ln.get("barcode")))
                need = max(1, int(ln.get("qty") or 1))
                have = int((it or {}).get("qty") or 0)
                s = have // need
                sets = s if sets is None else min(sets, s)
                if not sets:
                    break
            if not sets:
                continue
            pct = max(1, min(90, int(b.get("discount_pct") or 0)))
            save = 0
            for ln in lines:
                it = by_bc[str(ln.get("barcode"))]
                need = max(1, int(ln.get("qty") or 1))
                unit = int(it.get("line_cents") or 0) // max(1, int(it.get("qty") or 1))
                save += round(unit * need * sets * pct / 100)
            if save > 0:
                total += save
                applied.append(str(b.get("name") or "Πακέτο"))
    return total, applied


def tier_discount(base_cents: int, tiers: list[dict]) -> tuple[int, int]:
    """Κλιμακωτή έκπτωση καλαθιού → (cents, pct). Παίρνει την ΥΨΗΛΟΤΕΡΗ κλίμακα που καλύπτεται."""
    pct = 0
    for t in tiers or []:
        if base_cents >= int(t.get("min_cents") or 0):
            pct = max(pct, max(0, min(90, int(t.get("pct") or 0))))
    return (round(base_cents * pct / 100), pct) if pct else (0, 0)


def coupon_discount(coupon: dict | None, base_cents: int) -> int:
    """Έκπτωση κουπονιού πάνω στην επιλέξιμη βάση (ποτέ > βάση)."""
    if not coupon or base_cents <= 0:
        return 0
    if coupon.get("kind") == "amount":
        return min(base_cents, max(0, int(coupon.get("value") or 0)))
    pct = max(0, min(90, int(coupon.get("value") or 0)))
    return round(base_cents * pct / 100)
