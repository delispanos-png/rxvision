"""Optical audit OCR pipeline — self-hosted Tesseract (+Greek) + zbar barcode/QR decoding.

Pure functions (no DB): preprocess an image, run OCR, decode barcodes, extract the prescription
barcode / date, and score image quality. Data-matching + optical-risk live in the scan repo.
Deps (Pillow/pytesseract/pyzbar + tesseract-ocr-ell/libzbar0) are installed in the backend image.
"""

from __future__ import annotations

import io
import re
import statistics

# ΗΔΙΚΑ prescription barcodes are long numeric strings (≈13+ digits). Match a digit run even when
# OCR glues it to adjacent (Greek) letters — so no \b, just digit-run boundaries.
_BARCODE_RE = re.compile(r"(?<!\d)(\d{11,16})(?!\d)")
_DATE_RE = re.compile(r"\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b")


def _preprocess(img_bytes: bytes):
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(img_bytes))
    img = ImageOps.exif_transpose(img)              # auto-rotate from EXIF
    gray = ImageOps.grayscale(img)
    gray = ImageOps.autocontrast(gray)              # contrast enhancement
    return img, gray


def _quality(gray) -> int:
    """0-100 sharpness proxy via edge-variance (low = blurry)."""
    from PIL import ImageFilter
    edges = gray.filter(ImageFilter.FIND_EDGES)
    data = list(edges.getdata())
    if not data:
        return 0
    var = statistics.pvariance(data)
    return max(0, min(100, round(var / 30)))        # ~heuristic scale


def analyze(img_bytes: bytes) -> dict:
    """Returns {ok, text, barcodes, rx_barcode, date, quality, error}."""
    try:
        import pytesseract
        from pyzbar import pyzbar
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"ocr_unavailable:{type(e).__name__}"}
    try:
        img, gray = _preprocess(img_bytes)
        text = pytesseract.image_to_string(gray, lang="ell+eng") or ""
        codes = []
        for b in pyzbar.decode(img):
            try:
                codes.append({"type": b.type, "data": b.data.decode("utf-8", "ignore")})
            except Exception:  # noqa: BLE001
                pass
        # prefer a decoded barcode; else fall back to a numeric run in the OCR text
        rx_barcode = next((c["data"] for c in codes if c["data"].isdigit() and len(c["data"]) >= 11), None)
        if not rx_barcode:
            m = _BARCODE_RE.search(text.replace(" ", ""))
            rx_barcode = m.group(1) if m else None
        dm = _DATE_RE.search(text)
        return {"ok": True, "text": text[:4000], "barcodes": codes,
                "rx_barcode": rx_barcode, "date": dm.group(1) if dm else None,
                "quality": _quality(gray)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"ocr_error:{type(e).__name__}"}
