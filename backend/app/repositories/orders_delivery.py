"""Order & delivery circuit — orders the patient places from the pharmacy's own catalog (OTC +
parapharmacy), like phoning the pharmacy, optionally delivered to the patient's address with their
courier authorization. The selling pharmacy fulfils; prices are RE-COMPUTED server-side from the
catalog (never trust the client). Prescription items are NOT here — they use the reservation flow.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.repositories.base import BaseRepository, jsonsafe
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
from app.utils.masking import mask_row, pseudo_phone
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


# Μειωμένοι συντελεστές ΦΠΑ (νησιά κ.λπ.) — κατά προσέγγιση -30% στον πλησιέστερο νόμιμο συντελεστή.
_REDUCED_VAT = {24: 17, 17: 13, 13: 9, 6: 4}


def _eff_vat(rate: int, reduced: bool) -> int:
    return _REDUCED_VAT.get(int(rate or 0), int(rate or 0)) if reduced else int(rate or 0)


def compute_order_vat(items: list[dict], *, non_rx_reduction_cents: int = 0, reduced: bool = False) -> dict:
    """Ανάλυση ΦΠΑ ανά είδος & ανά συντελεστή για ΣΩΣΤΕΣ αποδείξεις/τιμολόγια.
    - price_includes_vat=True → ΑΠΟΦΟΡΟΛΟΓΗΣΗ (net=μικτή/(1+συντ.)) + ξεχωριστό ΦΠΑ.
    - price_includes_vat=False → πρόσθεση ΦΠΑ πάνω στην καθαρή (η μικτή ανεβαίνει).
    Οι εκπτώσεις καλαθιού κατανέμονται ΑΝΑΛΟΓΙΚΑ ΜΟΝΟ στα μη-rx (τα rx δεν παίρνουν έκπτωση).
    Επιστρέφει και `extra_vat_cents` = επιπλέον ΦΠΑ που προστέθηκε σε είδη «χωρίς ΦΠΑ»."""
    non_rx_base = sum(int(i.get("line_cents") or 0) for i in items if i.get("type") != "rx_medicine")
    by_rate: dict[int, dict] = {}
    lines, tot_net, tot_vat, tot_gross = [], 0, 0, 0
    pre_vat_payable = 0
    for i in items:
        line = int(i.get("line_cents") or 0)
        alloc = 0
        if i.get("type") != "rx_medicine" and non_rx_base > 0 and non_rx_reduction_cents:
            alloc = round(non_rx_reduction_cents * line / non_rx_base)
        base = max(0, line - alloc)                 # τιμή μετά τις εκπτώσεις καλαθιού (shelf)
        pre_vat_payable += base
        v = _eff_vat(int(i.get("vat_rate") or 0), reduced)
        if v <= 0:
            net, vat, gross = base, 0, base
        elif i.get("price_includes_vat", True):
            net = round(base / (1 + v / 100)); vat = base - net; gross = base
        else:
            net = base; vat = round(base * v / 100); gross = base + vat
        r = by_rate.setdefault(v, {"net_cents": 0, "vat_cents": 0, "gross_cents": 0})
        r["net_cents"] += net; r["vat_cents"] += vat; r["gross_cents"] += gross
        tot_net += net; tot_vat += vat; tot_gross += gross
        lines.append({"barcode": i.get("barcode"), "vat_rate": v,
                      "net_cents": net, "vat_cents": vat, "gross_cents": gross})
    return {"by_rate": [{"rate": k, **val} for k, val in sorted(by_rate.items())],
            "lines": lines, "total_net_cents": tot_net, "total_vat_cents": tot_vat,
            "total_gross_cents": tot_gross, "reduced": bool(reduced),
            "extra_vat_cents": max(0, tot_gross - pre_vat_payable)}


class OrdersDeliveryRepository(BaseRepository):
    collection_name = "orders_delivery"

    # ── demo/presentation masking (GDPR): pseudonymize the CUSTOMER's PII on read ──────────
    # Only patient/customer person fields — never the drug/item names in `items`.
    def _mask_order(self, o: dict) -> dict:
        if not self.demo or not isinstance(o, dict):
            return o
        mask_row(o, True)                                   # patient_name
        if o.get("patient_phone"):
            o["patient_phone"] = pseudo_phone(o["patient_phone"], True)
        if isinstance(o.get("address"), dict):
            mask_row(o["address"], True)                    # address / area / city / street
        if isinstance(o.get("courier_auth"), dict):
            mask_row(o["courier_auth"], True)               # authorized pick-up person's name
        return o

    def _mask_orders(self, rows: list[dict] | None) -> list[dict] | None:
        if self.demo and rows:
            for r in rows:
                self._mask_order(r)
        return rows

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
            # Περιοχές μειωμένου ΦΠΑ (π.χ. νησιά): ονόματα περιοχών· η παράδοση σε αυτές → μειωμένος συντελεστής.
            "reduced_vat_areas": d.get("reduced_vat_areas", []),
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
            "reduced_vat_areas": [str(a).strip()[:80] for a in (cfg.get("reduced_vat_areas") or []) if str(a).strip()][:80],
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
                           sub_discount_pct: int = 0, subscription_id: str | None = None,
                           note: str | None = None) -> dict:
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
            from app.repositories.pharmacy_catalog import sale_active_now
            camp_pct = campaign_pct_for(prod, campaigns)
            self_disc = int(prod.get("discount_pct") or 0) if sale_active_now(prod) else 0  # flash: εντός παραθύρου
            if ptype == "rx_medicine":
                disc = 0                                    # συνταγογραφούμενα: ΠΟΤΕ έκπτωση
            elif ptype == "otc_medicine":
                disc = min(90, max(self_disc, camp_pct))
            else:                                           # παραφάρμακα: + έκπτωση συνδρομής
                disc = min(90, max(self_disc, camp_pct) + max(0, int(sub_discount_pct)))
            line_cents = round(unit * qty * (100 - disc) / 100)
            subtotal += line_cents
            if ptype != "rx_medicine":
                redeemable += line_cents
            items.append({"barcode": prod["barcode"], "name": prod["name"], "qty": qty,
                          "unit_cents": unit, "discount_pct": disc, "line_cents": line_cents,
                          "campaign_pct": camp_pct, "type": prod.get("type"), "backorder": backorder,
                          "vat_rate": int(prod.get("vat_rate") or 0),
                          "price_includes_vat": bool(prod.get("price_includes_vat", True))})
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
        # ── (3) ΚΑΛΑΘΙ: ΚΑΛΥΤΕΡΟ από «αυτόματη» (κλιμακωτή/order-discount) ή «κουπόνι» — όχι και τα δύο ──
        from app.repositories.shop_order_discounts import (
            ShopOrderDiscountRepository, best_order_discount, free_shipping_threshold)
        total_qty = sum(int(it.get("qty") or 0) for it in items)
        order_discs = await ShopOrderDiscountRepository(tenant_id=self.tenant_id).active_now()
        tier_cents, tier_pct = tier_discount(redeemable, st.get("cart_tiers") or [])
        auto = best_order_discount(order_discs, base_cents=redeemable, qty=total_qty)  # Shopify αυτόματη
        auto_cents = auto["discount_cents"] if auto else 0
        automatic_cents = max(tier_cents, auto_cents)               # μία αυτόματη έκπτωση (όχι σώρευση)
        auto_disc_id = auto["id"] if (auto and auto_cents >= tier_cents and auto_cents > 0) else None
        coupon_doc, coupon_cents = None, 0
        if coupon_code:
            crepo = ShopCouponRepository(tenant_id=self.tenant_id)
            v = await crepo.validate(coupon_code, redeemable)
            if not v.get("ok"):
                return {"ok": False, "error": v.get("error"), "min_cents": v.get("min_cents")}
            coupon_doc = v["coupon"]
            coupon_cents = coupon_discount(coupon_doc, redeemable)
        if coupon_cents >= automatic_cents:
            cart_cents, cart_kind, tier_pct, auto_disc_id = coupon_cents, "coupon", 0, None
        else:
            cart_cents = automatic_cents
            cart_kind = "order_discount" if auto_disc_id else "tier"
            coupon_doc, coupon_cents = None, 0
        cart_cents = min(cart_cents, redeemable)
        redeemable -= cart_cents            # ό,τι μένει είναι το ταβάνι για τους πόντους
        fee = 0
        if mode == "delivery":
            base_for_fee = subtotal - bundle_cents - cart_cents
            # Δωρεάν μεταφορικά: κατώφλι από ρυθμίσεις Ή από ενεργή free_shipping προσφορά (το μικρότερο).
            fs = free_shipping_threshold(order_discs, qty=total_qty)
            thresholds = [x for x in (st.get("free_over_cents") or 0, fs) if x]
            free_at = min(thresholds) if thresholds else 0
            fee = 0 if (free_at and base_for_fee >= free_at) else st["delivery_fee_cents"]
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
        # ── (5) ΦΠΑ: ανάλυση ανά είδος/συντελεστή (αποφορολόγηση + ξανά ΦΠΑ) για σωστές αποδείξεις ──
        reduced_areas = {str(a).strip().lower() for a in (st.get("reduced_vat_areas") or [])}
        area = str((address or {}).get("area") or "").strip().lower() if mode == "delivery" else ""
        reduced_vat = bool(area and area in reduced_areas)
        vat = compute_order_vat(items, non_rx_reduction_cents=bundle_cents + cart_cents, reduced=reduced_vat)
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
        if auto_disc_id:                     # αύξησε μετρητή χρήσεων της αυτόματης order-έκπτωσης
            await ShopOrderDiscountRepository(tenant_id=self.tenant_id).consume(auto_disc_id)
        doc = {
            "tenant_id": self.tenant_id, "account_id": account_id, "patient_ref": patient_ref,
            "patient_name": patient_name, "patient_phone": patient_phone,
            "items": items, "subtotal_cents": subtotal, "delivery_fee_cents": fee,
            "bundle_discount_cents": bundle_cents, "bundle_names": bundle_names,
            "cart_discount_cents": cart_cents, "cart_discount_kind": cart_kind if cart_cents else None,
            "cart_tier_pct": tier_pct, "coupon_code": (coupon_doc or {}).get("code"),
            "loyalty_redeem_cents": redeem_cents,
            # ΦΠΑ ανάλυση (αποδείξεις/τιμολόγια)· extra_vat = ΦΠΑ που προστέθηκε σε είδη «χωρίς ΦΠΑ».
            "vat": vat,
            "total_cents": max(0, subtotal - bundle_cents - cart_cents + vat["extra_vat_cents"] + fee - redeem_cents), "mode": mode,
            "address": address if mode == "delivery" else None,
            "courier_authorized": bool(courier_authorized), "courier_auth": courier_auth,
            "gdpr_consent": True,
            "note": (note or "").strip()[:500] or None,   # σημείωση πελάτη πάνω στην παραγγελία
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
        try:   # προμήθεια συναλλαγής e-shop (no-op αν off/εξαίρεση)· ΠΟΤΕ δεν ρίχνει τη δημιουργία
            from app.services import eshop_fees
            await eshop_fees.accrue(self.tenant_id, res.inserted_id,
                                    order_no=str(res.inserted_id)[-6:],
                                    amount_total=doc.get("total_cents"))
        except Exception:  # noqa: BLE001
            pass
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
        return {"ok": True, "order_id": str(res), "total_cents": order_total,
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
        rows = self._mask_orders(rows) or []
        # Εμπλούτισε τις γραμμές με στοιχεία προϊόντος (όνομα/φωτό/τιμή) ώστε η οθόνη «Συνδρομές»
        # να δείχνει ευδιάκριτα προϊόντα/ποσότητες/τιμές (ίδια λογική έκπτωσης με το κατάστημα).
        from app.repositories.pharmacy_catalog import PharmacyCatalogRepository, sale_active_now
        from app.repositories.shop_campaigns import ShopCampaignRepository, campaign_pct_for
        cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
        camps = await ShopCampaignRepository(tenant_id=self.tenant_id).active_now()
        cache: dict = {}
        for sub in rows:
            total = 0
            for ln in sub.get("lines", []):
                bc = str(ln.get("barcode"))
                if bc not in cache:
                    cache[bc] = await cat.get(bc) or {}
                p = cache[bc]
                qty = max(1, int(ln.get("qty") or 1))
                is_rx = p.get("type") == "rx_medicine"
                self_disc = int(p.get("discount_pct") or 0) if (not is_rx and sale_active_now(p)) else 0
                eff = 0 if is_rx else max(self_disc, campaign_pct_for(p, camps))
                unit = round(int(p.get("price_cents") or 0) * (100 - eff) / 100)
                ln["name"] = p.get("name") or bc
                ln["image_id"] = p.get("image_id")
                ln["type"] = p.get("type")
                ln["price_cents"] = int(p.get("price_cents") or 0)
                ln["unit_cents"] = unit
                ln["line_cents"] = unit * qty
                ln["discount_pct"] = eff
                total += unit * qty
            sub["subtotal_cents"] = total
        return jsonsafe(rows)

    async def update_subscription(self, sub_id: str, account_id, *, interval_days: int | None = None,
                                  remove_barcode: str | None = None) -> dict:
        """Επεξεργασία συνδρομής από τον πελάτη: αλλαγή συχνότητας ή αφαίρεση είδους
        (αφαίρεση του τελευταίου είδους → ακύρωση συνδρομής)."""
        from datetime import timedelta
        from bson import ObjectId
        try:
            oid = ObjectId(sub_id)
        except Exception:  # noqa: BLE001
            return {"ok": False}
        q = {"_id": oid, "tenant_id": self.tenant_id, "account_id": account_id}
        sub = await self._db["order_subscriptions"].find_one(q)
        if not sub:
            return {"ok": False, "error": "not_found"}
        upd: dict = {}
        if interval_days is not None:
            iv = max(7, int(interval_days))
            upd["interval_days"] = iv
            upd["next_run"] = _now() + timedelta(days=iv)
        if remove_barcode is not None:
            lines = [ln for ln in sub.get("lines", []) if str(ln.get("barcode")) != str(remove_barcode)]
            if not lines:
                await self._db["order_subscriptions"].update_one(q, {"$set": {"active": False, "cancelled_at": _now()}})
                return {"ok": True, "cancelled": True}
            upd["lines"] = [{"barcode": str(ln["barcode"]), "qty": max(1, int(ln.get("qty") or 1))} for ln in lines]
        if upd:
            upd["updated_at"] = _now()
            await self._db["order_subscriptions"].update_one(q, {"$set": upd})
        return {"ok": True}

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
        for r in (rows or []):        # η ΕΣΩΤΕΡΙΚΗ σημείωση φαρμακοποιού ΔΕΝ φαίνεται ΠΟΤΕ στον πελάτη
            r.pop("internal_note", None)
        return jsonsafe(self._mask_orders(rows))

    # ── pharmacist side ─────────────────────────────────────────────────────
    async def list_orders(self, *, status: str | None = None, limit: int = 100) -> list[dict]:
        q: dict = {}
        if status == "open":
            q["status"] = {"$in": list(_OPEN)}
        elif status:
            q["status"] = status
        return jsonsafe(self._mask_orders(await self.find(q, sort=[("created_at", -1)], limit=limit)))

    async def pending_count(self) -> int:
        return await self.count({"status": {"$in": ["pending", "new", "preparing"]}})

    @staticmethod
    def _fmt_window(available_date: str | None, af: str | None, at: str | None) -> str:
        """«29/09/2026, 15:00–20:00» — ημερομηνία + (προαιρετικό) χρονικό διάστημα παραλαβής."""
        if not available_date:
            return ""
        try:
            y, m, d = available_date.split("-")[:3]
            ds = f"{d}/{m}/{y}"
        except Exception:  # noqa: BLE001
            ds = available_date
        if af and at:
            return f"{ds}, {af}–{at}"
        return ds

    async def respond_backorder(self, order_id: str, accept: bool, available_date: str | None = None,
                                available_from: str | None = None, available_to: str | None = None) -> dict:
        """Ο φαρμακοποιός αποδέχεται (+ ημερομηνία & χρονικό διάστημα διαθεσιμότητας) ή απορρίπτει μια «σε αναμονή»."""
        from bson import ObjectId
        try:
            oid = ObjectId(order_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        order = await self.find_one({"_id": oid})
        if not order or order.get("status") != "pending":
            return {"ok": False, "error": "not_pending"}
        af = (available_from or "").strip()[:5] or None
        at = (available_to or "").strip()[:5] or None
        if accept:
            # δέσμευσε ό,τι είναι ΗΔΗ σε απόθεμα (τα backorder θα έρθουν) → «Νέα» πλέον
            cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
            in_stock = [{"barcode": it["barcode"], "qty": it["qty"]}
                        for it in order.get("items", []) if not it.get("backorder")]
            if in_stock:
                await cat.reserve_stock(in_stock)   # best-effort (backorder ούτως ή άλλως έρχεται)
            await self.update_one({"_id": oid}, {
                "$set": {"status": "new", "available_date": available_date,
                         "available_from": af, "available_to": at, "updated_at": _now()},
                "$push": {"status_history": {"status": "new", "at": _now()}}})
            win = self._fmt_window(available_date, af, at)
            msg = (f"Η παραγγελία σου εγκρίθηκε! Διαθέσιμη ~{win}." if win
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

    async def set_internal_note(self, order_id: str, note: str) -> dict:
        """Εσωτερική σημείωση φαρμακοποιού — ΜΟΝΟ για το φαρμακείο (ΔΕΝ φαίνεται στον πελάτη· βλ. my_orders)."""
        from bson import ObjectId
        try:
            oid = ObjectId(order_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        await self.update_one({"_id": oid}, {"$set": {"internal_note": (note or "").strip()[:1000] or None,
                                                      "updated_at": _now()}})
        return {"ok": True}

    async def send_customer_message(self, order_id: str, text: str) -> dict:
        """Μήνυμα προς τον πελάτη για την παραγγελία (ορατό στον πελάτη + push). Ξεχωριστό από την
        εσωτερική σημείωση. Κρατά ιστορικό μηνυμάτων στην παραγγελία."""
        from bson import ObjectId
        txt = (text or "").strip()[:1000]
        if not txt:
            return {"ok": False, "error": "empty"}
        try:
            oid = ObjectId(order_id)
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "bad_id"}
        order = await self.find_one({"_id": oid})
        if not order:
            return {"ok": False, "error": "not_found"}
        entry = {"text": txt, "at": _now(), "from": "pharmacy"}
        await self.update_one({"_id": oid}, {"$set": {"customer_message": txt, "updated_at": _now()},
                                             "$push": {"messages": entry}})
        if order.get("account_id"):
            from app.services import push_service
            await push_service.send_to_account(order["account_id"],
                                               title="💬 Μήνυμα από το φαρμακείο", body=txt, url="/portal")
        return {"ok": True}

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

    async def _award_shop_bonus(self, order: dict) -> None:
        """Bonus πόντοι πιστότητας για είδη με points_multiplier>1. Ενεργό μόνο αν το πρόγραμμα
        είναι enabled (opt-in). bonus = Σ(€γραμμής × (mult−1)) πόντοι × αξία πόντου. Idempotent ανά παραγγελία."""
        if not order.get("patient_ref"):
            return
        from app.repositories.loyalty import LoyaltyRepository
        loy = LoyaltyRepository(tenant_id=self.tenant_id)
        cfg = await loy.config()
        cpp = int(cfg.get("cents_per_point") or 0)
        if not cfg.get("enabled") or cpp <= 0:
            return
        cat = PharmacyCatalogRepository(tenant_id=self.tenant_id)
        bonus_pts = 0.0
        for it in order.get("items", []):
            prod = await cat.get(it.get("barcode"))
            mult = float((prod or {}).get("points_multiplier") or 1)
            if mult > 1:
                bonus_pts += (int(it.get("line_cents") or 0) / 100) * (mult - 1)
        bonus_cents = round(bonus_pts) * cpp
        if bonus_cents > 0:
            await loy._credit_once(str(order["patient_ref"]), bonus_cents, source="shop_bonus",
                                   dedup_key=f"shopbonus:{order['_id']}", reason="Bonus πόντοι e-shop 🎁")

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
        # Παράδοση → bonus πόντοι για είδη με points_multiplier>1 (καθαρά πωλησιακό κίνητρο· idempotent).
        if status == "delivered" and order.get("status") != "delivered":
            await self._award_shop_bonus(order)
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
