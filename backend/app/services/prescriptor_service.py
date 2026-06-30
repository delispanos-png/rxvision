"""Prescriptor — AI that *reads* a prescription/coupon photo the way a pharmacist's eye does.

Powered by Claude vision (claude-opus-4-8). It extracts the structured content of the paper —
insured person, doctor, drugs & quantities, coupons/barcodes, signatures & stamps — and flags the
visual inconsistencies that easily slip past the human eye at peak hours. The *cross-check* against
the authoritative ΗΔΥΚΑ data (and the final verdict) lives in the scan repo: the AI reads the paper,
the system compares it to the digital truth, and the pharmacist gets a ready verdict.

GDPR note: this sends the prescription image (health PII) to the Anthropic API. It is therefore
OPT-IN — it runs ONLY when the pharmacy has configured & enabled the Anthropic key (same consent as
PharmaCat). With no key it cleanly reports `not_configured` and the cheap self-hosted OCR is used.

The Anthropic key lives in `platform_settings._id='anthropic'` (entered in admin) — never in git/logs.
"""

from __future__ import annotations

import base64
import io
import json

from app.core.db import shared_db

_DEFAULT_MODEL = "claude-opus-4-8"
# All three are vision-capable. Opus best for messy handwriting/stamps; Sonnet ~6× cheaper.
ALLOWED_MODELS = ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5")

SYSTEM = """Είσαι το «Prescriptor», ο ψηφιακός οφθαλμός ενός ελληνικού φαρμακείου. Βλέπεις τη
ΦΩΤΟΓΡΑΦΙΑ μιας εκτελεσμένης συνταγής / κουπονιού / γνωμάτευσης και τη ΔΙΑΒΑΖΕΙΣ με την ακρίβεια
έμπειρου φαρμακοποιού που ελέγχει για κατάθεση στον ΕΟΠΥΥ.

ΑΠΟΣΤΟΛΗ: κατέγραψε ΜΟΝΟ ό,τι ΠΡΑΓΜΑΤΙΚΑ βλέπεις στο χαρτί — μην μαντεύεις, μην συμπληρώνεις από
υπόθεση. Αν κάτι δεν φαίνεται ή δεν διαβάζεται, άφησέ το κενό / false. Σκοπός σου είναι να πιάσεις
τις ασυνέπειες που ξεφεύγουν εύκολα από το ανθρώπινο μάτι σε ώρες αιχμής.

ΤΙ ΝΑ ΔΙΑΒΑΣΕΙΣ:
- Ασφαλισμένος: ονοματεπώνυμο, ΑΜΚΑ (όπως τυπώνεται).
- Ιατρός: ονοματεπώνυμο, ειδικότητα.
- Ημερομηνία έκδοσης/εκτέλεσης (όπως τυπώνεται, μορφή ΗΗ/ΜΜ/ΕΕΕΕ).
- Barcode συνταγής (το μεγάλο αριθμητικό, συνήθως 13+ ψηφία).
- Φάρμακα: ΓΙΑ ΚΑΘΕ γραμμή → εμπορική ονομασία (όπως τυπώνεται) και ΠΟΣΟΤΗΤΑ (τεμάχια). Αν δίπλα
  στο φάρμακο υπάρχει κολλημένο κουπόνι/sticker ΕΟΦ ή τυπωμένο QR, σημείωσέ το.
- Κουπόνια: πόσα φυσικά κουπόνια/stickers βλέπεις συνολικά, πόσα έχουν barcode, πόσα έχουν QR.
- Υπογραφές: υπάρχει χειρόγραφη υπογραφή ιατρού; φαρμακοποιού; ασθενούς (παραλαβής);
- Σφραγίδες: σφραγίδα ιατρού; σφραγίδα φαρμακείου;
- ΑΣΥΝΕΠΕΙΕΣ (anomalies): οτιδήποτε ύποπτο — σβησίματα/διορθώσεις σε ποσότητα, αλλοιωμένη
  ημερομηνία, μουτζούρες πάνω σε barcode, κουπόνι που δεν ταιριάζει, διπλό/θαμπό σκανάρισμα,
  λείπει υπογραφή/σφραγίδα όπου φαίνεται απαραίτητη. Γράψε σύντομες ελληνικές φράσεις.

ΜΟΡΦΗ: Επιστρέφεις ΠΑΝΤΑ έγκυρο JSON σύμφωνα με το παρεχόμενο schema. Στα boolean (υπογραφές/
σφραγίδες) βάζεις true ΜΟΝΟ αν το βλέπεις καθαρά, false αν σαφώς λείπει. Αν η εικόνα είναι αδιάβαστη
βάλε readable=false και εξήγησε στο notes."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["readable", "doc_type", "patient", "doctor", "date", "rx_barcode",
                 "medicines", "coupons", "signatures", "stamps", "anomalies", "notes"],
    "properties": {
        "readable": {"type": "boolean"},
        "doc_type": {"type": "string", "enum": ["prescription", "coupon", "opinion", "other"]},
        "patient": {"type": "object", "additionalProperties": False, "required": ["name", "amka"],
                    "properties": {"name": {"type": "string"}, "amka": {"type": "string"}}},
        "doctor": {"type": "object", "additionalProperties": False, "required": ["name", "specialty"],
                   "properties": {"name": {"type": "string"}, "specialty": {"type": "string"}}},
        "date": {"type": "string"},
        "rx_barcode": {"type": "string"},
        "medicines": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["name", "quantity", "coupon", "qr"],
            "properties": {"name": {"type": "string"}, "quantity": {"type": "integer"},
                           "coupon": {"type": "boolean"}, "qr": {"type": "boolean"}}}},
        "coupons": {"type": "object", "additionalProperties": False,
                    "required": ["count", "with_barcode", "with_qr"],
                    "properties": {"count": {"type": "integer"}, "with_barcode": {"type": "integer"},
                                   "with_qr": {"type": "integer"}}},
        "signatures": {"type": "object", "additionalProperties": False,
                       "required": ["doctor", "pharmacist", "patient"],
                       "properties": {"doctor": {"type": "boolean"}, "pharmacist": {"type": "boolean"},
                                      "patient": {"type": "boolean"}}},
        "stamps": {"type": "object", "additionalProperties": False,
                   "required": ["doctor", "pharmacy"],
                   "properties": {"doctor": {"type": "boolean"}, "pharmacy": {"type": "boolean"}}},
        "anomalies": {"type": "array", "items": {"type": "string"}},
        "notes": {"type": "string"},
    },
}

# media types the Anthropic image block accepts directly; everything else we transcode to JPEG.
_NATIVE_IMG = {"image/jpeg", "image/png", "image/gif", "image/webp"}


async def _config() -> dict:
    cfg = await shared_db()["platform_settings"].find_one({"_id": "anthropic"}) or {}
    model = cfg.get("vision_model") or cfg.get("model")
    model = model if model in ALLOWED_MODELS else _DEFAULT_MODEL
    # Prescriptor is a separate opt-in from PharmaCat chat: default ON when a key exists, but a
    # pharmacy can disable just the image-reading (GDPR) while keeping the chat assistant.
    return {"api_key": cfg.get("api_key"), "enabled": cfg.get("enabled", True),
            "prescriptor": cfg.get("prescriptor", True), "model": model}


async def status() -> dict:
    c = await _config()
    return {"configured": bool(c["api_key"]), "enabled": bool(c["enabled"] and c["prescriptor"]),
            "model": c["model"]}


def _as_block(content: bytes, content_type: str) -> dict:
    """Turn the stored bytes into an Anthropic content block: native image, PDF document, or a
    Pillow-transcoded JPEG for HEIC/TIFF/BMP (which the API won't take directly)."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct == "application/pdf":
        return {"type": "document",
                "source": {"type": "base64", "media_type": "application/pdf",
                           "data": base64.b64encode(content).decode()}}
    if ct in _NATIVE_IMG:
        media, data = ct, content
    else:  # HEIC/HEIF/TIFF/BMP/unknown → transcode to JPEG (Pillow is in the worker image)
        from PIL import Image, ImageOps
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGB")
        img.thumbnail((2200, 2200))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        media, data = "image/jpeg", buf.getvalue()
    return {"type": "image",
            "source": {"type": "base64", "media_type": media, "data": base64.b64encode(data).decode()}}


async def read(content: bytes, content_type: str) -> dict:
    """Read one document image. Returns the structured reading (see SCHEMA) with ok=True, or
    {ok: False, error} when not configured / disabled / the API failed."""
    c = await _config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not (c["enabled"] and c["prescriptor"]):
        return {"ok": False, "error": "disabled"}

    import anthropic

    try:
        block = _as_block(content, content_type)
    except Exception as e:  # noqa: BLE001 — unreadable bytes → let the cheap OCR carry it
        return {"ok": False, "error": f"decode_error:{type(e).__name__}"}

    model = c["model"]
    out_cfg: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if model != "claude-haiku-4-5":   # effort param errors on Haiku 4.5
        out_cfg["effort"] = "medium"
    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=3072,
            system=SYSTEM,
            messages=[{"role": "user", "content": [
                block,
                {"type": "text", "text": "Διάβασε αυτό το έγγραφο και επίστρεψε το δομημένο JSON."},
            ]}],
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
        return {"ok": False, "error": "parse_error"}
    data["ok"] = True
    return data
