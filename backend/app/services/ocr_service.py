"""Optical audit OCR pipeline — self-hosted Tesseract (+Greek) + zbar barcode/QR decoding.

Pure functions (no DB): preprocess an image, run OCR, decode barcodes, extract the prescription
barcode / date, and score image quality. Data-matching + optical-risk live in the scan repo.
Deps (Pillow/pytesseract/pyzbar + tesseract-ocr-ell/libzbar0) are installed in the backend image.
"""

from __future__ import annotations

import io
import re
import statistics

# Decompression-bomb guard: cap the pixel count Pillow will decode (a tiny file can declare a
# huge canvas). Beyond this, Image.open raises DecompressionBombError instead of exhausting RAM.
try:
    from PIL import Image as _PILImage

    _PILImage.MAX_IMAGE_PIXELS = 64_000_000  # ~64 MP
except Exception:  # noqa: BLE001 — Pillow always present in the worker image; never block import
    pass

# ΗΔΙΚΑ prescription barcodes are long numeric strings (≈13+ digits). Match a digit run even when
# OCR glues it to adjacent (Greek) letters — so no \b, just digit-run boundaries.
_BARCODE_RE = re.compile(r"(?<!\d)(\d{11,16})(?!\d)")
_DATE_RE = re.compile(r"\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b")


def _preprocess(img_bytes: bytes):
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(img_bytes))
    img = ImageOps.exif_transpose(img)              # auto-rotate from EXIF
    img.thumbnail((2200, 2200))                     # cap size: phone photos are huge → OCR/zbar χρόνος
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


def visual_compliance(img_bytes: bytes) -> dict:
    """Heuristic visual check (no ML): colored-ink blobs → likely stamp/signature ink; dense ink
    marks in the lower region → likely a signature. Flags for human review, not definitive."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        img.thumbnail((1000, 1000))
        w, h = img.size
        total = max(w * h, 1)
        # colored ink (stamps/coloured signatures): high SATURATION alone separates it — white and
        # black both have ~0 saturation, only coloured ink is saturated (regardless of brightness).
        _, s, _v = img.convert("HSV").split()
        colored = s.point(lambda p: 255 if p > 100 else 0)
        colored_ratio = colored.histogram()[255] / total
        # ink density in the lower 40% (signature zone)
        gray = img.convert("L")
        bottom = gray.crop((0, int(h * 0.6), w, h))
        bt = max(bottom.size[0] * bottom.size[1], 1)
        dark = bottom.point(lambda p: 255 if p < 110 else 0)
        ink_ratio = dark.histogram()[255] / bt
        return {
            "stamp": colored_ratio > 0.003,             # ≥0.3% coloured ink
            "colored_ratio": round(colored_ratio * 100, 2),
            "signature": ink_ratio > 0.010,             # handwriting marks in the signature zone
            "ink_ratio": round(ink_ratio * 100, 2),
        }
    except Exception as e:  # noqa: BLE001
        return {"stamp": None, "signature": None, "error": f"vc_error:{type(e).__name__}"}


def analyze(img_bytes: bytes) -> dict:
    """Returns {ok, text, barcodes, rx_barcode, date, quality, visual, error}."""
    try:
        import pytesseract
        from pyzbar import pyzbar
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"ocr_unavailable:{type(e).__name__}"}
    try:
        img, gray = _preprocess(img_bytes)
        # 1) FAST PATH: decode barcode/QR (zbar, ms) — αυτό αρκεί για την αντιστοίχιση.
        #    Δοκιμάζουμε ΠΛΗΡΗ ανάλυση πρώτα (καλύτερη ακρίβεια), μετά τη σμικρυμένη.
        from PIL import Image, ImageOps
        try:
            full = ImageOps.exif_transpose(Image.open(io.BytesIO(img_bytes)))
        except Exception:  # noqa: BLE001
            full = img
        codes = []
        for src in (full, img):
            for b in pyzbar.decode(src):
                try:
                    codes.append({"type": b.type, "data": b.data.decode("utf-8", "ignore")})
                except Exception:  # noqa: BLE001
                    pass
            if codes:
                break
        rx_barcode = next((c["data"] for c in codes if c["data"].isdigit() and len(c["data"]) >= 11), None)
        # 2) Το ΑΚΡΙΒΟ Tesseract τρέχει ΜΟΝΟ όταν δεν διαβάστηκε barcode (fallback), με hard
        #    timeout ώστε να μην κολλάει ποτέ σε λεπτά. Έτσι το bulk scan με καθαρά barcode = γρήγορο.
        text = ""
        if not rx_barcode:
            try:
                text = pytesseract.image_to_string(
                    gray, lang="ell+eng", config="--oem 1 --psm 6", timeout=20) or ""
            except Exception:  # noqa: BLE001 — timeout/άλλο → συνεχίζουμε χωρίς κείμενο
                text = ""
            m = _BARCODE_RE.search(text.replace(" ", ""))
            rx_barcode = m.group(1) if m else None
        dm = _DATE_RE.search(text) if text else None
        return {"ok": True, "text": text[:4000], "barcodes": codes,
                "rx_barcode": rx_barcode, "date": dm.group(1) if dm else None,
                "quality": _quality(gray), "visual": visual_compliance(img_bytes)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"ocr_error:{type(e).__name__}"}
