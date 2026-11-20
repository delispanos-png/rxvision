"""Κύπρος: ATC για τα φάρμακα του καταλόγου PharmacyOne που ΔΕΝ τον έχουν από το ΓεΣΥ.

Το ΓεΣΥ δίνει ATC μόνο για ~2.200 από τα ~7.900 φάρμακα. Τα υπόλοιπα τα ταυτίζουμε με ΣΚΕΥΑΣΜΑΤΑ —
ποτέ με δεδομένα ασθενών ή φαρμακείων. Πηγές γνώσης: ο ίδιος ο κυπριακός κατάλογος και ο ΔΗΜΟΣΙΟΣ
ελληνικός κατάλογος φαρμάκων (`medicine_catalog`: όνομα, δραστική, ATC, barcode).

Σειρά (από το πιο σίγουρο):
  1. `gesy`        — ATC από το ΓεΣΥ (καμία ταύτιση).
  2. `gr_barcode`  — ίδιο barcode με ελληνικό σκεύασμα.
  3. `cy_substance`— ίδια δραστική (μητρώο Υπ. Υγείας) με κυπριακό φάρμακο που έχει ATC από το ΓεΣΥ.
  4. `gr_substance`— ίδια δραστική στον ελληνικό κατάλογο.
  5. `name_substance` — το όνομα περιέχει γνωστή δραστική (π.χ. «PYRIDOSTIGMINE (MESTINON)»).
  6. `gr_brand`    — η μάρκα (πρώτη λέξη) υπάρχει στον ελληνικό κατάλογο.
Κανόνας: αν μια πηγή δίνει ΠΕΡΙΣΣΟΤΕΡΟΥΣ από έναν ATC, ΔΕΝ μαντεύουμε — προχωράμε στην επόμενη ή
αφήνουμε το φάρμακο χωρίς ATC. Κάθε ταύτιση κρατά την πηγή της (`atc_match.source`).

Θεραπευτική κατηγορία: με την ΟΝΟΜΑΣΙΑ της PharmacyOne (atc_layers άλλου κυπριακού φαρμάκου με τον ίδιο
ATC), ώστε το δέντρο κατηγοριών να μένει ενιαίο· αλλιώς η ελληνική ταξινόμηση (catalog_taxonomy).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone

from app.core.db import shared_db

ITEMS = "cy_catalog_items"
_WORD = re.compile(r"[A-Z][A-Z\-]{3,}")
# λέξεις που δεν είναι μάρκα/δραστική (μορφές, συσκευασίες, προθέματα του ΓεΣΥ)
_STOP = {"GESY", "TABLET", "TABLETS", "TABS", "CAPSULE", "CAPSULES", "CAPS", "FILM", "COATED", "PACK", "WITH",
         "BLISTER", "BOTTLE", "SOLUTION", "ORAL", "SUSPENSION", "INJECTION", "CREAM", "OINTMENT", "SYRUP",
         "SACHETS", "SACHET", "POWDER", "DROPS", "SPRAY", "MODIFIED", "RELEASE", "PROLONGED", "GASTRO",
         "RESISTANT", "HARD", "SOFT", "VIAL", "VIALS", "AMPOULE", "AMPOULES", "PREFILLED", "SYRINGE", "PEN",
         "INFUSION", "CONCENTRATE", "EFFERVESCENT", "CHEWABLE", "DISPERSIBLE", "ORODISPERSIBLE", "TUBE",
         "INHALER", "INHALATION", "NASAL", "EYE", "EAR", "GEL", "PATCH", "PATCHES", "UNIT", "DOSE", "PLUS",
         "FORTE", "RETARD", "MITE", "JUNIOR", "BABY", "CHILD", "ADULT", "SUGAR", "FREE", "AND"}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def norm_substance(s: str | None) -> str:
    """«SALICYLIC ACID,CAMPHOR» = «camphor + salicylic acid»: κεφαλαία, ταξινομημένα συστατικά."""
    # διαχωριστικά που είδαμε στο μητρώο: , + / ; | αλλαγή γραμμής, «AND»
    parts = re.split(r"\s*[,+/;|\n]\s*|\s+AND\s+", str(s or "").upper())
    return "+".join(sorted(p.strip() for p in parts if p.strip()))


def _gesy_atc(raw: dict) -> str | None:
    a = str((raw.get("gesy") or {}).get("ATC") or "").strip().upper().split("-")[0]
    return a if re.fullmatch(r"[A-Z]\d{2}[A-Z0-9]{0,4}", a) else None


def _layers_path(layers: dict | None) -> list[str]:
    out = []
    for i in (1, 2, 3):
        c = str((layers or {}).get(f"atc_category{i}") or "").strip()
        if not c:
            break
        out.append(c[:80])
    return out


async def build_index(db=None) -> dict:
    """Οι πίνακες γνώσης (ΜΟΝΟ σκευάσματα). Επιστρέφει dict από χάρτες → σύνολα ATC."""
    db = db if db is not None else shared_db()   # ΟΧΙ `db or`: η pymongo Database δεν δέχεται bool()
    gr_bc: dict[str, set] = defaultdict(set)
    gr_sub: dict[str, set] = defaultdict(set)
    gr_brand: dict[str, set] = defaultdict(set)
    async for g in db["medicine_catalog"].find({"atc": {"$nin": [None, ""]}},
                                               {"barcode": 1, "substance_name": 1, "atc": 1, "name": 1}):
        atc = str(g["atc"]).strip().upper()
        if g.get("barcode"):
            gr_bc[str(g["barcode"]).lstrip("0")].add(atc)
        if g.get("substance_name"):
            gr_sub[norm_substance(g["substance_name"])].add(atc)
        first = (_WORD.findall(str(g.get("name") or "").upper()) or [None])[0]
        if first and first not in _STOP:
            gr_brand[first].add(atc)
    cy_sub: dict[str, set] = defaultdict(set)
    layers_by_atc: dict[str, dict] = {}
    async for x in db[ITEMS].find({"raw.gesy.ATC": {"$nin": [None, ""]}},
                                  {"raw.gesy.ATC": 1, "raw.moh.ingredient": 1, "raw.atc_layers": 1}):
        raw = x.get("raw") or {}
        atc = _gesy_atc(raw)
        if not atc:
            continue
        ing = norm_substance((raw.get("moh") or {}).get("ingredient"))
        if ing:
            cy_sub[ing].add(atc)
        if raw.get("atc_layers"):
            for n in (7, 5, 4, 3):          # ο πιο ειδικός πρώτα
                layers_by_atc.setdefault(atc[:n], raw["atc_layers"])
    # δραστικές για αναζήτηση μέσα στο όνομα: μόνο ΜΟΝΕΣ (όχι συνδυασμοί), ≥6 γράμματα, μοναδικός ATC
    single = {s: a for s, a in {**gr_sub, **cy_sub}.items() if "+" not in s and len(s) >= 6}
    return {"gr_bc": gr_bc, "gr_sub": gr_sub, "gr_brand": gr_brand, "cy_sub": cy_sub,
            "single": single, "layers": layers_by_atc}


def _one(atcs) -> str | None:
    """ΕΝΑΣ ATC ή κανένας. Αν διαφέρουν μόνο στο βάθος (π.χ. C09AA, C09AA05) κρατάμε τον κοινό πρόγονο ≥5."""
    atcs = {a for a in (atcs or ()) if a}
    if len(atcs) == 1:
        return next(iter(atcs))
    if len(atcs) > 1:
        common = min(atcs, key=len)
        while common and not all(a.startswith(common) for a in atcs):
            common = common[:-1]
        if len(common) >= 5:
            return common
    return None


def match(raw: dict, idx: dict) -> tuple[str, str] | None:
    """(ATC, πηγή) για ένα φάρμακο χωρίς ATC από το ΓεΣΥ, ή None."""
    for b in raw.get("barcodes") or []:
        if a := _one(idx["gr_bc"].get(str(b).lstrip("0"))):
            return a, "gr_barcode"
    ing = norm_substance((raw.get("moh") or {}).get("ingredient"))
    if ing:
        if a := _one(idx["cy_sub"].get(ing)):
            return a, "cy_substance"
        if a := _one(idx["gr_sub"].get(ing)):
            return a, "gr_substance"
    name = str(raw.get("name") or "").upper()
    # η ΜΑΚΡΥΤΕΡΗ δραστική που εμφανίζεται ολόκληρη στο όνομα (ως λέξη/φράση)
    hits = [s for s in idx["single"]
            if s in name and re.search(rf"(?<![A-Z]){re.escape(s)}(?![A-Z])", name)]   # γρήγορο φίλτρο πρώτα
    # κράτα μόνο τις «πλήρεις» δραστικές (όχι όσες είναι κομμάτι άλλης που βρέθηκε)
    hits = sorted({h for h in hits if not any(h != o and h in o for o in hits)})
    if len(hits) == 1:
        if a := _one(idx["single"][hits[0]]):
            return a, "name_substance"
    elif len(hits) > 1:
        # ΣΥΝΔΥΑΣΜΟΣ (π.χ. AMLODIPINE/VALSARTAN/HYDROCHLOROTHIAZIDE): ΠΟΤΕ ο ATC μίας μόνο ουσίας — ψάχνουμε
        # τον συνδυασμό· αλλιώς τίποτα (18/11/2026: είχε δοθεί C03AA03, μόνο το διουρητικό).
        combo = "+".join(hits)
        if a := _one(idx["cy_sub"].get(combo) or idx["gr_sub"].get(combo)):
            return a, "name_substance"
        return None
    words = [w for w in _WORD.findall(name) if w not in _STOP]
    if words:
        if a := _one(idx["gr_brand"].get(words[0])):
            return a, "gr_brand"
    return None


def category_path(atc: str, idx: dict) -> list[str]:
    for n in (7, 5, 4, 3):
        if atc[:n] in idx["layers"]:
            return _layers_path(idx["layers"][atc[:n]])
    from app.services.catalog_taxonomy import medicine_category
    return [medicine_category(atc)]


async def run(db=None) -> dict:
    """Ταυτοποίηση ΟΛΩΝ των φαρμάκων χωρίς ATC από το ΓεΣΥ. Γράφει ΜΟΝΟ όπου άλλαξε κάτι, και τότε
    ανανεώνει το `changed_at` ώστε η νυχτερινή ενημέρωση να το περάσει στις αποθήκες."""
    db = db if db is not None else shared_db()   # ΟΧΙ `db or`: η pymongo Database δεν δέχεται bool()
    idx = await build_index(db)
    stats: dict[str, int] = defaultdict(int)
    now = _now()
    async for d in db[ITEMS].find({"active": True, "raw.supergroup": "MEDICINE"},
                                  {"raw": 1, "atc_match": 1}):
        raw = d.get("raw") or {}
        if _gesy_atc(raw):
            stats["gesy"] += 1
            continue
        m = match(raw, idx)
        new = ({"atc": m[0], "source": m[1], "cat_path": category_path(m[0], idx)} if m else None)
        stats[m[1] if m else "unmatched"] += 1
        old = d.get("atc_match")
        if (old or None) != new:
            await db[ITEMS].update_one({"_id": d["_id"]}, {"$set": {"atc_match": new, "changed_at": now}})
            stats["written"] += 1
    if stats.get("written"):
        from app.services.cy import atc_link
        atc_link.reset()   # οι επόμενες αναζητήσεις βλέπουν αμέσως τους νέους ATC
    res = {"ok": True, "at": now, **dict(stats)}
    await db["platform_settings"].update_one({"_id": "cy"}, {"$set": {"atc_match": res}}, upsert=True)
    return res
