"""PharmaCat Clinical Assistant — AI Clinical Decision Support System (CDSS) for the pharmacist.

Powered by Claude (claude-opus-4-8). This is a *decision support* tool: it does NOT diagnose and
does NOT replace a physician. It gives the pharmacist evidence-based information, safety checks,
interaction analysis, symptom triage and OTC category suggestions — with hard red-flag gating.

The Anthropic API key lives in `platform_settings._id='anthropic'` (entered in admin, like the ΑΑΔΕ
/ Revolut creds) — never in git/logs. If absent, the module reports `not_configured` cleanly.
"""

from __future__ import annotations

import json

from app.core.db import shared_db

_DEFAULT_MODEL = "claude-opus-4-8"
# Selectable in admin → Integrations (cost vs quality). Opus best, Sonnet ~6× cheaper, Haiku cheapest.
ALLOWED_MODELS = ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5")

# Hard-coded clinical safety contract. Phrased as context + duties, not over-aggressive commands.
SYSTEM = """Είσαι ο «PharmaCat», κλινικός επιστημονικός βοηθός (Clinical Decision Support System)
για ΦΑΡΜΑΚΟΠΟΙΟ σε ελληνικό φαρμακείο. Απαντάς ΠΑΝΤΑ στα ελληνικά, με επιστημονική ακρίβεια και
συντομία, σαν έμπειρος κλινικός φαρμακοποιός που μιλά σε συνάδελφο.

ΟΡΙΑ ΑΣΦΑΛΕΙΑΣ (μη διαπραγματεύσιμα):
- ΔΕΝ κάνεις ιατρική διάγνωση και ΔΕΝ αντικαθιστάς τον ιατρό. Δίνεις τεκμηριωμένη υποστήριξη απόφασης.
- Προτείνεις ΚΥΡΙΩΣ μη συνταγογραφούμενα (OTC) σκευάσματα και μη φαρμακευτικές συμβουλές. Για
  συνταγογραφούμενα φάρμακα παραπέμπεις σε ιατρό.
- Αν εντοπίσεις σύμπτωμα/εύρημα «κόκκινης σημαίας» (red flag) → ΣΤΑΜΑΤΑΣ τις προτάσεις OTC,
  ενημερώνεις και παραπέμπεις σε ιατρό ή νοσοκομείο ανάλογα με τη βαρύτητα.
- Λαμβάνεις υπόψη: ηλικία, εγκυμοσύνη, θηλασμό, χρόνια νοσήματα, νεφρική/ηπατική λειτουργία,
  τρέχουσα φαρμακευτική αγωγή, αλληλεπιδράσεις, αλλεργίες.

ΡΟΗ ΕΡΓΑΣΙΑΣ — ΚΡΑΤΑ ΤΟ ΑΠΛΟ & ΓΡΗΓΟΡΟ (ο φαρμακοποιός είναι στον πάγκο, δεν έχει χρόνο):
1) Έλεγξε red flags. Αν υπάρχουν → σταμάτα τις προτάσεις & παράπεμψε.
2) Δώσε ΑΜΕΣΩΣ πρακτική πρόταση για το ΠΙΟ ΣΥΝΗΘΕΣ σενάριο (ενήλικας, χωρίς ιδιαιτερότητες): 1-2
   θεραπευτικές κατηγορίες + δραστικές (με ATC) + 1-2 βασικές μη φαρμακευτικές συμβουλές. ΜΗΝ κρύβεις
   την πρόταση πίσω από ερωτήσεις. Αν χωράνε δύο εκδοχές (π.χ. ξηρός vs παραγωγικός βήχας), δώσε και
   τις δύο σύντομα ώστε ο φαρμακοποιός να διαλέξει μόνος του.
3) Ρώτησε ΤΟ ΠΟΛΥ 1-2 ερωτήσεις — ΜΟΝΟ αυτές που πραγματικά αλλάζουν την πρόταση ή την ασφάλεια
   (συνήθως: ηλικία/παιδί, εγκυμοσύνη/θηλασμός). Διατύπωσέ τες ως ΠΡΟΑΙΡΕΤΙΚΗ εξειδίκευση, όχι ως
   προϋπόθεση. Ποτέ πάνω από 2 ερωτήσεις. Αν τα στοιχεία ασθενούς δόθηκαν ήδη, ΜΗΝ τα ξαναρωτάς.
   Για ΚΑΘΕ ερώτηση δώσε 2-4 σύντομες έτοιμες ΕΠΙΛΟΓΕΣ (options) όταν η απάντηση είναι διακριτή (π.χ.
   «Ξηρός»/«Παραγωγικός», «<3 ημέρες»/«>1 εβδομάδα»), ώστε ο φαρμακοποιός να απαντά με ΕΝΑ ΚΛΙΚ. Μόνο
   για πραγματικά ελεύθερο κείμενο (π.χ. ακριβής ηλικία) άσε τις options κενές. Όταν ο φαρμακοποιός
   απαντήσει, δώσε ΑΜΕΣΩΣ την τελική εξειδικευμένη πρόταση — μην ξαναρωτάς.
4) Αν δοθούν φάρμακα → έλεγξε αλληλεπιδράσεις (Drug-Drug/Food/Alcohol/Disease) με βαρύτητα.

ΧΡΥΣΟΣ ΚΑΝΟΝΑΣ: πάντα δίνεις χρήσιμη απάντηση από το πρώτο μήνυμα. Λίγες, στοχευμένες ερωτήσεις — όχι
ερωτηματολόγιο.

ΜΟΡΦΗ: Επιστρέφεις ΠΑΝΤΑ έγκυρο JSON σύμφωνα με το παρεχόμενο schema. Το πεδίο `reply` είναι η
συνομιλιακή σου απάντηση προς τον φαρμακοποιό (μπορεί να περιέχει την επόμενη ερώτηση). Συμπληρώνεις
μόνο όσα πεδία είναι σχετικά· τα υπόλοιπα μένουν κενά (κενός πίνακας / false)."""

# Structured-output schema (output_config.format). Strict objects → predictable shape for the UI.
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reply", "stage", "red_flags", "questions", "otc_categories",
                 "substances", "non_drug_advice", "interactions", "referral"],
    "properties": {
        "reply": {"type": "string"},
        "stage": {"type": "string",
                  "enum": ["triage", "questions", "recommendation", "interaction", "referral"]},
        "red_flags": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["flag", "action"],
            "properties": {"flag": {"type": "string"}, "action": {"type": "string"}}}},
        "questions": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["question", "options"],
            "properties": {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}}}}},
        "otc_categories": {"type": "array", "items": {"type": "string"}},
        "substances": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["name", "atc", "note"],
            "properties": {"name": {"type": "string"}, "atc": {"type": "string"},
                           "note": {"type": "string"}}}},
        "non_drug_advice": {"type": "array", "items": {"type": "string"}},
        "interactions": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["a", "b", "severity", "mechanism", "risk", "action"],
            "properties": {
                "a": {"type": "string"}, "b": {"type": "string"},
                "severity": {"type": "string",
                             "enum": ["minor", "moderate", "major", "contraindicated"]},
                "mechanism": {"type": "string"}, "risk": {"type": "string"},
                "action": {"type": "string"}}}},
        "safety": {"type": "object", "additionalProperties": False,
                   "required": ["pregnancy", "lactation", "renal", "hepatic", "pediatric", "elderly"],
                   "properties": {k: {"type": "string"} for k in
                                  ("pregnancy", "lactation", "renal", "hepatic",
                                   "pediatric", "elderly")}},
        "referral": {"type": "object", "additionalProperties": False,
                     "required": ["needed", "urgency", "reason"],
                     "properties": {
                         "needed": {"type": "boolean"},
                         "urgency": {"type": "string",
                                     "enum": ["none", "gp", "urgent", "emergency"]},
                         "reason": {"type": "string"}}},
    },
}


async def _config() -> dict:
    cfg = await shared_db()["platform_settings"].find_one({"_id": "anthropic"}) or {}
    model = cfg.get("model") if cfg.get("model") in ALLOWED_MODELS else _DEFAULT_MODEL
    # Separate (usually stronger) model for admin curation/regeneration of KB answers.
    admin_model = cfg.get("admin_model") if cfg.get("admin_model") in ALLOWED_MODELS else _DEFAULT_MODEL
    return {"api_key": cfg.get("api_key"), "enabled": cfg.get("enabled", True),
            "model": model, "admin_model": admin_model}


async def status() -> dict:
    c = await _config()
    return {"configured": bool(c["api_key"]), "enabled": bool(c["enabled"]),
            "model": c["model"], "admin_model": c["admin_model"]}


async def ask(messages: list[dict], context: dict | None = None,
              model: str | None = None) -> dict:
    """messages: [{role: 'user'|'assistant', content: str}]. Returns the structured analysis.
    `model` overrides the configured pharmacist model (e.g. admin regeneration uses a stronger one)."""
    c = await _config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not c["enabled"]:
        return {"ok": False, "error": "disabled"}

    import anthropic

    sys = SYSTEM
    if context:
        facts = ", ".join(f"{k}: {v}" for k, v in context.items() if v not in (None, "", []))
        if facts:
            sys = f"{SYSTEM}\n\nΓΝΩΣΤΑ ΣΤΟΙΧΕΙΑ ΑΣΘΕΝΟΥΣ: {facts}"

    model = model if model in ALLOWED_MODELS else c["model"]
    # Cost-optimised for a high-volume counter tool: NO extended thinking (OTC triage is recall).
    out_cfg: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if model != "claude-haiku-4-5":   # effort param errors on Haiku 4.5
        out_cfg["effort"] = "low"
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=2048,
            system=sys,
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
            output_config=out_cfg,
        )
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"api_error:{e.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"unavailable:{type(e).__name__}"}

    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": "parse_error", "raw": text[:500]}
    data["ok"] = True
    return data
