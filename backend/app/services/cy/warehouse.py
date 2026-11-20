"""Κύπρος: γραμμή εκτέλεσης ΓεΣΥ → είδος της Αποθήκης (`pharmacy_products`). ΕΝΑΣ ορισμός για Πρόταση
παραγγελίας, Κερδοφορία, Προχορηγήσεις.

ΓΙΑΤΙ ΧΡΕΙΑΖΕΤΑΙ (18/11/2026): το XML ΓεΣΥ γράφει το barcode ΜΕ αρχικό 0 (GTIN-14, «03582910071631»), ενώ
η Αποθήκη το κρατά ΧΩΡΙΣ («3582910071631» — τα υπόλοιπα στο `barcodes`)· ο κωδικός φαρμάκου ΓεΣΥ
(«2100081/1») ζει στο `drug_code` ΜΕ την κατάληξη συσκευασίας. Το απλό `barcode == barcode` δεν έβρισκε
σχεδόν τίποτα: απόθεμα «άγνωστο» και κερδοφορία χωρίς κάλυψη, ενώ το είδος ήταν στην Αποθήκη.
Ταιριάζουμε σε ΚΑΝΟΝΙΚΟΠΟΙΗΜΕΝΗ μορφή (χωρίς αρχικά 0 · κωδικός χωρίς «/N»).
"""

from __future__ import annotations

from typing import Any

from app.core.db import shared_db
from app.services.cy.atc_link import norm_bc, norm_code


def _exact(code: Any) -> str:
    """«02100081/1» → «2100081/1» — ΙΔΙΑ συσκευασία (η κατάληξη /N ΕΙΝΑΙ το μέγεθος συσκευασίας)."""
    c = str(code or "").strip()
    base, _, pack = c.partition("/")
    return f"{base.lstrip('0')}/{pack}" if pack else base.lstrip("0")


class WarehouseLookup:
    def __init__(self, by_bc: dict, by_exact: dict, by_base: dict) -> None:
        self.by_bc, self.by_exact, self.by_base = by_bc, by_exact, by_base

    def get(self, barcode: Any = None, code: Any = None) -> dict | None:
        """1) ο ΑΚΡΙΒΗΣ κωδικός ΓεΣΥ (με τη συσκευασία) · 2) το barcode · 3) η βάση του κωδικού ΜΟΝΟ αν
        υπάρχει ΜΙΑ συσκευασία. ⚠ «3900185/1» = 10 δισκία, «3900185/7» = 100: για τιμή/απόθεμα η
        συσκευασία μετράει (18/11/2026: χονδρική 100άρας σε 10άρα → «ζημιά» −181 € σε ένα είδος)."""
        if code and _exact(code) in self.by_exact:
            return self.by_exact[_exact(code)]
        if barcode:
            p = self.by_bc.get(norm_bc(barcode))
            if p:
                return p
        if code:
            packs = self.by_base.get(norm_code(code)) or []
            if len(packs) == 1:
                return packs[0]
        return None


async def lookup(tenant_id: str, lines: list[dict], *, fields: tuple = ()) -> WarehouseLookup:
    """`lines`: [{barcode, code}] (γραμμές ΓεΣΥ ή αντίστοιχα). Ένα ερώτημα για όλες."""
    bcs = {str(x.get("barcode")).strip() for x in lines if x.get("barcode")}
    codes = {str(x.get("code")).strip() for x in lines if x.get("code")}
    variants = set()
    for b in bcs:
        s = b.lstrip("0")
        variants |= {b, s, "0" + s}
    norm_codes = {norm_code(c) for c in codes} - {""}
    proj = {"barcode": 1, "barcodes": 1, "drug_code": 1, **{f: 1 for f in fields}}
    ors: list[dict] = []
    if variants:
        ors += [{"barcode": {"$in": sorted(variants)}}, {"barcodes": {"$in": sorted(variants)}}]
    if codes:
        # ίδιος κωδικός ΓεΣΥ, οποιαδήποτε συσκευασία: η βάση + «/1»…«/40» (μετρημένο: δεν υπάρχουν
        # αρχικά μηδενικά· οι καταλήξεις φτάνουν σε μονοψήφια/διψήφια) — $in, όχι regex, για ταχύτητα
        cand = sorted({c for n in norm_codes for c in [n, *(f"{n}/{i}" for i in range(1, 41))]} | codes)
        ors += [{"drug_code": {"$in": cand}}, {"barcodes": {"$in": cand}}]
    by_bc: dict = {}
    by_exact: dict = {}
    by_base: dict = {}
    if ors:
        async for p in shared_db()["pharmacy_products"].find(   # tenant-ok: tenant_id στο φίλτρο
                {"tenant_id": tenant_id, "$or": ors}, proj):
            for b in [p.get("barcode"), *(p.get("barcodes") or [])]:
                if b and "/" not in str(b):
                    by_bc.setdefault(norm_bc(b), p)
            seen_base = set()
            for c in [p.get("drug_code"), *[x for x in (p.get("barcodes") or []) if x and "/" in str(x)]]:
                if c and norm_code(c) in norm_codes:
                    by_exact.setdefault(_exact(c), p)
                    if norm_code(c) not in seen_base:          # μία φορά ανά είδος
                        seen_base.add(norm_code(c))
                        by_base.setdefault(norm_code(c), []).append(p)
    return WarehouseLookup(by_bc, by_exact, by_base)
