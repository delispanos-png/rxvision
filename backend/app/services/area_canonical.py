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


# ── Ενοποίηση ΕΞΟΔΟΥ (canonical) ────────────────────────────────────────────────────────────
# Το mechanical_key ενώνει τις ΕΙΣΟΔΟΥΣ. Το AI όμως μπορεί να γυρίσει για δύο διαφορετικά κλειδιά
# την ίδια περιοχή με ΔΙΑΦΟΡΕΤΙΚΟ τονισμό/ορθογραφία («Άλιμος» vs «Αλιμός») → δύο γραμμές στη λίστα.
# Γι' αυτό ενοποιούμε και τα canonical: ομαδοποίηση με άτονο κλειδί, ΕΝΑΣ εκπρόσωπος ανά ομάδα.
_TONED = set("άέήίόύώΆΈΉΊΌΎΏϊϋΐΰ")


def canonical_key(canon: str | None) -> str:
    """Άτονο κλειδί ομάδας για ΕΞΟΔΟ (canonical) — «Άλιμος» και «Αλιμός» δίνουν το ίδιο."""
    return mechanical_key(canon)


def _has_tone(s: str) -> bool:
    return any(ch in _TONED for ch in (s or ""))


def pick_representative(variants: dict[str, int], locked: set[str] | None = None) -> str:
    """Ένας εκπρόσωπος ανά ομάδα. Σειρά προτεραιότητας:
    1) χειροκίνητα κλειδωμένη γραφή (ποτέ δεν την πατάμε)
    2) γραφή ΜΕ τόνο (ελληνικό τοπωνύμιο >1 συλλαβής χωρίς τόνο = σχεδόν πάντα λάθος)
    3) η συχνότερη · 4) αλφαβητικά (ντετερμινισμός)"""
    if locked:
        for v in sorted(variants):
            if v in locked:
                return v
    toned = {v: n for v, n in variants.items() if _has_tone(v)}
    pool = toned or variants
    return sorted(pool.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


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


async def _align_to_existing(mapping: dict) -> dict:
    """Ευθυγράμμισε τα ΝΕΑ canonical με ό,τι ήδη χρησιμοποιείται για την ίδια περιοχή, ώστε να μη
    δημιουργείται δεύτερη γραμμή με άλλον τονισμό. Οι locked (manual) γραφές πάντα υπερισχύουν."""
    if not mapping:
        return mapping
    db = shared_db()
    groups: dict[str, dict[str, int]] = {}
    locked: set[str] = set()
    async for d in db[_ALIASES].find({}, {"canonical": 1, "locked": 1}):
        c = (d.get("canonical") or "").strip()
        if not c:
            continue
        groups.setdefault(canonical_key(c), {})[c] = groups.get(canonical_key(c), {}).get(c, 0) + 1
        if d.get("locked"):
            locked.add(c)
    for canon in mapping.values():
        c = (canon or "").strip()
        if c:
            groups.setdefault(canonical_key(c), {}).setdefault(c, 0)
    reps = {gk: pick_representative(v, locked) for gk, v in groups.items() if v}
    return {k: reps.get(canonical_key(c), c) for k, c in mapping.items()}


async def _upsert_aliases(mapping: dict, source: str) -> None:
    mapping = await _align_to_existing(mapping)
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


async def refresh(*, max_new_keys: int = 5000) -> dict:
    """Αυτο-συντηρούμενος βρόχος (εβδομαδιαίος): κανονικοποίησε ΜΟΝΟ νέους/pending — ασθενείς χωρίς
    canonical + κλειδιά με source 'pending'. Φθηνό: πιάνει μόνο ό,τι νέο εμφανίστηκε."""
    db = shared_db()
    # tenant-ok: το λεξικό περιοχών είναι ΚΑΘΟΛΙΚΟ (μία περιοχή = μία γραμμή για όλη την πλατφόρμα)·
    # η κανονικοποίηση εφαρμόζεται σε όλους τους πελάτες σκόπιμα — δεν διαβάζεται/εκτίθεται PII.
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
    unified = await unify_existing()   # ποτέ δύο γραφές για την ίδια περιοχή
    return {"new_keys": len(to_ai), "ai_mapped": len(ai_mapped), "patients_updated": updated,
            "unified": unified}


async def unify_existing() -> dict:
    """Συγχώνευσε ΥΠΑΡΧΟΥΣΕΣ διπλές γραφές της ίδιας περιοχής («Άλιμος»/«Αλιμός») σε μία. Τρέχει
    και στον εβδομαδιαίο βρόχο, ώστε το πρόβλημα να μην ξαναεμφανιστεί σιωπηλά."""
    db = shared_db()
    groups: dict[str, dict[str, int]] = {}
    locked: set[str] = set()
    async for d in db[_ALIASES].find({}, {"canonical": 1, "locked": 1}):
        c = (d.get("canonical") or "").strip()
        if not c:
            continue
        gk = canonical_key(c)
        groups.setdefault(gk, {})
        groups[gk][c] = groups[gk].get(c, 0) + 1
        if d.get("locked"):
            locked.add(c)
    merged, patients = 0, 0
    now = datetime.now(tz=timezone.utc)
    for gk, variants in groups.items():
        if len(variants) < 2:
            continue
        rep = pick_representative(variants, locked)
        losers = [v for v in variants if v != rep]
        if not losers:
            continue
        r = await db[_ALIASES].update_many(
            {"canonical": {"$in": losers}, "locked": {"$ne": True}},
            {"$set": {"canonical": rep, "unified_at": now}})
        merged += r.modified_count
        r2 = await db["patients_anonymized"].update_many(   # tenant-ok: καθολική ενοποίηση περιοχών
            {"residence_area_canonical": {"$in": losers}},
            {"$set": {"residence_area_canonical": rep}})
        patients += r2.modified_count
    return {"groups_merged": merged, "patients_updated": patients}


async def ensure_for_tenant(tenant_id: str) -> dict:
    """Κανονικοποίηση περιοχών ΕΝΟΣ tenant (νέος πελάτης μετά το πρώτο ingestion) — ώστε να μη
    βλέπει ακανόνιστη λίστα μέχρι τον εβδομαδιαίο βρόχο."""
    out = await backfill(tenant_id=tenant_id, use_ai=True)
    out.update(await unify_existing())
    return out


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
    # tenant-ok: χειροκίνητη υπερίσχυση στο ΚΑΘΟΛΙΚΟ λεξικό περιοχών (ισχύει για όλους τους πελάτες)
    raws = [r for r in await db["patients_anonymized"].distinct("residence_area", {}) if mechanical_key(r) == key]
    updated = await _apply_to_patients(raws, {key: canonical.strip()})
    return {"ok": True, "key": key, "canonical": canonical.strip(), "patients_updated": updated}
