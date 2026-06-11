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


def _score_and_flags(ocr: dict, matched: str | None) -> tuple[int, list[str]]:
    if not ocr.get("ok"):
        return 100, ["ocr_failed"]
    score, flags = 0, []
    if not ocr.get("rx_barcode"):
        score += 30; flags.append("missing_coupon")     # no QR/barcode detected
    elif not matched:
        score += 40; flags.append("data_mismatch")       # barcode found but no execution match
    if (ocr.get("quality") or 0) < 25:
        score += 20; flags.append("image_quality")
    if len((ocr.get("text") or "").strip()) < 20:
        score += 15; flags.append("low_text")
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
            ex = await self._db["prescription_executions"].find_one(
                {"tenant_id": self.tenant_id, "external_id": {"$regex": f"^{bc}"}})  # tenant-ok: scoped by tenant_id
            if ex:
                matched = str(ex.get("external_id"))
        score, flags = _score_and_flags(ocr, matched)
        await self._coll.update_one({"_id": s["_id"], "tenant_id": self.tenant_id}, {"$set": {
            "status": "done",
            "ocr": {k: ocr.get(k) for k in ("rx_barcode", "date", "quality", "barcodes", "ok", "error")},
            "ocr_text": (ocr.get("text") or "")[:2000],
            "matched_execution": matched, "optical_risk": score, "band": _band(score),
            "flags": flags, "processed_at": _now()}})

    async def queue(self) -> list[dict]:
        rows = [s async for s in self._coll.find({"tenant_id": self.tenant_id})
                .sort("uploaded_at", -1).limit(200)]
        return jsonsafe([{
            "scan_id": str(s["_id"]), "filename": s.get("filename"), "doc_type": s.get("doc_type"),
            "status": s.get("status"), "uploaded_at": s.get("uploaded_at"),
            "optical_risk": s.get("optical_risk"), "band": s.get("band"),
            "flags": s.get("flags", []), "matched": s.get("matched_execution"),
            "barcode": (s.get("ocr") or {}).get("rx_barcode"),
            "quality": (s.get("ocr") or {}).get("quality"),
        } for s in rows])
