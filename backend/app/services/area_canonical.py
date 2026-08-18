"""Κανονικοποίηση περιοχής κατοικίας (residence_area).

Οι πηγές (ΗΔΥΚΑ/GESY) δίνουν ΕΛΕΥΘΕΡΟ κείμενο → μία περιοχή εμφανίζεται σε δεκάδες παραλλαγές
(συντομογραφίες «ΑΓ.», πτώσεις «ΑΓΙΟΥ ΔΗΜΗΤΡΙΟΥ», τυπογραφικά «ΔΗΜΗΤΡΙΙΟΥ», προσθήκες «ΑΤΤΙΚΗΣ»).
Λύση: μηχανική προ-κανονικοποίηση (κλειδί) + AI batch (μία φορά) → καθολικός χάρτης `area_aliases`
{key → επίσημος δήμος} → πεδίο `residence_area_canonical` στους ασθενείς. Αυτο-συντηρείται: νέες
άγνωστες τιμές παίρνουν προσωρινό μηχανικό fallback & τις μαζεύει ο εβδομαδιαίος βρόχος `refresh()`.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from app.core.db import shared_db

_ALIASES = "area_aliases"
_AI_MODEL = "claude-haiku-4-5"          # φθηνό & αρκετό για κανονικοποίηση ονομάτων
_BATCH = 120                            # τιμές ανά AI κλήση

# αφαίρεση τόνων/διαλυτικών (κεφαλαία)
_ACCENTS = str.maketrans("ΆΈΉΊΌΎΏΪΫ", "ΑΕΗΙΟΥΩΙΥ")


def mechanical_key(raw: str | None) -> str:
    """Ντετερμινιστικό κλειδί: κεφαλαία, χωρίς τόνους, στίξη→κενό, σύμπτυξη κενών. Ενώνει τις
    καθαρά μορφολογικές παραλλαγές («ΑΓ. ΔΗΜΗΤΡΙΟΣ»=«ΑΓ.ΔΗΜΗΤΡΙΟΣ»=«ΑΓ  ΔΗΜΗΤΡΙΟΣ»). Τις
    σημασιολογικές (πτώσεις/τυπογραφικά) τις ενώνει το AI."""
    s = (raw or "").strip().upper().translate(_ACCENTS)
    s = re.sub(r"[.\-,_/\\'`]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _pretty(key: str) -> str:
    """Ευανάγνωστο προσωρινό fallback (Title Case) μέχρι να το κανονικοποιήσει το AI."""
    return key.title() if key else ""


async def get_alias_map() -> dict:
    """{mechanical_key → canonical} — ο τρέχων χάρτης (καθολικός, τα τοπωνύμια είναι κοινά)."""
    return {d["_id"]: d.get("canonical")
            async for d in shared_db()[_ALIASES].find({}, {"canonical": 1})}


def canonical_for(raw: str | None, amap: dict) -> str | None:
    """Canonical περιοχή για μια raw τιμή, βάσει χάρτη· fallback = ευανάγνωστο μηχανικό κλειδί."""
    k = mechanical_key(raw)
    if not k:
        return None
    return amap.get(k) or _pretty(k)


# ── AI batch mapping ────────────────────────────────────────────────────────────────────────
_PROMPT = (
    "Κανονικοποίησε ελληνικά τοπωνύμια κατοικίας για φαρμακείο. Κάθε είσοδος είναι ΩΜΟ κείμενο "
    "περιοχής (κεφαλαία, με πιθανές συντομογραφίες, πτώσεις, τυπογραφικά λάθη ή προσθήκες όπως "
    "«ΑΤΤΙΚΗΣ» ή όνομα γειτονιάς). Για ΚΑΘΕ είσοδο επίστρεψε τον ΕΠΙΣΗΜΟ ΔΗΜΟ στην ονομαστική, "
    "σε πεζά-με-κεφαλαίο-αρχικό (π.χ. «Άγιος Δημήτριος», «Νέα Σμύρνη», «Παλαιό Φάληρο», «Άλιμος», "
    "«Καλλιθέα»). Αν είναι γειτονιά (π.χ. «Μπραχάμι»), επίστρεψε τον δήμο της. Αν δεν αναγνωρίζεται "
    "ή είναι κενό, επίστρεψε το ίδιο καθαρισμένο σε Title Case. Επίστρεψε ΜΟΝΟ ένα JSON object που "
    "αντιστοιχεί ΑΚΡΙΒΩΣ κάθε είσοδο στο canonical της. Είσοδοι:\n"
)


def _parse_json(text: str) -> dict:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    i, j = t.find("{"), t.rfind("}")
    if i == -1 or j == -1:
        return {}
    try:
        d = json.loads(t[i:j + 1])
        return {str(k): str(v).strip() for k, v in d.items() if str(v).strip()}
    except (json.JSONDecodeError, ValueError):
        return {}


async def ai_map_keys(keys: list[str]) -> dict:
    """AI αντιστοίχιση {key → canonical δήμος} σε batches. Άδειο dict αν το AI δεν είναι ρυθμισμένο."""
    from app.services import pharmacat_service
    c = await pharmacat_service._config()
    if not c.get("api_key"):
        return {}
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    out: dict = {}
    for start in range(0, len(keys), _BATCH):
        batch = keys[start:start + _BATCH]
        try:
            resp = await client.messages.create(
                model=_AI_MODEL, max_tokens=8000,
                messages=[{"role": "user", "content": _PROMPT + json.dumps(batch, ensure_ascii=False)}])
            from app.services import ai_cost
            await ai_cost.record("__area_canonical__", _AI_MODEL, getattr(resp, "usage", None))
            text = "".join(b.text for b in resp.content if b.type == "text")
            out.update(_parse_json(text))
        except Exception:  # noqa: BLE001 — μια αποτυχία batch δεν ρίχνει όλο το πέρασμα
            continue
    return out


async def _upsert_aliases(mapping: dict, source: str) -> None:
    now = datetime.now(tz=timezone.utc)
    db = shared_db()
    for key, canon in mapping.items():
        # ΜΗΝ πατάς χειροκίνητη υπερίσχυση (locked)
        await db[_ALIASES].update_one(
            {"_id": key, "locked": {"$ne": True}},
            {"$set": {"canonical": canon, "source": source, "updated_at": now}},
            upsert=True)


async def _apply_to_patients(raws: list[str], amap: dict, tenant_id: str | None = None) -> int:
    """Γράψε residence_area_canonical σε όλους τους ασθενείς ανά raw τιμή (update_many/τιμή)."""
    db = shared_db()
    updated = 0
    for raw in raws:
        canon = canonical_for(raw, amap)
        if not canon:
            continue
        q: dict = {"residence_area": raw}
        if tenant_id:
            q["tenant_id"] = tenant_id
        r = await db["patients_anonymized"].update_many(q, {"$set": {"residence_area_canonical": canon}})
        updated += r.modified_count
    return updated


async def backfill(*, tenant_id: str | None = None, use_ai: bool = True) -> dict:
    """Πλήρες backfill: distinct raw περιοχές → AI map (όσες λείπουν) → residence_area_canonical παντού."""
    db = shared_db()
    match: dict = {"residence_area": {"$nin": [None, ""]}}
    if tenant_id:
        match["tenant_id"] = tenant_id
    raws = [r for r in await db["patients_anonymized"].distinct("residence_area", match) if r]
    keys = sorted({mechanical_key(r) for r in raws if mechanical_key(r)})
    amap = await get_alias_map()
    missing = [k for k in keys if k not in amap]
    ai_mapped: dict = {}
    if missing and use_ai:
        ai_mapped = await ai_map_keys(missing)
        await _upsert_aliases(ai_mapped, "ai")
        # όσα δεν γύρισε το AI → προσωρινό fallback (pending) ώστε να τα ξαναπιάσει ο βρόχος
        pending = {k: _pretty(k) for k in missing if k not in ai_mapped}
        if pending:
            await _upsert_aliases(pending, "pending")
        amap = await get_alias_map()
    updated = await _apply_to_patients(raws, amap, tenant_id)
    return {"raw_values": len(raws), "keys": len(keys), "ai_mapped": len(ai_mapped),
            "patients_updated": updated}


async def refresh(*, max_new_keys: int = 800) -> dict:
    """Αυτο-συντηρούμενος βρόχος (εβδομαδιαίος): κανονικοποίησε ΜΟΝΟ νέους/pending — ασθενείς χωρίς
    canonical + κλειδιά με source 'pending'. Φθηνό: πιάνει μόνο ό,τι νέο εμφανίστηκε."""
    db = shared_db()
    missing_raws = [r for r in await db["patients_anonymized"].distinct(
        "residence_area", {"residence_area": {"$nin": [None, ""]},
                           "residence_area_canonical": {"$in": [None, ""]}}) if r]
    pending_keys = [d["_id"] async for d in db[_ALIASES].find({"source": "pending"}, {"_id": 1})]
    keys_needed = {mechanical_key(r) for r in missing_raws} | set(pending_keys)
    keys_needed = {k for k in keys_needed if k}
    amap = await get_alias_map()
    # όσα κλειδιά δεν έχουν ακόμη σωστή (ai/manual) αντιστοίχιση
    resolved = {d["_id"] async for d in db[_ALIASES].find(
        {"source": {"$in": ["ai", "manual"]}}, {"_id": 1})}
    to_ai = [k for k in keys_needed if k not in resolved][:max_new_keys]
    ai_mapped: dict = {}
    if to_ai:
        ai_mapped = await ai_map_keys(to_ai)
        await _upsert_aliases(ai_mapped, "ai")
        pending = {k: _pretty(k) for k in to_ai if k not in ai_mapped}
        if pending:
            await _upsert_aliases(pending, "pending")
        amap = await get_alias_map()
    updated = await _apply_to_patients(missing_raws, amap) if missing_raws else 0
    return {"new_keys": len(to_ai), "ai_mapped": len(ai_mapped), "patients_updated": updated}


async def set_override(raw_or_key: str, canonical: str) -> dict:
    """Χειροκίνητη υπερίσχυση: κλείδωσε μια αντιστοίχιση (AI δεν την ξαναγγίζει) & εφάρμοσέ την."""
    key = mechanical_key(raw_or_key)
    if not key or not (canonical or "").strip():
        return {"ok": False, "error": "bad_input"}
    now = datetime.now(tz=timezone.utc)
    await shared_db()[_ALIASES].update_one(
        {"_id": key}, {"$set": {"canonical": canonical.strip(), "source": "manual",
                                "locked": True, "updated_at": now}}, upsert=True)
    # εφάρμοσε σε όλους τους ασθενείς με raw που δίνει αυτό το κλειδί
    db = shared_db()
    raws = [r for r in await db["patients_anonymized"].distinct("residence_area", {}) if mechanical_key(r) == key]
    updated = await _apply_to_patients(raws, {key: canonical.strip()})
    return {"ok": True, "key": key, "canonical": canonical.strip(), "patients_updated": updated}
