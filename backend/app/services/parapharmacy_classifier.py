"""Κατηγοριοποίηση παραφαρμάκων από το ΟΝΟΜΑ, με AI και μόνιμο καθολικό μητρώο.

ΤΟ ΠΡΟΒΛΗΜΑ (μετρημένο 23/09/2026): τα φάρμακα παίρνουν κατηγορία αυτόματα από το ATC, αλλά τα
παραφάρμακα δεν έχουν ATC — 26.990 από 28.344 (95%) δεν είχαν ΚΑΜΙΑ κατηγορία, ούτε `category`,
ούτε `cat1_id`, ούτε μάρκα, ούτε προμηθευτή. Οπότε κάθε φίλτρο κατηγορίας πάνω τους επέστρεφε
μηδέν είδη, και το «δώσε μου μόνο τα δερμοκαλλυντικά» ήταν αδύνατο να απαντηθεί.

ΤΟ ΜΗΤΡΩΟ ΕΙΝΑΙ ΚΑΘΟΛΙΚΟ, ΟΧΙ ΑΝΑ ΦΑΡΜΑΚΕΙΟ. Το «AVENE CLEANANCE GEL 200ML» είναι το ίδιο
προϊόν σε κάθε φαρμακείο — δεν υπάρχει λόγος να το ρωτήσουμε δεύτερη φορά, ούτε λόγος δύο
φαρμακεία να το βλέπουν σε διαφορετική κατηγορία. 28.349 είδη → 23.725 διακριτά ονόματα, και ο
λόγος βελτιώνεται όσο μπαίνουν φαρμακεία. Το μητρώο ΔΕΝ περιέχει δεδομένα πελάτη: μόνο
«όνομα εμπορικού προϊόντος → κατηγορία», δηλαδή δημόσια πληροφορία ραφιού.

ΜΟΝΙΜΟΣ ΜΗΧΑΝΙΣΜΟΣ: το `run()` τρέχει καθημερινά και πιάνει ό,τι νέο μπήκε. Ρωτά το AI ΜΟΝΟ για
ονόματα που δεν έχει ξαναδεί· όλα τα υπόλοιπα τα ντύνει από το μητρώο, χωρίς κλήση και χωρίς
κόστος. Γι' αυτό μπορεί να καλείται και αμέσως μετά από εισαγωγή/αντιγραφή καταλόγου.
"""

from __future__ import annotations

import html
import json
import re

from pymongo import UpdateOne

from app.core.db import shared_db
from app.services.catalog_taxonomy import PARAPHARMACY_CATEGORIES

_AI_MODEL = "claude-haiku-4-5"
_BATCH = 120                    # ονόματα ανά AI κλήση — ίδιο μέγεθος με το area_canonical
_REGISTRY = "parapharmacy_categories"

_PROMPT = (
    "Είσαι βοηθός φαρμακείου. Κατάταξε ΚΑΘΕ εμπορικό όνομα παραφαρμάκου σε ΜΙΑ από αυτές τις "
    "κατηγορίες (γράψε ΑΚΡΙΒΩΣ το κείμενο της κατηγορίας):\n"
    + "\n".join(f"- {c}" for c in PARAPHARMACY_CATEGORIES)
    + "\n\nΑν δεν είσαι σίγουρος, βάλε «Λοιπά» — ΠΟΤΕ μην εφεύρεις κατηγορία εκτός λίστας.\n"
      "Απάντησε ΜΟΝΟ με JSON object {όνομα: κατηγορία}, χωρίς σχόλια.\n\nΟΝΟΜΑΤΑ:\n"
)

_VALID = set(PARAPHARMACY_CATEGORIES)


def name_key(name: str) -> str:
    """Κλειδί μητρώου: ίδιο προϊόν γραμμένο με άλλα κενά/πεζά δεν πρέπει να ρωτηθεί δεύτερη φορά."""
    return re.sub(r"\s+", " ", (name or "").strip()).upper()


def _match_key(name: str) -> str:
    """Κλειδί ΑΝΤΙΣΤΟΙΧΙΣΗΣ της απάντησης του AI με το όνομα που στείλαμε.

    ΓΙΑΤΙ ΔΕΝ ΑΡΚΕΙ ΤΟ ΙΔΙΟ ΤΟ ΟΝΟΜΑ: αρκετά ονόματα έχουν HTML entities από την πηγή
    («APIVITA MEN&#039;SCARE»). Το μοντέλο τα «διορθώνει» στην απάντησή του σε απόστροφο, οπότε
    το κλειδί δεν ταίριαζε πια με αυτό που είχαμε στείλει και η γραμμή πεταγόταν σιωπηλά —
    μετρημένο: 971 ονόματα ρωτήθηκαν, μόνο 251 επέστρεψαν χρησιμοποιήσιμα. Εδώ κανονικοποιούμε
    ΚΑΙ ΤΙΣ ΔΥΟ πλευρές και κρατάμε μόνο γράμματα/ψηφία.
    """
    return re.sub(r"[^0-9A-Za-zΑ-Ωα-ωΆ-Ώά-ώ]+", "", html.unescape(name or "")).upper()


def _parse_json(text: str) -> dict:
    t = (text or "").strip()
    i, j = t.find("{"), t.rfind("}")
    if i == -1 or j == -1:
        return {}
    try:
        d = json.loads(t[i:j + 1])
    except (json.JSONDecodeError, ValueError):
        return {}
    # ΦΡΟΥΡΟΣ: κρατάμε ΜΟΝΟ κατηγορίες της λίστας. Χωρίς αυτό, μια εφευρεμένη κατηγορία θα
    # έμπαινε στη βάση και θα εμφανιζόταν ως έγκυρο φίλτρο που δεν επιλέγει τίποτα.
    return {str(k): str(v).strip() for k, v in d.items() if str(v).strip() in _VALID}


async def _ask_ai(names: list[str]) -> dict:
    """{όνομα → κατηγορία} σε batches. Άδειο dict αν δεν υπάρχει ρυθμισμένο AI."""
    from app.services import ai_cost, pharmacat_service
    c = await pharmacat_service._config()
    if not c.get("api_key"):
        return {}
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    out: dict = {}
    for start in range(0, len(names), _BATCH):
        batch = names[start:start + _BATCH]
        try:
            resp = await client.messages.create(
                model=_AI_MODEL, max_tokens=8000,
                messages=[{"role": "user",
                           "content": _PROMPT + json.dumps(batch, ensure_ascii=False)}])
            await ai_cost.record("__parapharmacy_cat__", _AI_MODEL, getattr(resp, "usage", None))
            got = _parse_json("".join(b.text for b in resp.content if b.type == "text"))
            # Αντιστοίχισε την απάντηση στα ΟΝΟΜΑΤΑ ΠΟΥ ΣΤΕΙΛΑΜΕ, όχι σε ό,τι επέστρεψε το
            # μοντέλο — αλλιώς κάθε μικροδιαφορά γραφής χάνει τη γραμμή.
            wanted = {_match_key(n): n for n in batch}
            for k, v in got.items():
                mk = _match_key(k)
                orig = wanted.get(mk)
                if not orig and len(mk) >= 12:
                    # ΤΟ ΜΟΝΤΕΛΟ ΣΥΜΠΛΗΡΩΝΕΙ ΚΟΜΜΕΝΑ ΟΝΟΜΑΤΑ. Πολλά ονόματα είναι κομμένα στη
                    # βάση («…50ML(ΚΑΡΔΑ») και το μοντέλο αναγνωρίζει το προϊόν και επιστρέφει
                    # το πλήρες («…50ML(ΚΑΡΔΑΜΟ+ΠΡΟΠΟΛΗ)»). Κανένα ταίριασμα ακριβείας δεν
                    # πετυχαίνει· ταιριάζουμε με πρόθεμα, ΜΟΝΟ αν η αντιστοίχιση είναι μοναδική
                    # — αλλιώς θα βάζαμε κατηγορία σε λάθος προϊόν.
                    cands = [w for w in wanted if len(w) >= 12
                             and (mk.startswith(w) or w.startswith(mk))]
                    if len(cands) == 1:
                        orig = wanted[cands[0]]
                if orig:
                    out[orig] = v
        except Exception:  # noqa: BLE001 — μια κακή παρτίδα δεν ρίχνει όλο το πέρασμα
            continue
    return out


async def _tenant_ids() -> list[str]:
    db = shared_db()
    return [t["_id"] async for t in db["tenants"].find({}, {"_id": 1})]


async def _pending_by_tenant() -> dict[str, list[str]]:
    """{tenant_id → ονόματα παραφαρμάκων χωρίς κατηγορία}.

    Περνά ΠΑΝΤΑ από το PharmacyCatalogRepository ώστε το φίλτρο tenant να μπαίνει από την
    υποδομή και όχι από το χέρι μου — ένα ξεχασμένο tenant_id εδώ θα έγραφε κατηγορίες στα
    είδη άλλου φαρμακείου.
    """
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    out: dict[str, list[str]] = {}
    for tid in await _tenant_ids():
        rows = await PharmacyCatalogRepository(tenant_id=tid).aggregate([
            {"$match": {"type": "parapharmacy", "category": {"$in": [None, ""]},
                        "name": {"$nin": [None, ""]}}},
            {"$group": {"_id": "$name"}},
        ])
        names = [r["_id"] for r in rows if r.get("_id")]
        if names:
            out[tid] = names
    return out


async def run(*, max_new: int | None = None, dry_run: bool = False) -> dict:
    """Δώσε κατηγορία σε κάθε παραφάρμακο που δεν έχει.

    `max_new` = ανώτατο πλήθος ΑΓΝΩΣΤΩΝ ονομάτων που θα σταλούν στο AI σε αυτό το πέρασμα
    (φρένο κόστους). Τα γνωστά ονόματα ντύνονται πάντα, δωρεάν.
    """
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
    db = shared_db()
    pending = await _pending_by_tenant()
    if not pending:
        return {"ok": True, "pending": 0, "asked_ai": 0, "updated": 0}

    keys = {name_key(n) for names in pending.values() for n in names}
    known = {d["_id"]: d["category"] async for d in
             db[_REGISTRY].find({"_id": {"$in": list(keys)}}, {"category": 1})}
    unknown = sorted(keys - set(known))
    if max_new is not None:
        unknown = unknown[:max_new]

    asked = 0
    if unknown and not dry_run:
        fresh = await _ask_ai(unknown)
        asked = len(fresh)
        if fresh:
            await db[_REGISTRY].bulk_write([
                UpdateOne(
                    {"_id": name_key(n)},
                    {"$set": {"category": c, "source": "ai", "model": _AI_MODEL}},
                    upsert=True)
                for n, c in fresh.items()], ordered=False)
            known.update({name_key(n): c for n, c in fresh.items()})

    updated = 0
    if not dry_run:
        for tid, names in pending.items():
            by_cat: dict[str, list[str]] = {}
            for n in names:
                cat = known.get(name_key(n))
                if cat:
                    by_cat.setdefault(cat, []).append(n)
            repo = PharmacyCatalogRepository(tenant_id=tid)
            for cat, group in by_cat.items():
                for i in range(0, len(group), 500):
                    res = await repo.update_many(
                        {"type": "parapharmacy", "category": {"$in": [None, ""]},
                         "name": {"$in": group[i:i + 500]}},
                        {"$set": {"category": cat, "category_source": "ai"}})
                    updated += res.modified_count
    return {"ok": True, "pending": len(keys), "known": len(known), "asked_ai": asked,
            "updated": updated, "dry_run": dry_run}
