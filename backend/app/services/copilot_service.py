"""RxVision Copilot — in-app assistant that answers "how do I do X in the program" and points the
user to the right screen (Level 1: guide + deep links). Separate persona from the clinical PharmaCat
but SHARES the LLM plumbing (Anthropic key/model/enabled config) via pharmacat_service._config.

Level 2 (read-only data via tools) and Level 3 (gated actions) come later.
"""

from __future__ import annotations

import json

from app.services import pharmacat_service  # shared Anthropic config (key/model/enabled/status)

# The app map — keep in sync with the sidebar/routes. The model uses it to answer + deep-link.
SYSTEM = """Είσαι ο «Copilot» του RxVision — ο έξυπνος βοηθός για τη ΧΡΗΣΗ του ίδιου του προγράμματος
(όχι κλινικός· για φάρμακα/ασθενείς υπάρχει ο PharmaCat). Απαντάς ΠΑΝΤΑ στα ελληνικά, σύντομα και
πρακτικά: εξήγησε με 2-5 βήματα ΠΩΣ γίνεται κάτι και δώσε τον σύνδεσμο της σωστής σελίδας.

ΧΑΡΤΗΣ ΤΟΥ ΠΡΟΓΡΑΜΜΑΤΟΣ (διαδρομές & τι κάνει η κάθε σελίδα):
- /dashboard — Πίνακας Ελέγχου: συνολική εικόνα (KPIs, τάσεις).
- /prescriptions — Συνταγές: ανάλυση εκτελέσεων (ανά ταμείο/φάρμακο/περίοδο), αξία/αιτούμενα.
- /doctors — Ιατροί: τζίρος/κερδοφορία ανά ιατρό & ειδικότητα.
- /patients — Ασφαλισμένοι: ασθενείς, αξία, LTV.
- /icd10 — ICD-10: ανάλυση ανά διάγνωση.
- /profitability — Κερδοφορία: μεικτό κέρδος/περιθώριο.
- /future — Μελλοντικές: συνταγές προς εκτέλεση/ανανέωση.
- /orders — Παραγγελίες· /order-advisor — Σύμβουλος Παραγγελίας (προτάσεις αναπλήρωσης).
- /communications — Επικοινωνία: recall/μηνύματα σε ασθενείς.
- /closing — Κλείσιμο μήνα (γενικό).
- /pharmacyone — PharmacyOne add-on (απόθεμα/κόστη).
- /intelligence — Patient Intelligence: dashboard, Σήμερα, Συμμόρφωση, Recall, Win-back, VIP, Ρίσκο, Τμηματοποίηση.
- /reimbursement — Έλεγχος Αποζημίωσης (ΕΟΠΥΥ). Υποσελίδες: Executive, Κλείσιμο Μήνα, Πρόβλεψη,
  Ρίσκο & Περικοπές, Ημερήσιος Έλεγχος (/reimbursement/daily), Έλεγχος Barcode (/reimbursement/physical
  — σκανάρισμα ανά ημέρα + κουπόνια/QR/γνωμάτευση), Υποβολή, Συμφωνία, Optical Audit.
- /advisor — Σύμβουλος Επιχείρησης· /nutrition — Σύμβουλος Διατροφής.
- /pharmacat — PharmaCat (κλινικός βοηθός).
- /settings/users — Ρυθμίσεις (χρήστες/ρόλοι/δικαιώματα)· /account — Ο λογαριασμός μου (στοιχεία/κωδικός).
- Top bar: εναλλαγή θέματος (σκούρο/φωτεινό), γλώσσα (ΕΛ/EN), εγκατάσταση εφαρμογής (PWA).

ΟΔΗΓΙΕΣ:
- Για «πώς κάνω X»: δώσε σύντομα βήματα + τον/τους σχετικούς συνδέσμους (links) στο πεδίο links.
- Για ερωτήσεις ΔΕΔΟΜΕΝΩΝ ("δώσε ανοιχτό υπόλοιπο", "ποιος ο top πελάτης", "πόση η απαίτηση") ΑΚΟΜΗ
  δεν φέρνεις νούμερα — κατεύθυνε τον χρήστη στη σωστή σελίδα και πες ότι σύντομα θα απαντάς απευθείας.
- Για ΕΝΕΡΓΕΙΕΣ ("στείλε", "δημιούργησε") εξήγησε πού/πώς γίνονται — δεν τις εκτελείς (έρχεται αργότερα).
- Αν δεν ξέρεις/δεν υπάρχει στο πρόγραμμα, πες το ειλικρινά.
- Επέστρεψε ΠΑΝΤΑ έγκυρο JSON: reply (η απάντηση) + links (0-4 σχετικοί σύνδεσμοι)."""

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["reply", "links"],
    "properties": {
        "reply": {"type": "string"},
        "links": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["label", "href"],
            "properties": {"label": {"type": "string"}, "href": {"type": "string"}}}},
    },
}


async def status() -> dict:
    return await pharmacat_service.status()


async def ask(messages: list[dict]) -> dict:
    c = await pharmacat_service._config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not c["enabled"]:
        return {"ok": False, "error": "disabled"}

    import anthropic

    model = c["model"]
    out_cfg: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if model != "claude-haiku-4-5":
        out_cfg["effort"] = "low"
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    try:
        resp = await client.messages.create(
            model=model, max_tokens=1500, system=SYSTEM,
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
            output_config=out_cfg)
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"api_error:{e.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"unavailable:{type(e).__name__}"}
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": "parse_error"}
    data["ok"] = True
    return data
