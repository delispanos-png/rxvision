"""Κύπρος: γραμμή εκτέλεσης ΓεΣΥ → ATC + θεραπευτική κατηγορία. ΕΝΑΣ ορισμός για Εικόνα Πελάτη,
Segments, Διατροφή, PharmaCat, Marketing.

Πηγή: ο κοινός κατάλογος Κύπρου (`cy_catalog_items`) — ATC από το ΓεΣΥ ή από ταύτιση σκευασμάτων
(services/cy/atc_match.py). Κλειδί: ο κωδικός φαρμάκου ΓεΣΥ της γραμμής (`code` = DrugCode της
PharmacyOne· η κατάληξη συσκευασίας «/2» αγνοείται) και, εναλλακτικά, το barcode.
Μέτρηση 18/11/2026 στις εκτελέσεις του fuse: 98% των γραμμών φαρμάκων ταιριάζουν μόνο με τον κωδικό.

Ο πίνακας κρατιέται στη μνήμη για λίγα λεπτά (ο κατάλογος αλλάζει το πολύ ωριαία).
"""

from __future__ import annotations

import re
import time
from typing import Any

from app.core.db import shared_db

_TTL = 600
_cache: dict[str, Any] = {"at": 0.0, "code": {}, "bc": {}}


def norm_code(v: Any) -> str:
    """«2300316/2» → «2300316» · «0001000005» → «1000005»."""
    return str(v or "").strip().split("/")[0].lstrip("0")


def norm_bc(v: Any) -> str:
    return str(v or "").strip().lstrip("0")


async def _load() -> None:
    from app.services.cy.pharmacyone import product_from_doc
    by_code: dict[str, dict] = {}
    by_bc: dict[str, dict] = {}
    async for d in shared_db()["cy_catalog_items"].find({"active": True, "raw.supergroup": "MEDICINE"},
                                                        {"raw": 1, "atc_match": 1}):
        p = product_from_doc(d)
        if not p or not p.get("atc"):
            continue
        info = {"atc": p["atc"], "cat_path": p.get("cat_path") or [], "source": p.get("atc_source"),
                "substance": substance_of(d.get("raw") or {})}
        if c := norm_code(p.get("drug_code")):
            by_code.setdefault(c, info)
        for b in p.get("barcodes") or []:
            if nb := norm_bc(b):
                by_bc.setdefault(nb, info)
    _cache.update({"at": time.monotonic(), "code": by_code, "bc": by_bc})


def substance_of(raw: dict) -> str | None:
    """Δραστική κυπριακού σκευάσματος: μητρώο Υπ. Υγείας, αλλιώς ΓεΣΥ (χωρίς την περιεκτικότητα)."""
    sub = (raw.get("moh") or {}).get("ingredient")
    if not sub:
        g = str((raw.get("gesy") or {}).get("ActiveIngedientsStrength") or "")
        sub = re.sub(r"\s+[\d.,]+\s*(MG|MCG|G|ML|IU|%|MMOL)\b.*$", "", g, flags=re.I).strip()
    # διαχωριστικά συνδυασμών στο μητρώο: , ; | + / αλλαγή γραμμής → « + »
    parts = [x.strip() for x in re.split(r"\s*[,;|+/\n]\s*", str(sub or "")) if x.strip()]
    return " + ".join(parts) or None


async def lookup() -> "AtcLookup":
    if time.monotonic() - _cache["at"] > _TTL or not _cache["code"]:
        await _load()
    return AtcLookup(_cache["code"], _cache["bc"])


def reset() -> None:
    """Για τεστ / μετά από νέα ταύτιση: ο επόμενος lookup() ξαναδιαβάζει."""
    _cache.update({"at": 0.0, "code": {}, "bc": {}})


class AtcLookup:
    def __init__(self, by_code: dict, by_bc: dict) -> None:
        self.by_code, self.by_bc = by_code, by_bc

    def for_line(self, line: dict) -> dict | None:
        """{atc, cat_path, source} για μια γραμμή εκτέλεσης ΓεΣΥ, ή None (αναλώσιμο/άγνωστο)."""
        c = norm_code(line.get("code"))
        if c and c in self.by_code:
            return self.by_code[c]
        b = norm_bc(line.get("barcode"))
        return self.by_bc.get(b) if b else None

    def atcs_of(self, dispensings: list[dict]) -> set[str]:
        out = set()
        for d in dispensings:
            for ln in d.get("lines") or []:
                if ln.get("qty_disp") and (info := self.for_line(ln)):
                    out.add(info["atc"])
        return out
