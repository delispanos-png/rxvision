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

_MODEL = "claude-opus-4-8"

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

ΡΟΗ ΕΡΓΑΣΙΑΣ:
1) Αν ο φαρμακοποιός περιγράφει σύμπτωμα, κάνε δυναμικές, στοχευμένες ΕΡΩΤΗΣΕΙΣ (ηλικία, διάρκεια,
   ένταση, πυρετός, χρόνια νοσήματα, φάρμακα, εγκυμοσύνη/θηλασμός) πριν προτείνεις.
2) Αξιολόγησε red flags σε κάθε βήμα.
3) Αν είναι ασφαλές → πρότεινε θεραπευτικές κατηγορίες + δραστικές ουσίες (με ATC) + μη φαρμακευτικές
   συμβουλές.
4) Αν δοθούν φάρμακα → έλεγξε αλληλεπιδράσεις (Drug-Drug/Food/Alcohol/Disease) με βαρύτητα.

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
        "questions": {"type": "array", "items": {"type": "string"}},
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


async def api_key() -> str | None:
    cfg = await shared_db()["platform_settings"].find_one({"_id": "anthropic"}) or {}
    return cfg.get("api_key")


async def status() -> dict:
    return {"configured": bool(await api_key()), "model": _MODEL}


async def ask(messages: list[dict], context: dict | None = None) -> dict:
    """messages: [{role: 'user'|'assistant', content: str}]. context: patient facts the pharmacist
    has filled (age, sex, pregnancy, chronic, meds, allergies…). Returns the structured analysis."""
    key = await api_key()
    if not key:
        return {"ok": False, "error": "not_configured"}

    import anthropic

    sys = SYSTEM
    if context:
        facts = ", ".join(f"{k}: {v}" for k, v in context.items() if v not in (None, "", []))
        if facts:
            sys = f"{SYSTEM}\n\nΓΝΩΣΤΑ ΣΤΟΙΧΕΙΑ ΑΣΘΕΝΟΥΣ: {facts}"

    client = anthropic.AsyncAnthropic(api_key=key)
    try:
        resp = await client.messages.create(
            model=_MODEL,
            max_tokens=4096,
            thinking={"type": "adaptive"},
            system=sys,
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}, "effort": "high"},
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
