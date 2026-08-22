"""Ρυθμίσεις προμηθευτών ανά φαρμακείο — π.χ. B2B credentials Profarm για αντιστοίχιση φωτο ανά barcode.
Ο κωδικός αποθηκεύεται ΚΡΥΠΤΟΓΡΑΦΗΜΕΝΟΣ (platform_secrets). Χρήση: back-office (staff), όχι πελάτες."""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class SupplierSettingsRepository(BaseRepository):
    collection_name = "supplier_settings"

    async def get_profarm(self) -> dict:
        """Κατάσταση για το UI — ΠΟΤΕ τον κωδικό."""
        d = await self.find_one({"key": "profarm"}) or {}
        return {"configured": bool(d.get("username") and d.get("password")),
                "username": d.get("username") or ""}

    async def save_profarm(self, username: str, password: str) -> dict:
        from app.services.platform_secrets import penc
        u = (username or "").strip()[:120]
        if not u:
            return {"ok": False, "error": "no_username"}
        upd = {"username": u, "updated_at": _now()}
        if password:                       # κενός κωδικός = διατήρησε τον υπάρχοντα
            upd["password"] = penc(password)
        await self.update_one({"key": "profarm"},
                              {"$set": upd, "$setOnInsert": {"key": "profarm", "created_at": _now()}},
                              upsert=True)
        return {"ok": True}

    async def profarm_creds(self) -> dict | None:
        """Αποκρυπτογραφημένα creds για server-side χρήση. Ποτέ στο UI."""
        from app.services.platform_secrets import pdec
        d = await self.find_one({"key": "profarm"}) or {}
        if not (d.get("username") and d.get("password")):
            return None
        return {"username": d["username"], "password": pdec(d["password"])}

    async def delete_profarm(self) -> dict:
        await self.delete_many({"key": "profarm"})
        return {"ok": True}
