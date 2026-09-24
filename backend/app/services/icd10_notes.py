"""AI επεξήγηση πάθησης ICD-10 — με ΚΑΘΟΛΙΚΗ μνήμη, όχι ανά φαρμακείο.

ΓΙΑΤΙ ΚΑΘΟΛΙΚΗ: ο κωδικός E11.9 σημαίνει το ίδιο πράγμα σε κάθε φαρμακείο της χώρας. Αν η
επεξήγηση παραγόταν ανά πελάτη, θα πληρώναμε το ίδιο κείμενο δεκαπέντε φορές — και με μετρημένο
κόστος 0,03–0,32 € ανά ερώτηση (βλ. memory `ai-cost-economics`) αυτό είναι καθαρή σπατάλη.
Παράγεται ΜΙΑ φορά, μένει για πάντα, και το διαβάζουν όλοι δωρεάν.

ΤΟ ΟΡΙΟ ΤΟΥ ΦΑΡΜΑΚΕΙΟΥ ΚΑΙΓΕΤΑΙ ΜΟΝΟ ΣΤΗΝ ΠΑΡΑΓΩΓΗ: αν το κείμενο υπάρχει ήδη, η ανάγνωση δεν
χρεώνεται — θα ήταν ανέντιμο να μετρήσουμε ερώτηση που δεν έγινε ποτέ στο μοντέλο.

ΟΡΙΑ ΠΕΡΙΕΧΟΜΕΝΟΥ: είναι πληροφορία ΓΙΑ ΤΟΝ ΦΑΡΜΑΚΟΠΟΙΟ, όχι διάγνωση και όχι οδηγία προς
ασθενή. Δεν προτείνει αγωγή, δεν αλλάζει δόσεις και δεν υποκαθιστά τον θεράποντα ιατρό — το
λέει και το ίδιο το κείμενο στην οθόνη.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

COLL = "icd10_ai_notes"
VERSION = 1          # άλλαξέ το για να ξαναπαραχθούν όλα με νέο ύφος/δομή

_SYSTEM = (
    "Είσαι κλινικός φαρμακοποιός που εξηγεί σε ΣΥΝΑΔΕΛΦΟ φαρμακοποιό τι σημαίνει μια διάγνωση "
    "ICD-10 στην καθημερινότητα του φαρμακείου. Γράφεις ΕΛΛΗΝΙΚΑ, σύντομα και συγκεκριμένα.\n"
    "ΚΑΝΟΝΕΣ:\n"
    "· ΠΟΤΕ δεν προτείνεις συγκεκριμένη αγωγή, δόση ή αλλαγή θεραπείας.\n"
    "· ΠΟΤΕ δεν μιλάς σαν να κάνεις διάγνωση. Η διάγνωση έχει ήδη γίνει από ιατρό.\n"
    "· Αναφέρεις ΚΑΤΗΓΟΡΙΕΣ φαρμάκων (π.χ. «διγουανίδες», «αναστολείς SGLT2»), "
    "όχι εμπορικά ονόματα.\n"
    "· Καμία στατιστική που δεν ξέρεις. Αν κάτι δεν είναι βέβαιο, μην το γράφεις.\n"
    "· Χωρίς εισαγωγές του τύπου «Φυσικά, ορίστε». Μπαίνεις κατευθείαν στο θέμα."
)

_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["what", "pharmacy", "watch", "talk"],
    "properties": {
        "what": {"type": "string",
                 "description": "Τι είναι η πάθηση, σε 2-3 προτάσεις, απλά."},
        "pharmacy": {"type": "string",
                     "description": "Τι σημαίνει στην πράξη για το φαρμακείο: κατηγορίες "
                                    "φαρμάκων που συνήθως συνοδεύουν, τι είδους αγωγή "
                                    "(χρόνια/εποχική/οξεία), τι συνήθως ζητά ο ασθενής."},
        "watch": {"type": "array", "items": {"type": "string"},
                  "description": "3-5 σημεία προσοχής για τον φαρμακοποιό: συμμόρφωση, "
                                 "συχνές αλληλεπιδράσεις κατηγοριών, σημάδια που αξίζουν "
                                 "παραπομπή στον ιατρό."},
        "talk": {"type": "array", "items": {"type": "string"},
                 "description": "2-4 πράγματα που μπορεί να πει ο φαρμακοποιός στον ασθενή "
                                "στον πάγκο — πρακτικά, χωρίς ιατρικούς όρους."},
    },
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def cached(code: str) -> dict | None:
    doc = await shared_db()[COLL].find_one({"_id": f"{code}|v{VERSION}"})   # tenant-ok: καθολικό
    return doc


async def generate(*, code: str, title: str, description: str | None,
                   tenant_id: str) -> dict:
    """Παράγει (ή επιστρέφει από τη μνήμη) την επεξήγηση για έναν κωδικό ICD-10."""
    code = str(code or "").strip().upper()
    if not code:
        return {"ok": False, "error": "no_code"}
    hit = await cached(code)
    if hit:
        return {"ok": True, "cached": True, **{k: hit.get(k) for k in
                                               ("what", "pharmacy", "watch", "talk", "at")}}

    # ΚΑΘΟΛΙΚΟ ΦΡΕΝΟ: αν πιάστηκε το ημερήσιο ταβάνι της πλατφόρμας, σταματάμε εδώ.
    from app.services import ai_quota as _q
    if not (await _q.platform_allows())[0]:
        return {"ok": False, "error": "platform_cap"}
    from app.services import ai_cost, ai_quota, pharmacat_service
    c = await pharmacat_service._config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not c["enabled"]:
        return {"ok": False, "error": "disabled"}
    allowed, _used, limit, reason = await ai_quota.check_and_consume(tenant_id)
    if not allowed:
        return {"ok": False, "error": reason or "quota_exceeded", "limit": limit}

    import anthropic

    prompt = (f"Κωδικός ICD-10: {code}\nΤίτλος: {title or '—'}\n"
              + (f"Επίσημη περιγραφή: {description}\n" if description else "")
              + "Εξήγησε την πάθηση για φαρμακοποιό στον πάγκο.")
    client = anthropic.AsyncAnthropic(
        # ΔΙΚΗ ΜΑΣ εργασία (επεξηγήσεις ICD-10 (καθολικές, μία φορά για όλους)) → κλειδί ΠΛΑΤΦΟΡΜΑΣ,
        # ώστε ο λογαριασμός Anthropic να τη δείχνει χωριστά από τους πελάτες.
        api_key=pharmacat_service.key_for(c, internal=True))
    try:
        resp = await client.messages.create(
            # 1800 και όχι 900: τα ελληνικά είναι «βαριά» σε tokens (~2 χαρακτήρες/token) και με
            # την επίσημη περιγραφή στο prompt η απάντηση κοβόταν στη μέση — και ένα κομμένο JSON
            # δεν διαβάζεται καθόλου, οπότε η επεξήγηση απλώς «δεν έβγαινε».
            model=c["model"], max_tokens=1800,
            system=_SYSTEM + pharmacat_service.GUARDRAIL,
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
        )
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"api_error:{e.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"call_failed:{type(e).__name__}"}
    await ai_cost.record(tenant_id, c["model"], getattr(resp, "usage", None))

    if getattr(resp, "stop_reason", None) == "max_tokens":
        return {"ok": False, "error": "truncated"}

    import json
    raw = "".join(b.text for b in resp.content if b.type == "text").strip()
    try:
        data = json.loads(raw)
    except ValueError:
        return {"ok": False, "error": "bad_output"}

    doc = {"_id": f"{code}|v{VERSION}", "code": code, "version": VERSION,
           "what": str(data.get("what") or "")[:900],
           "pharmacy": str(data.get("pharmacy") or "")[:900],
           "watch": [str(x)[:300] for x in (data.get("watch") or [])][:6],
           "talk": [str(x)[:300] for x in (data.get("talk") or [])][:5],
           "model": c["model"], "at": _now(), "by_tenant": tenant_id}
    # tenant-ok: ο κατάλογος ICD-10 είναι διεθνής — η επεξήγηση γράφεται μία φορά για όλους
    await shared_db()[COLL].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return {"ok": True, "cached": False,
            **{k: doc[k] for k in ("what", "pharmacy", "watch", "talk", "at")}}
