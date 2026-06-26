"""Order & delivery circuit — orders the patient places from the pharmacy's own catalog (OTC +
parapharmacy), like phoning the pharmacy, optionally delivered to the patient's address with their
courier authorization. The selling pharmacy fulfils; prices are RE-COMPUTED server-side from the
catalog (never trust the client). Prescription items are NOT here — they use the reservation flow.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository

_OPEN = ("new", "preparing", "ready", "shipped")
STATUS_LABELS = {
    "new": "Νέα", "preparing": "Σε ετοιμασία", "ready": "Έτοιμη για παραλαβή",
    "shipped": "Καθ' οδόν", "delivered": "Παραδόθηκε", "cancelled": "Ακυρώθηκε",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


class OrdersDeliveryRepository(BaseRepository):
    collection_name = "orders_delivery"

    # ── per-pharmacy delivery settings ──────────────────────────────────────
    async def settings(self) -> dict:
        d = await self._db["order_settings"].find_one({"tenant_id": self.tenant_id}) or {}
        return {
            # Αποστολή ΚΛΕΙΣΤΗ by default — ενεργοποιείται σκόπιμα ανά φαρμακείο. Παραλαβή ανοιχτή.
            "delivery_enabled": d.get("delivery_enabled", False),
            "pickup_enabled": d.get("pickup_enabled", True),
            "delivery_fee_cents": d.get("delivery_fee_cents", 250),
            "free_over_cents": d.get("free_over_cents", 0),     # 0 = no free threshold
            "pps_cert": d.get("pps_cert", ""),                  # ΠΦΣ-certified e-pharmacy reference (EU logo)
            "min_order_cents": d.get("min_order_cents", 0),
            # Επιπλέον έκπτωση (μόνο παραφάρμακα) για επαναλαμβανόμενες παραγγελίες/συνδρομές.
            "subscription_discount_pct": d.get("subscription_discount_pct", 0),
            "subscription_enabled": d.get("subscription_enabled", True),
        }

    async def save_settings(self, cfg: dict) -> dict:
        clean = {
            "delivery_enabled": bool(cfg.get("delivery_enabled", False)),
            "pickup_enabled": bool(cfg.get("pickup_enabled", True)),
            "delivery_fee_cents": max(0, int(cfg.get("delivery_fee_cents") or 0)),
            "free_over_cents": max(0, int(cfg.get("free_over_cents") or 0)),
            "min_order_cents": max(0, int(cfg.get("min_order_cents") or 0)),
            "pps_cert": str(cfg.get("pps_cert") or "")[:300],
            "subscription_discount_pct": max(0, min(90, int(cfg.get("subscription_discount_pct") or 0))),
            "subscription_enabled": bool(cfg.get("subscription_enabled", True)),
            "updated_at": _now(),
        }
        await self._db["order_settings"].update_one(
            {"tenant_id": self.tenant_id}, {"$set": {**clean, "tenant_id": self.tenant_id}}, upsert=True)
        return await self.settings()

    # ── patient places an order ─────────────────────────────────────────────
    async def create_order(self, *, account_id, patient_ref: str | None, patient_name: str,
                           patient_phone: str, lines: list[dict], mode: str, address: dict | None,
                           courier_authorized: bool, gdpr_consent: bool,
                           sub_discount_pct: int = 0, subscription_id: str | None = None) -> dict:
        if not gdpr_consent:
            return {"ok": False, "error": "consent_required"}
        if mode == "delivery" and not courier_authorized:
            return {"ok": False, "error": "courier_auth_required"}
        cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
        items: list[dict] = []
        subtotal = 0
        has_medicine = False
        for ln in lines:
            prod = await cat.get(str(ln.get("barcode")))
            qty = max(1, int(ln.get("qty") or 1))
            if not prod or not prod.get("active", True) or prod.get("stock_qty", 0) < qty:
                return {"ok": False, "error": "unavailable", "barcode": ln.get("barcode")}
            unit = int(prod["price_cents"])
            if prod.get("type") == "otc_medicine":
                disc = 0                                    # φάρμακα: ποτέ έκπτωση
                has_medicine = True
            else:                                           # παραφάρμακα: + έκπτωση συνδρομής
                disc = min(90, int(prod.get("discount_pct") or 0) + max(0, int(sub_discount_pct)))
            line_cents = round(unit * qty * (100 - disc) / 100)
            subtotal += line_cents
            items.append({"barcode": prod["barcode"], "name": prod["name"], "qty": qty,
                          "unit_cents": unit, "discount_pct": disc, "line_cents": line_cents,
                          "type": prod.get("type")})
        if not items:
            return {"ok": False, "error": "empty"}
        st = await self.settings()
        if mode == "delivery" and not st.get("delivery_enabled"):
            return {"ok": False, "error": "delivery_disabled"}
        if mode == "pickup" and not st.get("pickup_enabled"):
            return {"ok": False, "error": "pickup_disabled"}
        if subtotal < st["min_order_cents"]:
            return {"ok": False, "error": "below_min", "min_cents": st["min_order_cents"]}
        fee = 0
        if mode == "delivery":
            fee = 0 if (st["free_over_cents"] and subtotal >= st["free_over_cents"]) else st["delivery_fee_cents"]
        doc = {
            "tenant_id": self.tenant_id, "account_id": account_id, "patient_ref": patient_ref,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "items": items, "subtotal_cents": subtotal, "delivery_fee_cents": fee,
            "total_cents": subtotal + fee, "mode": mode,
            "address": address if mode == "delivery" else None,
            "courier_authorized": bool(courier_authorized), "gdpr_consent": True,
            "has_medicine": has_medicine, "status": "new", "subscription_id": subscription_id,
            "status_history": [{"status": "new", "at": _now()}],
            "created_at": _now(), "updated_at": _now(),
        }
        res = await self.insert_one(doc)
        # επιβεβαίωση παραλαβής παραγγελίας (1ο στάδιο) — μετά ακολουθούν push σε κάθε αλλαγή status
        if account_id:
            from app.services import push_service
            await push_service.send_to_account(
                account_id, title="🛍️ Η παραγγελία σου ελήφθη",
                body="Στάλθηκε στο φαρμακείο σου. Θα ενημερώνεσαι σε κάθε βήμα.", url="/portal")
        return {"ok": True, "order_id": str(res), "total_cents": subtotal + fee}

    # ── subscriptions (recurring orders) ────────────────────────────────────
    async def create_subscription(self, *, account_id, patient_ref, patient_name, patient_phone,
                                  lines, mode, address, courier_authorized, interval_days) -> dict:
        from datetime import timedelta
        iv = max(7, int(interval_days))
        doc = {
            "tenant_id": self.tenant_id, "account_id": account_id, "patient_ref": patient_ref,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "lines": [{"barcode": str(ln.get("barcode")), "qty": max(1, int(ln.get("qty") or 1))} for ln in lines],
            "mode": mode, "address": address, "courier_authorized": bool(courier_authorized),
            "interval_days": iv, "active": True, "next_run": _now() + timedelta(days=iv),
            "created_at": _now(),
        }
        res = await self._db["order_subscriptions"].insert_one(doc)  # tenant-ok: tenant_id in doc/queries
        return {"ok": True, "subscription_id": str(res.inserted_id)}

    async def my_subscriptions(self, account_id) -> list[dict]:
        rows = [r async for r in self._db["order_subscriptions"].find(
            {"tenant_id": self.tenant_id, "account_id": account_id, "active": True}).sort("created_at", -1)]
        return jsonsafe(rows)

    async def cancel_subscription(self, sub_id: str, account_id) -> dict:
        from bson import ObjectId
        try:
            oid = ObjectId(sub_id)
        except Exception:  # noqa: BLE001
            return {"ok": False}
        await self._db["order_subscriptions"].update_one(
            {"_id": oid, "tenant_id": self.tenant_id, "account_id": account_id},
            {"$set": {"active": False, "cancelled_at": _now()}})
        return {"ok": True}

    async def run_subscription(self, sub: dict) -> dict:
        """Create the next order for a due subscription + advance next_run (called by the beat)."""
        from datetime import timedelta
        st = await self.settings()
        res = await self.create_order(
            account_id=sub.get("account_id"), patient_ref=sub.get("patient_ref"),
            patient_name=sub.get("patient_name", ""), patient_phone=sub.get("patient_phone", ""),
            lines=sub.get("lines", []), mode=sub.get("mode", "pickup"), address=sub.get("address"),
            courier_authorized=sub.get("courier_authorized", False), gdpr_consent=True,
            sub_discount_pct=st.get("subscription_discount_pct", 0), subscription_id=str(sub["_id"]))
        nxt = _now() + timedelta(days=int(sub.get("interval_days", 30)))
        await self._db["order_subscriptions"].update_one(
            {"_id": sub["_id"]}, {"$set": {"next_run": nxt, "last_run": _now(),
                                           "last_result": "ok" if res.get("ok") else res.get("error")}})
        return res

    async def my_orders(self, account_id) -> list[dict]:
        from app.repositories.patient_portal import _oid
        rows = await self.find({"account_id": account_id}, sort=[("created_at", -1)], limit=50)
        if not rows:
            rows = await self.find({"account_id": _oid(account_id)}, sort=[("created_at", -1)], limit=50)
        return jsonsafe(rows)

    # ── pharmacist side ─────────────────────────────────────────────────────
    async def list_orders(self, *, status: str | None = None, limit: int = 100) -> list[dict]:
        q: dict = {}
        if status == "open":
            q["status"] = {"$in": list(_OPEN)}
        elif status:
            q["status"] = status
        return jsonsafe(await self.find(q, sort=[("created_at", -1)], limit=limit))

    async def pending_count(self) -> int:
        return await self.count({"status": {"$in": ["new", "preparing"]}})

    async def set_status(self, order_id: str, status: str) -> dict:
        from bson import ObjectId
        if status not in STATUS_LABELS:
            return {"ok": False, "error": "bad_status"}
        try:
            oid = ObjectId(order_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        order = await self.find_one({"_id": oid})
        if not order:
            return {"ok": False, "error": "not_found"}
        await self.update_one({"_id": oid}, {"$set": {"status": status, "updated_at": _now()},
                                             "$push": {"status_history": {"status": status, "at": _now()}}})
        # notify the patient
        if order.get("account_id"):
            from app.services import push_service
            msg = {"preparing": "Η παραγγελία σου ετοιμάζεται.",
                   "ready": "Η παραγγελία σου είναι έτοιμη για παραλαβή! 📦",
                   "shipped": "Η παραγγελία σου είναι καθ' οδόν! 🚚",
                   "delivered": "Η παραγγελία σου παραδόθηκε. Ευχαριστούμε!",
                   "cancelled": "Η παραγγελία σου ακυρώθηκε."}.get(status)
            if msg:
                await push_service.send_to_account(order["account_id"],
                                                   title="🛍️ Παραγγελία φαρμακείου", body=msg, url="/portal")
        return {"ok": True, "status": status}
