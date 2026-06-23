"""LLM-generated, pharmacist-facing advice from a patient's 360° profile («Εικόνα Πελάτη»):
how to care for / retain / approach this customer, relevant lifestyle & nutrition guidance, ethical
care/cross-sell opportunities, and points to watch. Reuses the shared Anthropic config (admin key/model).

NOT medical advice / no diagnosis — general guidance for the pharmacist, explicitly non-prescriptive.
"""
from __future__ import annotations

import json

from app.services import pharmacat_service

SYSTEM = (
    "Είσαι έμπειρος βοηθός φαρμακοποιού στην Ελλάδα. Με βάση την ΕΙΚΟΝΑ ΠΕΛΑΤΗ που σου δίνεται "
    "(θεραπευτικές κατηγορίες, παθήσεις ICD-10, συμμόρφωση, αξία/συχνότητα, χαμένες εκτελέσεις, "
    "ηλικία/φύλο), δώσε ΠΡΑΚΤΙΚΕΣ και σύντομες οδηγίες ΠΡΟΣ ΤΟΝ ΦΑΡΜΑΚΟΠΟΙΟ: πώς να φροντίσει και να "
    "διατηρήσει τον πελάτη, γενικές συμβουλές διατροφής/τρόπου ζωής σχετικές με τις παθήσεις του, "
    "ευκαιρίες φροντίδας & ηθικού cross-sell (OTC, συμπληρώματα, μετρήσεις, υπηρεσίες φαρμακείου), και "
    "σημεία προσοχής (κενά συμμόρφωσης, πιθανές αλληλεπιδράσεις που αξίζει να ελεγχθούν). "
    "ΣΗΜΑΝΤΙΚΟ: ΜΗΝ δίνεις διάγνωση ούτε αλλαγή φαρμακευτικής αγωγής. Οι συμβουλές είναι ΓΕΝΙΚΕΣ και "
    "ΔΕΝ υποκαθιστούν την ιατρική γνώμη. Γράψε στα ελληνικά, απλά και στοχευμένα· κάθε στοιχείο λίστας "
    "να είναι μία σύντομη, συγκεκριμένη πρόταση. ΜΕΓΙΣΤΟ 4 στοιχεία ανά λίστα."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "2-3 προτάσεις συνολική εικόνα & προτεραιότητα"},
        "approach": {"type": "array", "items": {"type": "string"},
                     "description": "έως 4: πώς να αντιμετωπίσει/προσεγγίσει τον συγκεκριμένο πελάτη"},
        "lifestyle": {"type": "array", "items": {"type": "string"},
                      "description": "έως 4: γενικές συμβουλές διατροφής/τρόπου ζωής για τις παθήσεις του"},
        "opportunities": {"type": "array", "items": {"type": "string"},
                          "description": "έως 4: ευκαιρίες φροντίδας & ηθικού cross-sell"},
        "watch": {"type": "array", "items": {"type": "string"},
                  "description": "έως 4: σημεία προσοχής (συμμόρφωση, αλληλεπιδράσεις προς έλεγχο)"},
    },
    "required": ["summary", "approach", "lifestyle", "opportunities"],
    "additionalProperties": False,
}


async def advise(facts: dict) -> dict:
    c = await pharmacat_service._config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not c["enabled"]:
        return {"ok": False, "error": "disabled"}

    import anthropic

    out_cfg: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if c["model"] != "claude-haiku-4-5":  # effort param errors on Haiku 4.5
        out_cfg["effort"] = "low"
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    prompt = "ΕΙΚΟΝΑ ΠΕΛΑΤΗ:\n" + json.dumps(facts, ensure_ascii=False, indent=2)
    try:
        resp = await client.messages.create(
            model=c["model"], max_tokens=3000, system=SYSTEM,
            messages=[{"role": "user", "content": prompt}], output_config=out_cfg)
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"api_error:{e.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"unavailable:{type(e).__name__}"}

    text = next((b.text for b in resp.content if b.type == "text"), "").strip()
    if text.startswith("```"):  # defensive: strip markdown fences if a model adds them
        text = text.split("```")[1].removeprefix("json").strip() if "```" in text[3:] else text.strip("`")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"parse_error:{resp.stop_reason}"}
    data["ok"] = True
    return data
