"""Order & delivery circuit — orders the patient places from the pharmacy's own catalog (OTC +
parapharmacy), like phoning the pharmacy, optionally delivered to the patient's address with their
courier authorization. The selling pharmacy fulfils; prices are RE-COMPUTED server-side from the
catalog (never trust the client). Prescription items are NOT here — they use the reservation flow.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
from app.repositories.shop_campaigns import ShopCampaignRepository, campaign_pct_for
from app.repositories.shop_promos import ShopBundleRepository, ShopCouponRepository
from app.services.shop_pricing import bundle_savings, coupon_discount, tier_discount

_OPEN = ("pending", "new", "preparing", "ready", "shipped")
STATUS_LABELS = {
    "pending": "Σε αναμονή έγκρισης", "new": "Νέα", "preparing": "Σε ετοιμασία",
    "ready": "Έτοιμη για παραλαβή", "shipped": "Καθ' οδόν", "delivered": "Παραδόθηκε",
    "declined": "Απορρίφθηκε", "cancelled": "Ακυρώθηκε",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _clean_tiers(v) -> list[dict]:
    """Κλίμακες καλαθιού → ταξινομημένες, χωρίς διπλά όρια, με λογικά όρια τιμών."""
    out: dict[int, int] = {}
    for t in (v or []):
        try:
            mc = max(0, int((t or {}).get("min_cents") or 0))
            pct = max(1, min(90, int((t or {}).get("pct") or 0)))
        except (TypeError, ValueError):
            continue
        if mc > 0:
            out[mc] = pct
    return [{"min_cents": k, "pct": out[k]} for k in sorted(out)][:6]


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
            # Κλιμακωτή έκπτωση καλαθιού: [{min_cents, pct}] — ΜΟΝΟ σε μη-συνταγογραφούμενα.
            "cart_tiers": d.get("cart_tiers", []),
            # Υπενθύμιση «ξεχασμένου καλαθιού» — opt-in (στέλνει push στον πελάτη).
            "abandoned_cart_enabled": d.get("abandoned_cart_enabled", False),
            "abandoned_cart_hours": d.get("abandoned_cart_hours", 6),
            # Online πληρωμή e-shop (Viva: κάρτα + IRIS) — ανά φαρμακείο, τα λεφτά πάνε στο φαρμακείο.
            "online_payment_enabled": d.get("online_payment_enabled", False),
            "viva": self._viva_masked(d.get("viva") or {}),
            # Merchandising: hero banner στην αρχική του e-shop (ρυθμίζει ο φαρμακοποιός).
            "hero_enabled": d.get("hero_enabled", False),
            "hero_image_id": d.get("hero_image_id") or None,
            "hero_title": d.get("hero_title", ""),
            "hero_subtitle": d.get("hero_subtitle", ""),
            "tenant_id": self.tenant_id,   # για το webhook URL στο UI
        }

    @staticmethod
    def _viva_masked(v: dict) -> dict:
        """Μασκαρισμένη εικόνα Viva creds για το UI (χωρίς secrets)."""
        return {"client_id": v.get("client_id") or "", "source_code": v.get("source_code") or "",
                "merchant_id": v.get("merchant_id") or "", "mode": v.get("mode") or "demo",
                "client_secret_set": bool(v.get("client_secret")), "api_key_set": bool(v.get("api_key")),
                "checkout_ready": bool(v.get("client_id") and v.get("client_secret") and v.get("source_code"))}

    async def viva_creds(self) -> dict:
        """Αποκρυπτογραφημένα Viva creds του φαρμακείου (για πραγματική πληρωμή). Ποτέ στο UI."""
        from app.services.platform_secrets import pdec
        d = await self._db["order_settings"].find_one({"tenant_id": self.tenant_id}) or {}
        v = dict(d.get("viva") or {})
        for f in ("client_secret", "api_key"):
            if v.get(f):
                v[f] = pdec(v[f])
        return v

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
            "cart_tiers": _clean_tiers(cfg.get("cart_tiers")),
            "abandoned_cart_enabled": bool(cfg.get("abandoned_cart_enabled", False)),
            "abandoned_cart_hours": max(1, min(72, int(cfg.get("abandoned_cart_hours") or 6))),
            "online_payment_enabled": bool(cfg.get("online_payment_enabled", False)),
            "hero_enabled": bool(cfg.get("hero_enabled", False)),
            "hero_image_id": (str(cfg.get("hero_image_id")).strip() or None) if cfg.get("hero_image_id") else None,
            "hero_title": str(cfg.get("hero_title") or "")[:120],
            "hero_subtitle": str(cfg.get("hero_subtitle") or "")[:200],
            "updated_at": _now(),
        }
        # Viva creds ανά φαρμακείο — κρυπτογράφησε τα secrets· κενό secret = αμετάβλητο.
        vin = cfg.get("viva") or {}
        if vin:
            from app.services.platform_secrets import penc
            cur = (await self._db["order_settings"].find_one({"tenant_id": self.tenant_id}) or {}).get("viva") or {}
            v = {"client_id": str(vin.get("client_id") or cur.get("client_id") or ""),
                 "source_code": str(vin.get("source_code") or cur.get("source_code") or ""),
                 "merchant_id": str(vin.get("merchant_id") or cur.get("merchant_id") or ""),
                 "mode": vin.get("mode") or cur.get("mode") or "demo",
                 "client_secret": penc(vin["client_secret"]) if vin.get("client_secret") else cur.get("client_secret"),
                 "api_key": penc(vin["api_key"]) if vin.get("api_key") else cur.get("api_key")}
            clean["viva"] = v
        await self._db["order_settings"].update_one(
            {"tenant_id": self.tenant_id}, {"$set": {**clean, "tenant_id": self.tenant_id}}, upsert=True)
        return await self.settings()

    # ── patient places an order ─────────────────────────────────────────────
    async def create_order(self, *, account_id, patient_ref: str | None, patient_name: str,
                           patient_phone: str, lines: list[dict], mode: str, address: dict | None,
                           courier_authorized: bool, gdpr_consent: bool,
                           courier_auth: dict | None = None, loyalty_redeem_cents: int = 0,
                           coupon_code: str | None = None, payment_method: str = "pickup",
                           sub_discount_pct: int = 0, subscription_id: str | None = None) -> dict:
        if not gdpr_consent:
            return {"ok": False, "error": "consent_required"}
        # Παραλαβή από το κατάστημα → καμία εξουσιοδότηση. Αποστολή με μεταφορέα → εξουσιοδότηση
        # + στοιχεία εξουσιοδοτούμενου (ονοματεπώνυμο & αρ. ταυτότητας/διαβατηρίου).
        if mode == "delivery" and not courier_authorized:
            return {"ok": False, "error": "courier_auth_required"}
        if mode == "delivery":
            ca_name = ((courier_auth or {}).get("name") or "").strip()
            ca_id = ((courier_auth or {}).get("id_number") or "").strip()
            if not ca_name or not ca_id:
                return {"ok": False, "error": "courier_auth_details_required"}
            courier_auth = {"name": ca_name, "id_number": ca_id}
        else:
            courier_auth = None
        cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
        campaigns = await ShopCampaignRepository(tenant_id=self.tenant_id).active_now()
        items: list[dict] = []
        reserve_items: list[dict] = []          # είδη με επαρκές απόθεμα → δεσμεύονται άμεσα
        subtotal = 0
        redeemable = 0                          # αξία ΜΗ-συνταγογραφούμενων → πάνω της «πέφτουν» οι πόντοι
        has_medicine = False
        has_backorder = False                   # ≥1 είδος «κατόπιν παραγγελίας» → η παραγγελία θέλει έγκριση
        for ln in lines:
            prod = await cat.get(str(ln.get("barcode")))
            qty = max(1, int(ln.get("qty") or 1))
            if not prod or not prod.get("active", True):
                return {"ok": False, "error": "unavailable", "barcode": ln.get("barcode")}
            # Δεν επαρκεί το απόθεμα → ΚΑΤΟΠΙΝ ΠΑΡΑΓΓΕΛΙΑΣ (backorder): επιτρέπεται, αλλά η παραγγελία
            # μπαίνει «σε αναμονή έγκρισης» — ο φαρμακοποιός αποδέχεται/απορρίπτει & δηλώνει ημερομηνία.
            backorder = prod.get("stock_qty", 0) < qty
            if backorder:
                has_backorder = True
            else:
                reserve_items.append({"barcode": prod["barcode"], "qty": qty})
            unit = int(prod["price_cents"])
            ptype = prod.get("type")
            if ptype in ("rx_medicine", "otc_medicine"):
                has_medicine = True
            # Έκπτωση: καλύτερη ανάμεσα σε «δική του» και «καμπάνιας ομάδας» (ΔΕΝ αθροίζονται)·
            # τα συνταγογραφούμενα εξαιρούνται πάντα (campaign_pct_for → 0).
            camp_pct = campaign_pct_for(prod, campaigns)
            if ptype == "rx_medicine":
                disc = 0                                    # συνταγογραφούμενα: ΠΟΤΕ έκπτωση
            elif ptype == "otc_medicine":
                disc = min(90, max(int(prod.get("discount_pct") or 0), camp_pct))
            else:                                           # παραφάρμακα: + έκπτωση συνδρομής
                disc = min(90, max(int(prod.get("discount_pct") or 0), camp_pct) + max(0, int(sub_discount_pct)))
            line_cents = round(unit * qty * (100 - disc) / 100)
            subtotal += line_cents
            if ptype != "rx_medicine":
                redeemable += line_cents
            items.append({"barcode": prod["barcode"], "name": prod["name"], "qty": qty,
                          "unit_cents": unit, "discount_pct": disc, "line_cents": line_cents,
                          "campaign_pct": camp_pct, "type": prod.get("type"), "backorder": backorder})
        if not items:
            return {"ok": False, "error": "empty"}
        st = await self.settings()
        if mode == "delivery" and not st.get("delivery_enabled"):
            return {"ok": False, "error": "delivery_disabled"}
        if mode == "pickup" and not st.get("pickup_enabled"):
            return {"ok": False, "error": "pickup_disabled"}
        if subtotal < st["min_order_cents"]:
            return {"ok": False, "error": "below_min", "min_cents": st["min_order_cents"]}
        # ── (2) ΠΑΚΕΤΑ → όφελος σε τεμάχια/γραμμές (μόνο μη-συνταγογραφούμενα) ──
        bundles = await ShopBundleRepository(tenant_id=self.tenant_id).active_now()
        bundle_cents, bundle_names = bundle_savings(items, bundles)
        bundle_cents = min(bundle_cents, redeemable)
        redeemable -= bundle_cents          # η βάση για τα επόμενα βήματα μικραίνει
        # ── (3) ΚΑΛΑΘΙ: ΚΑΛΥΤΕΡΟ από «κλιμακωτή» ή «κουπόνι» — όχι και τα δύο ──
        tier_cents, tier_pct = tier_discount(redeemable, st.get("cart_tiers") or [])
        coupon_doc, coupon_cents = None, 0
        if coupon_code:
            crepo = ShopCouponRepository(tenant_id=self.tenant_id)
            v = await crepo.validate(coupon_code, redeemable)
            if not v.get("ok"):
                return {"ok": False, "error": v.get("error"), "min_cents": v.get("min_cents")}
            coupon_doc = v["coupon"]
            coupon_cents = coupon_discount(coupon_doc, redeemable)
        if coupon_cents >= tier_cents:
            cart_cents, cart_kind, tier_pct = coupon_cents, "coupon", 0
        else:
            cart_cents, cart_kind, coupon_doc, coupon_cents = tier_cents, "tier", None, 0
        cart_cents = min(cart_cents, redeemable)
        redeemable -= cart_cents            # ό,τι μένει είναι το ταβάνι για τους πόντους
        fee = 0
        if mode == "delivery":
            base_for_fee = subtotal - bundle_cents - cart_cents
            fee = 0 if (st["free_over_cents"] and base_for_fee >= st["free_over_cents"]) else st["delivery_fee_cents"]
        # ── (4) εξαργύρωση πόντων: ΜΟΝΟ πάνω στην αξία των ΜΗ-συνταγογραφούμενων ειδών ──
        redeem_cents = max(0, int(loyalty_redeem_cents or 0))
        loy = None
        if redeem_cents:
            from app.repositories.loyalty import LoyaltyRepository
            loy = LoyaltyRepository(tenant_id=self.tenant_id)
            lcfg = await loy.config()
            if not lcfg.get("enabled") or not patient_ref:
                return {"ok": False, "error": "loyalty_off"}
            member = await loy.member(str(patient_ref))
            if not member:
                return {"ok": False, "error": "loyalty_not_member"}
            if redeem_cents > redeemable:
                return {"ok": False, "error": "redeem_exceeds_eligible", "eligible_cents": redeemable}
            if redeem_cents > int(member.get("balance_cents") or 0):
                return {"ok": False, "error": "redeem_insufficient",
                        "balance_cents": int(member.get("balance_cents") or 0)}
            min_r = int(lcfg.get("min_redeem_cents") or 0)
            if min_r and redeem_cents < min_r:
                return {"ok": False, "error": "redeem_below_min", "min_cents": min_r}
        # «Σε αναμονή έγκρισης» αν έχει backorder (ο φαρμακοποιός αποφασίζει)· αλλιώς «Νέα» άμεσα.
        status = "pending" if has_backorder else "new"
        # ΑΤΟΜΙΚΗ δέσμευση αποθέματος για τα ΑΜΕΣΑ είδη (όχι σε pending — δεσμεύεται στην έγκριση).
        if status == "new" and reserve_items:
            reserve = await cat.reserve_stock(reserve_items)
            if not reserve.get("ok"):
                return {"ok": False, "error": "unavailable", "barcode": reserve.get("barcode")}
        # Χρέωση πόντων ΜΟΝΟ αφού εξασφαλιστεί το απόθεμα (αλλιώς θα «καίγονταν» σε αποτυχία).
        if redeem_cents and loy:
            r = await loy.redeem(str(patient_ref), redeem_cents, reason="Παραγγελία e-shop", kind="shop")
            if not r.get("ok"):
                if status == "new" and reserve_items:
                    await cat.restore_stock(reserve_items)      # ξε-δέσμευσε ό,τι μόλις δεσμεύτηκε
                return {"ok": False, "error": "redeem_failed"}
        if coupon_doc:                       # «κλείδωσε» τη χρήση του κουπονιού (επιστρέφεται σε ακύρωση)
            await ShopCouponRepository(tenant_id=self.tenant_id).consume(str(coupon_doc["code"]))
        doc = {
            "tenant_id": self.tenant_id, "account_id": account_id, "patient_ref": patient_ref,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "items": items, "subtotal_cents": subtotal, "delivery_fee_cents": fee,
            "bundle_discount_cents": bundle_cents, "bundle_names": bundle_names,
            "cart_discount_cents": cart_cents, "cart_discount_kind": cart_kind if cart_cents else None,
            "cart_tier_pct": tier_pct, "coupon_code": (coupon_doc or {}).get("code"),
            "loyalty_redeem_cents": redeem_cents,
            "total_cents": max(0, subtotal - bundle_cents - cart_cents + fee - redeem_cents), "mode": mode,
            "address": address if mode == "delivery" else None,
            "courier_authorized": bool(courier_authorized), "courier_auth": courier_auth,
            "gdpr_consent": True,
            "has_medicine": has_medicine, "has_backorder": has_backorder, "available_date": None,
            "status": status, "subscription_id": subscription_id,
            "status_history": [{"status": status, "at": _now()}],
            # πληρωμή: pickup/cod = στο κατάστημα (unpaid)· online = Viva (κάρτα/IRIS)
            "payment_method": payment_method if payment_method in ("online", "pickup", "cod") else "pickup",
            "payment_status": "unpaid",
            "created_at": _now(), "updated_at": _now(),
        }
        res = await self.insert_one(doc)
        order_total = doc["total_cents"]
        # Online πληρωμή → Viva Smart Checkout (κάρτα/IRIS). Επιστρέφει checkout_url για redirect.
        if payment_method == "online" and order_total > 0:
            st = await self.settings()
            creds = await self.viva_creds()
            if st.get("online_payment_enabled") and (creds.get("client_id") and creds.get("client_secret") and creds.get("source_code")):
                from app.services import viva_service
                vres = await viva_service.create_checkout_order(
                    amount=order_total, ref=str(res), description=f"RxVision e-shop #{str(res)[-6:]}",
                    full_name=patient_name, phone=patient_phone, creds=creds)
                if vres.get("ok"):
                    await self.update_one({"_id": res}, {"$set": {
                        "payment_status": "pending", "viva_order_code": vres.get("order_code")}})
                    if account_id:
                        await self.clear_cart(account_id)
                    return {"ok": True, "order_id": str(res), "total_cents": order_total,
                            "status": status, "has_backorder": has_backorder,
                            "payment": "viva", "checkout_url": vres.get("checkout_url")}
        if account_id:
            await self.clear_cart(account_id)     # παραγγέλθηκε → δεν είναι πια «ξεχασμένο καλάθι»
        # επιβεβαίωση παραλαβής παραγγελίας (1ο στάδιο) — μετά ακολουθούν push σε κάθε αλλαγή status
        if account_id:
            from app.services import push_service
            body = ("Κάποια είδη είναι κατόπιν παραγγελίας — στάλθηκε στο φαρμακείο για έγκριση & ημερομηνία."
                    if has_backorder else "Στάλθηκε στο φαρμακείο σου. Θα ενημερώνεσαι σε κάθε βήμα.")
            await push_service.send_to_account(
                account_id, title="🛍️ Η παραγγελία σου ελήφθη", body=body, url="/portal")
        return {"ok": True, "order_id": str(res), "total_cents": subtotal + fee,
                "status": status, "has_backorder": has_backorder}

    # ── ενεργό καλάθι (server-side) → υπενθύμιση «ξεχασμένου καλαθιού» ──────
    # Το καλάθι ζει στο localStorage του πελάτη· κρατάμε ΑΝΤΙΓΡΑΦΟ (barcode+qty μόνο, χωρίς PII)
    # ώστε ο beat να μπορεί να στείλει push αν μείνει ασυμπλήρωτο.
    async def save_cart(self, account_id, lines: list[dict]) -> dict:
        clean = [{"barcode": str(ln.get("barcode")), "qty": max(1, int(ln.get("qty") or 1))}
                 for ln in (lines or []) if ln.get("barcode")][:50]
        if not clean:
            return await self.clear_cart(account_id)
        await self._db["shop_carts"].update_one(
            {"tenant_id": self.tenant_id, "account_id": account_id},
            {"$set": {"items": clean, "updated_at": _now(), "reminded_at": None},
             "$setOnInsert": {"tenant_id": self.tenant_id, "account_id": account_id}},
            upsert=True)
        return {"ok": True, "items": len(clean)}

    async def clear_cart(self, account_id) -> dict:
        await self._db["shop_carts"].delete_one({"tenant_id": self.tenant_id, "account_id": account_id})
        return {"ok": True, "items": 0}

    # ── subscriptions (recurring orders) ────────────────────────────────────
    async def create_subscription(self, *, account_id, patient_ref, patient_name, patient_phone,
                                  lines, mode, address, courier_authorized, interval_days,
                                  courier_auth: dict | None = None) -> dict:
        from datetime import timedelta
        iv = max(7, int(interval_days))
        doc = {
            "tenant_id": self.tenant_id, "account_id": account_id, "patient_ref": patient_ref,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "lines": [{"barcode": str(ln.get("barcode")), "qty": max(1, int(ln.get("qty") or 1))} for ln in lines],
            "mode": mode, "address": address, "courier_authorized": bool(courier_authorized),
            "courier_auth": courier_auth if mode == "delivery" else None,
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
            courier_authorized=sub.get("courier_authorized", False),
            courier_auth=sub.get("courier_auth"), gdpr_consent=True,
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
        return await self.count({"status": {"$in": ["pending", "new", "preparing"]}})

    async def respond_backorder(self, order_id: str, accept: bool, available_date: str | None = None) -> dict:
        """Ο φαρμακοποιός αποδέχεται (+ ημερομηνία διαθεσιμότητας) ή απορρίπτει μια «σε αναμονή» παραγγελία."""
        from bson import ObjectId
        try:
            oid = ObjectId(order_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        order = await self.find_one({"_id": oid})
        if not order or order.get("status") != "pending":
            return {"ok": False, "error": "not_pending"}
        if accept:
            # δέσμευσε ό,τι είναι ΗΔΗ σε απόθεμα (τα backorder θα έρθουν) → «Νέα» πλέον
            cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
            in_stock = [{"barcode": it["barcode"], "qty": it["qty"]}
                        for it in order.get("items", []) if not it.get("backorder")]
            if in_stock:
                await cat.reserve_stock(in_stock)   # best-effort (backorder ούτως ή άλλως έρχεται)
            await self.update_one({"_id": oid}, {
                "$set": {"status": "new", "available_date": available_date, "updated_at": _now()},
                "$push": {"status_history": {"status": "new", "at": _now()}}})
            msg = (f"Η παραγγελία σου εγκρίθηκε! Διαθέσιμη ~{available_date}." if available_date
                   else "Η παραγγελία σου εγκρίθηκε! Θα ενημερωθείς μόλις είναι έτοιμη.")
        else:
            await self.update_one({"_id": oid}, {
                "$set": {"status": "declined", "updated_at": _now()},
                "$push": {"status_history": {"status": "declined", "at": _now()}}})
            await self._refund_loyalty(order)     # απόρριψη → γύρνα πίσω τους πόντους
            msg = "Δυστυχώς το φαρμακείο δεν μπορεί να εκτελέσει την παραγγελία σου αυτή τη στιγμή."
        if order.get("account_id"):
            from app.services import push_service
            await push_service.send_to_account(order["account_id"],
                                               title="🛍️ Παραγγελία φαρμακείου", body=msg, url="/portal")
        return {"ok": True, "status": "new" if accept else "declined", "available_date": available_date}

    async def _refund_loyalty(self, order: dict) -> None:
        """Επιστροφή πόντων + χρήσης κουπονιού σε ακύρωση/απόρριψη — ΜΙΑ φορά (idempotent)."""
        if order.get("loyalty_refunded"):
            return
        cents = int(order.get("loyalty_redeem_cents") or 0)
        if cents > 0 and order.get("patient_ref"):
            from app.repositories.loyalty import LoyaltyRepository
            await LoyaltyRepository(tenant_id=self.tenant_id).adjust(
                str(order["patient_ref"]), cents, reason="Επιστροφή πόντων — ακυρωμένη παραγγελία")
        if order.get("coupon_code"):          # ξανα-δώσε τη χρήση του κουπονιού
            await ShopCouponRepository(tenant_id=self.tenant_id).release(str(order["coupon_code"]))
        if cents > 0 or order.get("coupon_code"):
            await self.update_one({"_id": order["_id"]}, {"$set": {"loyalty_refunded": True}})

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
        # Ακύρωση → επέστρεψε το δεσμευμένο απόθεμα (μόνο μία φορά: αν δεν ήταν ήδη ακυρωμένη).
        if status == "cancelled" and order.get("status") != "cancelled":
            await PharmacyCatalogRepository(tenant_id=self.tenant_id).restore_stock(
                [{"barcode": it.get("barcode"), "qty": it.get("qty", 1)} for it in order.get("items", [])])
            await self._refund_loyalty(order)     # ακύρωση → γύρνα πίσω τους πόντους
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


# ── Viva e-shop webhook (public, cross-tenant lookup) ───────────────────────────────────────────
async def confirm_viva_payment(*, order_code: str, transaction_id: str | None = None) -> bool:
    """Επιβεβαίωση e-shop πληρωμής Viva. Βρίσκει την παραγγελία από το order_code (μοναδικό),
    ξανα-ρωτά το Viva με τα creds ΤΟΥ ΦΑΡΜΑΚΕΙΟΥ (source of truth), και μαρκάρει paid + ειδοποιεί."""
    from app.core.db import shared_db
    from app.services import viva_service
    if not order_code:
        return False
    db = shared_db()
    order = await db["orders_delivery"].find_one({"viva_order_code": str(order_code)})
    if not order or order.get("payment_status") == "paid":
        return bool(order and order.get("payment_status") == "paid")
    tid = order.get("tenant_id")
    repo = OrdersDeliveryRepository(tenant_id=tid)
    creds = await repo.viva_creds()
    if transaction_id:
        info = await viva_service.get_transaction(str(transaction_id), creds=creds)
        if info and str(info.get("StatusId") or "") not in ("", "F"):
            return False           # όχι επιτυχής → μη μαρκάρεις
    await repo.update_one({"_id": order["_id"]}, {"$set": {
        "payment_status": "paid", "viva_transaction_id": transaction_id, "paid_at": _now()}})
    if order.get("account_id"):
        from app.services import push_service
        await push_service.send_to_account(order["account_id"], title="✅ Η πληρωμή ολοκληρώθηκε",
                                           body="Η online πληρωμή της παραγγελίας σου ελήφθη.", url="/portal")
    return True
