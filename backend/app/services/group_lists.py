"""ΤΙ ΑΚΡΙΒΩΣ τρέχει σε μια ομάδα ανθρώπων — ΜΙΑ μηχανή, δύο κυκλώματα.

Τα ίδια ερωτήματα απαντούν σε δύο εντελώς διαφορετικές ερωτήσεις:

  ΟΙΚΟΓΕΝΕΙΑ  → «τι πήρε ο μπαμπάς, τι η μαμά, τι τα παιδιά· τι τους λείπει»
  ΔΟΜΗ        → «τι να έχω έτοιμο τον επόμενο κύκλο για τους 40 τροφίμους»

Γράφονται ΜΙΑ φορά εδώ. Αν ζούσαν χωριστά, η μία οθόνη θα απαντούσε με άλλους κανόνες από την
άλλη για το ίδιο ερώτημα — και οι κανόνες εδώ δεν είναι προφανείς (ανακτήσιμα ≠ ανεκτέλεστα,
υπόλοιπο τεμαχίων ≠ ποσότητα γραμμής, `next_open_date` ≠ αφαίρεση θέσεων αλυσίδας).

ΟΛΑ ΤΑ ΕΡΩΤΗΜΑΤΑ ΕΙΝΑΙ ΟΜΑΔΙΚΑ. Ένα ανά κατηγορία για ΟΛΑ τα μέλη, όχι ένα ανά μέλος: μια
οικογένεια έχει 4, ένα γηροκομείο 40 — το δεύτερο θα σήμαινε 160 ταξίδια στη βάση.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.services import recoverable


def _now() -> datetime:
    return datetime.now(tz=timezone.utc).replace(tzinfo=None)


async def opening(db, tenant_id: str, ids: list, names: dict[str, str], *,
                  days: int = 45, limit: int = 500) -> list[dict]:
    """Ποιες συνταγές ΑΝΟΙΓΟΥΝ μέσα στο παράθυρο, ανά άνθρωπο.

    ⚠ Από το `next_open_date`, ΠΟΤΕ από `repeat_total − repeat_current`: το `repeat_current`
    είναι ΘΕΣΗ στην αλυσίδα, όχι πλήθος εκτελέσεων, και η αφαίρεση βγάζει ψευδείς συναγερμούς.
    """
    if not ids:
        return []
    now = _now()
    out = []
    async for r in db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ids},
                        "status": {"$ne": "cancelled"},
                        "next_open_date": {"$gte": now, "$lt": now + timedelta(days=max(1, days))}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "pr"}},
            {"$project": {"patient_ref": 1, "external_id": 1, "next_open_date": 1,
                          "names": "$pr.name", "qty": {"$sum": "$it.quantity"},
                          # Άυλη = δεν χρειάζεται να φέρουν ΧΑΡΤΙ· το barcode αρκεί. Χωρίς αυτό
                          # ζητάμε από τη δομή να κουβαλήσει έντυπα που δεν υπάρχουν.
                          "intangible": {"$ifNull": ["$details.intangible", False]}}},
            {"$sort": {"next_open_date": 1}}, {"$limit": limit}]):
        pid = str(r["patient_ref"])
        out.append({"patient_id": pid, "name": names.get(pid, "—"),
                    "barcode": str(r.get("external_id") or "").split(":")[0],
                    "opens_at": r.get("next_open_date"),
                    "intangible": bool(r.get("intangible")),
                    "items": [n for n in (r.get("names") or []) if n][:6],
                    "qty": r.get("qty") or 0})
    return out


def by_person(rows: list[dict]) -> list[dict]:
    """Η ίδια λίστα ΑΝΑ ΑΝΘΡΩΠΟ — αυτό στέλνεται στη δομή.

    Ταξινομημένη κατά ημερομηνία γίνεται λίστα δουλειάς ΤΟΥ ΦΑΡΜΑΚΕΙΟΥ. Η δομή χρειάζεται το
    αντίθετο: «ο κύριος Χ — αυτά τα barcode», για να τα μαζέψει ανά άνθρωπο.
    """
    g: dict[str, dict] = {}
    for r in rows:
        b = g.setdefault(r["patient_id"], {"patient_id": r["patient_id"], "name": r["name"],
                                           "rx": []})
        b["rx"].append({"barcode": r["barcode"], "opens_at": r.get("opens_at"),
                        "intangible": r.get("intangible", False),
                        "items": r.get("items") or []})
    # ΕΝΑ ΒΑΡΚΩΔ, ΜΙΑ ΓΡΑΜΜΗ: μια συνταγή με δύο μελλοντικές εκτελέσεις εμφανιζόταν δύο φορές.
    # Για λίστα δουλειάς είναι θόρυβος — κρατάμε την ΠΡΩΤΗ ημερομηνία που ανοίγει.
    for b in g.values():
        uniq: dict[str, dict] = {}
        for r in sorted(b["rx"], key=lambda x: (x["opens_at"] is None, x["opens_at"])):
            cur = uniq.get(r["barcode"])
            if cur is None:
                uniq[r["barcode"]] = r
            elif len(r["items"]) > len(cur["items"]):
                r["opens_at"] = cur["opens_at"]          # κράτα την ΠΡΩΤΗ ημερομηνία
                uniq[r["barcode"]] = r
        b["rx"] = sorted(uniq.values(), key=lambda x: (x["opens_at"] is None, x["opens_at"]))
    return sorted(g.values(), key=lambda b: b["name"] or "")


async def to_order(db, tenant_id: str, ids: list, *, days: int = 45,
                   limit: int = 200) -> list[dict]:
    """Τα ίδια, ΑΘΡΟΙΣΜΕΝΑ ανά σκεύασμα — η λίστα παραγγελίας."""
    if not ids:
        return []
    now = _now()
    out = []
    async for r in db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ids},
                        "status": {"$ne": "cancelled"},
                        "next_open_date": {"$gte": now, "$lt": now + timedelta(days=max(1, days))}}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$group": {"_id": "$it.product_id", "qty": {"$sum": "$it.quantity"},
                        "people": {"$addToSet": "$patient_ref"}}},
            {"$lookup": {"from": "products", "localField": "_id",
                         "foreignField": "_id", "as": "p"}},
            {"$project": {"qty": 1, "people": {"$size": "$people"},
                          "name": {"$first": "$p.name"}, "barcode": {"$first": "$p.barcode"}}},
            {"$sort": {"qty": -1}}, {"$limit": limit}]):
        out.append({"name": r.get("name") or "—", "barcode": r.get("barcode"),
                    "qty": r.get("qty") or 0, "people": r.get("people") or 0})
    return out


async def pending(db, tenant_id: str, ids: list, names: dict[str, str], *,
                  limit: int = 200) -> list[dict]:
    """Τι ΕΚΚΡΕΜΕΙ και μπορεί ΑΚΟΜΗ να δοθεί, ανά άνθρωπο και ανά σκεύασμα.

    ⚠ ΜΟΝΟ τα ανακτήσιμα (`recoverable`: ανοιχτή ΚΑΙ σε ισχύ) και ΜΟΝΟ το ΥΠΟΛΟΙΠΟ των
    τεμαχίων — μια συσκευασία 2 με το 1 δοσμένο χρωστά 1, όχι 2.
    """
    if not ids:
        return []
    out = []
    async for r in db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ids},
                        "status": {"$ne": "cancelled"}, **recoverable.mongo_filter()}},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$set": {"_left": {"$max": [0, {"$subtract": [
                "$it.quantity", {"$ifNull": ["$it.executed_qty", 0]}]}]}}},
            {"$match": {"_left": {"$gt": 0}}},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$group": {"_id": {"pr": "$patient_ref", "ex": "$external_id"},
                        "valid_until": {"$first": "$valid_until"},
                        "executed_at": {"$first": "$executed_at"},
                        "value": {"$sum": {"$multiply": ["$it.retail_price", "$_left"]}},
                        "items": {"$push": {"name": {"$first": "$p.name"}, "left": "$_left"}}}},
            {"$sort": {"valid_until": 1}}, {"$limit": limit}]):
        pid = str(r["_id"]["pr"])
        out.append({"patient_id": pid, "name": names.get(pid, "—"),
                    "barcode": str(r["_id"]["ex"] or "").split(":")[0],
                    "executed_at": r.get("executed_at"),
                    "valid_until": r.get("valid_until"),
                    "value": r.get("value") or 0, "items": r.get("items") or []})
    return out


async def loans(db, tenant_id: str, ids: list, names: dict[str, str], *,
                limit: int = 200) -> list[dict]:
    """Ανοιχτά δανεικά ανά άνθρωπο. Το `patient_ref` εκεί άλλοτε ObjectId κι άλλοτε κείμενο."""
    if not ids:
        return []
    strs = [str(i) for i in ids]
    out = []
    async for d in db["advance_dispensings"].find(
            {"tenant_id": tenant_id, "status": "open",
             "patient_ref": {"$in": list(ids) + strs}}).sort("created_at", 1).limit(limit):
        pid = str(d.get("patient_ref"))
        out.append({"patient_id": pid, "name": names.get(pid, d.get("patient_name") or "—"),
                    "created_at": d.get("created_at"),
                    "expected_at": d.get("expected_at"),
                    "items": [i.get("name") for i in (d.get("items") or []) if i.get("name")]})
    return out


async def recent(db, tenant_id: str, ids: list, names: dict[str, str], *,
                 months: int = 12, limit: int = 300) -> list[dict]:
    """ΤΙ ΠΗΡΕ ο καθένας — οι εκτελέσεις του, με σκευάσματα και ποσά.

    Χωρίς αυτό η οθόνη έλεγε μόνο «65 εκτελέσεις» και ο φαρμακοποιός έπρεπε να φύγει από τη
    σελίδα για να δει ΤΙ ήταν αυτές.
    """
    if not ids:
        return []
    since = _now() - timedelta(days=30 * max(1, months))
    out = []
    async for r in db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ids},
                        "status": {"$ne": "cancelled"}, "executed_at": {"$gte": since}}},
            {"$sort": {"executed_at": -1}}, {"$limit": limit},
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "pr"}},
            {"$project": {"patient_ref": 1, "external_id": 1, "executed_at": 1,
                          "amount_total": 1, "patient_share": 1,
                          "partial": {"$ifNull": ["$has_unexecuted_substances", False]},
                          "names": "$pr.name"}}]):
        pid = str(r["patient_ref"])
        out.append({"patient_id": pid, "name": names.get(pid, "—"),
                    "barcode": str(r.get("external_id") or "").split(":")[0],
                    "external_id": r.get("external_id"),
                    "executed_at": r.get("executed_at"),
                    "value": r.get("amount_total") or 0,
                    "paid": r.get("patient_share") or 0,
                    "partial": bool(r.get("partial")),
                    "items": [n for n in (r.get("names") or []) if n][:8]})
    return out


async def everything(db, tenant_id: str, ids: list, names: dict[str, str], *,
                     days: int = 45, months: int = 12) -> dict[str, Any]:
    """Και οι πέντε λίστες με μία κλήση — η οθόνη ανοίγει μία φορά, όχι πέντε."""
    return {
        "recent": await recent(db, tenant_id, ids, names, months=months),
        "opening": await opening(db, tenant_id, ids, names, days=days),
        "order": await to_order(db, tenant_id, ids, days=days),
        "pending": await pending(db, tenant_id, ids, names),
        "loans": await loans(db, tenant_id, ids, names),
    }


_FORMS = {"ΔΙΣΚΙΑ": "δισκίο", "ΚΑΨΑΚΙΑ": "καψάκιο", "ΣΤΑΓΟΝΕΣ": "σταγόνες",
          "ΕΝΕΣΗ": "ένεση", "ΕΙΣΠΝΟΕΣ": "εισπνοή", "ΦΑΚΕΛΙΣΚΟΙ": "φακελίσκος",
          "ΥΠΟΘΕΤΑ": "υπόθετο", "ΣΙΡΟΠΙ": "σιρόπι", "ΑΜΠΟΥΛΕΣ": "αμπούλα"}


def _dosage(d: dict) -> str:
    """Η οδηγία του γιατρού σε ΑΝΘΡΩΠΙΝΑ ελληνικά.

    Το CDA δίνει «1 ΔΙΣΚΙΑ_ΕΠΙΚΑΛ», «12 h», «30 d». Σε φύλλο που θα κρατήσει στο χέρι του
    προσωπικό της δομής, αυτό δεν διαβάζεται — και μια δοσολογία που δεν διαβάζεται είναι
    επικίνδυνη, όχι απλώς άσχημη.
    """
    raw = str(d.get("dose") or "").strip()
    dose = ""
    if raw:
        parts = raw.replace("_", " ").split()
        qty = parts[0] if parts and parts[0].replace(",", ".").replace(".", "").isdigit() else ""
        form = next((_FORMS[w] for w in parts if w in _FORMS), "")
        dose = " ".join(x for x in (qty, form) if x) or raw.replace("_", " ").strip()
    freq = str(d.get("frequency") or "").strip()
    dur = str(d.get("duration") or "").strip()
    bits = [b for b in [dose] if b]
    if freq:
        n, _, unit = freq.partition(" ")
        if unit.startswith("h"):
            bits.append("μία φορά την ημέρα" if n == "24" else f"κάθε {n} ώρες")
        elif unit.startswith("d"):
            bits.append("κάθε μέρα" if n == "1" else f"κάθε {n} ημέρες")
        else:
            bits.append(freq)
    if dur:
        n, _, unit = dur.partition(" ")
        bits.append(f"για {n} " + ("ημέρες" if unit.startswith("d") else
                                   "μήνες" if unit.startswith("m") else unit))
    return " · ".join(bits)


async def instructions(db, tenant_id: str, ids: list, names: dict[str, str], *,
                       months: int = 6) -> list[dict]:
    """ΦΥΛΛΟ ΟΔΗΓΙΩΝ ΛΗΨΗΣ ανά άνθρωπο: τι παίρνει και ΠΩΣ.

    ΓΙΑΤΙ ΕΧΕΙ ΝΟΗΜΑ: στη δομή τα φάρμακα τα δίνει προσωπικό που δεν ήταν στο ταμείο όταν
    εξηγήσαμε τη δοσολογία. Η οδηγία του γιατρού υπάρχει ΗΔΗ στο CDA (δόση/συχνότητα/διάρκεια)
    — απλώς δεν την είχαμε βγάλει ποτέ σε χαρτί.

    ΤΟ ΠΙΟ ΠΡΟΣΦΑΤΟ ΝΙΚΑΕΙ: ένα φάρμακο μπορεί να έχει εκτελεστεί πολλές φορές με αλλαγμένη
    δοσολογία. Κρατάμε την ΤΕΛΕΥΤΑΙΑ οδηγία, όχι την πρώτη που θα βρεθεί.
    """
    if not ids:
        return []
    since = _now() - timedelta(days=30 * max(1, months))
    per: dict[str, dict[str, dict]] = {}
    async for r in db["prescription_executions"].aggregate([
            {"$match": {"tenant_id": tenant_id, "patient_ref": {"$in": ids},
                        "status": {"$ne": "cancelled"}, "executed_at": {"$gte": since}}},
            {"$sort": {"executed_at": 1}},          # παλιό → νέο, ώστε το νεότερο να γράφει πάνω
            {"$lookup": {"from": "prescription_items", "localField": "_id",
                         "foreignField": "execution_id", "as": "it"}},
            {"$unwind": "$it"},
            {"$match": {"$expr": {"$gt": [{"$ifNull": ["$it.executed_qty", 0]}, 0]}}},
            {"$lookup": {"from": "products", "localField": "it.product_id",
                         "foreignField": "_id", "as": "p"}},
            {"$project": {"patient_ref": 1, "executed_at": 1,
                          "name": {"$first": "$p.name"}, "det": "$it.details"}}]):
        pid = str(r["patient_ref"])
        nm = r.get("name") or "—"
        per.setdefault(pid, {})[nm] = {
            "name": nm, "dosage": _dosage(r.get("det") or {}),
            "last": r.get("executed_at")}
    out = []
    for pid, meds in per.items():
        # Το ίδιο σκεύασμα υπάρχει συχνά δύο φορές στον κατάλογο (σύντομο και πλήρες όνομα).
        # Σε ΦΥΛΛΟ ΟΔΗΓΙΩΝ δύο γραμμές για το ίδιο χάπι είναι σύγχυση: ενοποιούμε σε πρώτη λέξη
        # + ίδια οδηγία, κρατώντας το ΠΛΗΡΕΣΤΕΡΟ όνομα.
        uniq: dict[tuple, dict] = {}
        for m in meds.values():
            k = (str(m["name"]).split()[0].upper(), m["dosage"])
            if k not in uniq or len(m["name"]) > len(uniq[k]["name"]):
                uniq[k] = m
        rows = sorted(uniq.values(), key=lambda m: m["name"])
        out.append({"patient_id": pid, "name": names.get(pid, "—"), "meds": rows})
    return sorted(out, key=lambda b: b["name"] or "")
