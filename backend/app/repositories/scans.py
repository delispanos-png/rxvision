"""Optical audit scans — store the photo in GridFS (our own infra, GDPR-friendly), run the OCR
pipeline, match the decoded barcode against executions, and score optical risk."""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from motor.motor_asyncio import AsyncIOMotorGridFSBucket

from app.repositories.base import BaseRepository, jsonsafe
from app.services import ocr_service


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


def _score_and_flags(ocr: dict, matched: str | None, coupons: dict) -> tuple[int, list[str]]:
    """Risk from the AUTHORITATIVE data (how many meds executed & their QR/ΕΟΦ coupons) — NOT from
    the unreliable OCR ink-heuristics. Signature/stamp are shown as a soft hint only and do NOT
    drive the band (the pharmacist confirms visually / marks «σύννομη»)."""
    if not ocr.get("ok"):
        return 100, ["ocr_failed"]
    score, flags = 0, []
    if not ocr.get("rx_barcode"):
        score += 15; flags.append("barcode_unread")      # couldn't decode the Rx barcode → manual match
    elif not matched:
        score += 40; flags.append("data_mismatch")       # barcode found but no execution match
    # κουπόνια: flag ΜΟΝΟ αν εκτελέστηκαν φάρμακα και ΚΑΝΕΝΑ δεν έχει QR/ΕΟΦ στα δεδομένα μας
    if matched and coupons.get("meds", 0) > 0 and (coupons.get("qr", 0) + coupons.get("eof", 0)) == 0:
        score += 25; flags.append("missing_coupon")
    if (ocr.get("quality") or 0) < 25:
        score += 20; flags.append("image_quality")
    if len((ocr.get("text") or "").strip()) < 20:
        score += 10; flags.append("low_text")
    return min(score, 100), flags


def _band(s: int) -> str:
    return "high_risk" if s >= 50 else "needs_review" if s >= 25 else "ok"


class ScanRepository(BaseRepository):
    collection_name = "prescription_scans"

    def _bucket(self) -> AsyncIOMotorGridFSBucket:
        return AsyncIOMotorGridFSBucket(self._db, bucket_name="scans")

    async def create(self, *, filename: str, content: bytes, content_type: str,
                     doc_type: str = "prescription") -> str:
        fid = await self._bucket().upload_from_stream(
            filename, content, metadata={"tenant_id": self.tenant_id})
        sid = ObjectId()
        await self._coll.insert_one({
            "_id": sid, "tenant_id": self.tenant_id, "filename": filename, "doc_type": doc_type,
            "image_id": fid, "content_type": content_type, "status": "processing",
            "uploaded_at": _now()})
        return str(sid)

    async def image(self, scan_id: str):
        oid = _oid(scan_id)
        s = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        if not s:
            return None, None
        stream = await self._bucket().open_download_stream(s["image_id"])
        return await stream.read(), s.get("content_type", "image/jpeg")

    async def delete(self, scan_id: str) -> bool:
        """Remove a scan: its doc + the stored image (GridFS). Tenant-scoped."""
        oid = _oid(scan_id)
        s = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        if not s:
            return False
        if s.get("image_id"):
            try:
                await self._bucket().delete(s["image_id"])
            except Exception:  # noqa: BLE001 — image may already be gone; delete the doc anyway
                pass
        await self._coll.delete_one({"_id": oid, "tenant_id": self.tenant_id})
        return True

    async def process(self, scan_id: str) -> None:
        oid = _oid(scan_id)
        s = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        if not s:
            return
        stream = await self._bucket().open_download_stream(s["image_id"])
        content = await stream.read()
        ocr = ocr_service.analyze(content)
        matched = None
        bc = ocr.get("rx_barcode")
        if ocr.get("ok") and bc and bc.isdigit():  # numeric → safe in regex
            # Το τυπωμένο barcode της ΗΔΥΚΑ φέρει 3 επιπλέον ψηφία encoding στο τέλος που
            # ΔΕΝ υπάρχουν στο barcode του συστήματος (external_id, ~13ψήφιο). Τα αφαιρούμε
            # για να γίνει η αντιστοίχιση. Δοκιμάζουμε και τις δύο μορφές για ασφάλεια.
            candidates = {bc}
            if len(bc) > 13:
                candidates.add(bc[:-3])
            ex = await self._db["prescription_executions"].find_one(
                {"tenant_id": self.tenant_id,                       # tenant-ok: scoped by tenant_id
                 "$or": [{"external_id": {"$regex": f"^{c}"}} for c in candidates]})
            if ex:
                matched = str(ex.get("external_id"))
        coupons = await self._coupons_summary(matched) if matched else {"meds": 0, "qr": 0, "eof": 0, "intangible": None, "items": []}
        score, flags = _score_and_flags(ocr, matched, coupons)
        await self._coll.update_one({"_id": s["_id"], "tenant_id": self.tenant_id}, {"$set": {
            "status": "done",
            "ocr": {k: ocr.get(k) for k in ("rx_barcode", "date", "quality", "barcodes", "ok", "error")},
            "ocr_text": (ocr.get("text") or "")[:2000], "visual": ocr.get("visual"),
            "matched_execution": matched, "coupons": coupons,
            "optical_risk": score, "band": _band(score),
            "flags": flags, "processed_at": _now()}})

    async def _coupons_summary(self, barcode: str) -> dict:
        """Authoritative coupons for the matched Rx FROM OUR DATA: how many meds executed and how
        many carry a QR vs an ΕΟΦ strip, plus whether the Rx is άυλη (electronic — no paper doctor
        signature needed). This is what the optical audit should judge — not OCR guesses."""
        bc = (barcode or "").split(":")[0].strip()
        if not bc or not bc.isdigit():
            return {"meds": 0, "qr": 0, "eof": 0, "intangible": None, "items": []}
        exs = [e async for e in self._db["prescription_executions"].find(
            {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{bc}"}}, {"_id": 1, "details": 1})]
        if not exs:
            return {"meds": 0, "qr": 0, "eof": 0, "intangible": None, "items": []}
        intangible = any((e.get("details") or {}).get("intangible") for e in exs)
        exec_ids = [e["_id"] for e in exs]
        meds = qr = eof = 0
        items: list = []
        async for it in self._db["prescription_items"].find(
                {"tenant_id": self.tenant_id, "execution_id": {"$in": exec_ids},
                 "is_executed": {"$ne": False}}):
            d = it.get("details") or {}
            has_qr = bool(d.get("qr") or d.get("qr_product_code"))
            has_eof = bool(d.get("strip")) and not has_qr
            if not (has_qr or has_eof):
                for c in (d.get("coupons") or []):
                    if c.get("qr") or c.get("qr_product_code"):
                        has_qr = True
                    elif c.get("strip"):
                        has_eof = True
            prod = await self._db["products"].find_one(
                {"_id": it.get("product_id")}, {"name": 1}) if it.get("product_id") else None
            meds += 1
            if has_qr:
                qr += 1
            elif has_eof:
                eof += 1
            items.append({"name": (prod or {}).get("name"),
                          "type": "qr" if has_qr else "eof" if has_eof else None})
        return {"meds": meds, "qr": qr, "eof": eof, "intangible": intangible, "items": items}

    async def set_review(self, scan_id: str, ok: bool) -> dict:
        """Pharmacist's manual verdict after looking at the image (the reliable signal for
        signature/stamp, which OCR can't judge). Stored separately from the auto-score."""
        oid = _oid(scan_id)
        if not oid:
            return {"ok": False}
        await self._coll.update_one(
            {"_id": oid, "tenant_id": self.tenant_id},
            {"$set": {"reviewed_ok": bool(ok), "reviewed_at": _now()}})
        return {"ok": True, "reviewed_ok": bool(ok)}

    async def queue(self) -> list[dict]:
        rows = [s async for s in self._coll.find({"tenant_id": self.tenant_id})
                .sort("uploaded_at", -1).limit(200)]
        return jsonsafe([{
            "scan_id": str(s["_id"]), "filename": s.get("filename"), "doc_type": s.get("doc_type"),
            "status": s.get("status"), "uploaded_at": s.get("uploaded_at"),
            "optical_risk": s.get("optical_risk"), "band": s.get("band"),
            "flags": s.get("flags", []), "matched": s.get("matched_execution"),
            "coupons": s.get("coupons"), "reviewed_ok": s.get("reviewed_ok"),
            "barcode": (s.get("ocr") or {}).get("rx_barcode"),
            "quality": (s.get("ocr") or {}).get("quality"),
            "signature": (s.get("visual") or {}).get("signature"),
            "stamp": (s.get("visual") or {}).get("stamp"),
        } for s in rows])
