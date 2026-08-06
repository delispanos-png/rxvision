"""Onboarding — self-service pharmacy (tenant) registration.

Creates tenant + free trial subscription + system roles + owner user, then logs in.
Country drives locale/timezone and (downstream) the allowed ingestion source
(GR→ΗΔΥΚΑ, CY→ΓΕΣΥ) via sources.py.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db
from app.core.security import hash_password
from app.services.auth_service import AuthService
from app.services.rbac_seed import seed_rbac

_TRIAL_DAYS = 14
_MODULES = [
    "dashboard", "prescription_analytics", "doctor_analytics", "patient_analytics",
    "icd10_analytics", "profitability", "future_prescriptions", "order_suggestions",
    "monthly_closing", "ingestion", "pharmacyone",
    # pharmacat + patient_portal are OPT-IN (enabled per-tenant by the platform admin), not default.
]
_COUNTRY_SETTINGS = {
    "GR": {"locale": "el-GR", "timezone": "Europe/Athens", "currency": "EUR"},
    "CY": {"locale": "el-CY", "timezone": "Asia/Nicosia", "currency": "EUR"},
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "pharmacy"
    return f"{base[:32]}-{uuid.uuid4().hex[:6]}"


class OnboardingError(Exception):
    pass


class OnboardingService:
    async def register(self, *, pharmacy_name: str, country: str, email: str,
                       password: str, full_name: str, company: dict | None = None,
                       package_code: str | None = None, billing_cycle: str | None = None,
                       sla: str | None = None, seats: int | None = None,
                       payment_method: str | None = None,
                       addons: list[str] | None = None,
                       activate: bool = False,
                       viva_transaction_id: str | None = None,
                       reactivate_tenant_id: str | None = None,
                       accepted_terms: bool | None = None,
                       terms_version: str | None = None) -> dict:
        """Δημιουργεί tenant + συνδρομή + owner + tokens. activate=True → ΠΛΗΡΩΜΕΝΗ, ενεργή συνδρομή
        (χωρίς trial· κάρτα αποθηκευμένη μέσω viva_transaction_id). activate=False → legacy trial.
        reactivate_tenant_id → ΔΕΝ φτιάχνει νέο tenant· επαναφέρει ΥΠΑΡΧΟΝΤΑ (ληγμένο/trial) σε ενεργή
        πληρωμένη συνδρομή (ο πελάτης που το trial του έληξε & αγοράζει κανονικό πακέτο)."""
        country = country.upper()
        if country not in _COUNTRY_SETTINGS:
            raise OnboardingError("unsupported_country")
        db = shared_db()
        reactivating = bool(reactivate_tenant_id)
        existing_user = await db["users"].find_one({"email": email})
        if existing_user and not reactivating:
            raise OnboardingError("email_already_registered")

        tid = reactivate_tenant_id or _slugify(pharmacy_name)
        settings = {**_COUNTRY_SETTINGS[country], "fiscal_month_close_day": 31}

        tenant_doc = {
            "name": pharmacy_name, "slug": tid, "country": country,
            "status": "active" if activate else "trial", "isolation_tier": "shared", "settings": settings,
            "billing_profile": company or {}, "updated_at": _now(),
        }
        if reactivating:
            await db["tenants"].update_one({"_id": tid}, {"$set": tenant_doc})
        else:
            await db["tenants"].insert_one({
                "_id": tid, "modules": {}, "credentials_ref": {"hdika": None, "gesy": None},
                "created_at": _now(), **tenant_doc,
            })

        # subscription — from the chosen package (else the legacy free trial)
        pkg = await db["packages"].find_one({"_id": package_code}) if package_code else None
        cycle = billing_cycle or "monthly"
        yearly = cycle == "yearly"
        # paid activation → ΚΑΜΙΑ δοκιμή· η περίοδος τρέχει από τώρα (μήνας/έτος). Αλλιώς legacy trial.
        trial_days = 0 if activate else int((pkg or {}).get("trial_days", _TRIAL_DAYS))
        period_days = (365 if yearly else 30) if activate else trial_days
        price = (pkg or {}).get("price_yearly" if yearly else "price_monthly", 0) if pkg else 0
        # seats & cost breakdown: base package + chosen SLA tier + extra concurrent users
        sla_code = sla or (pkg or {}).get("sla", "basic")
        max_seats = int((pkg or {}).get("seats", 1) or 1)        # ΜΕΓΙΣΤΟ όριο πλάνου («έως N»)
        extra_rate = int((pkg or {}).get("extra_user_price_yearly" if yearly else "extra_user_price", 0) or 0)
        included_free = 1                                        # ΒΑΣΗ: 1 δωρεάν ταυτόχρονος χρήστης σε ΚΑΘΕ πλάνο
        chosen_seats = min(max_seats, max(1, int(seats or 1)))   # default 1· πάντα cap στο max του πλάνου
        extra_users = max(0, chosen_seats - included_free)       # extra = πάνω από τη βάση (1) → χρεώσιμα
        sla_doc = await db["sla_tiers"].find_one({"_id": sla_code}) or {}
        sla_price = int(sla_doc.get("price_yearly" if yearly else "price_monthly", 0) or 0)
        extra_total = extra_users * extra_rate
        # à-la-carte add-ons chosen at signup → validate vs catalog, skip any already in the plan
        chosen_addons: list[str] = []
        addons_total = 0
        addon_overrides: dict[str, str] = {}
        if addons:
            from app.services import addon_service
            cat = {a["_id"]: a for a in await addon_service.catalog()}
            incl = set((pkg or {}).get("modules") or _MODULES)
            for aid in addons:
                a = cat.get(aid)
                if not a or aid in incl or aid in chosen_addons:
                    continue
                chosen_addons.append(aid)
                addons_total += int(a.get("price_yearly" if yearly else "price_monthly", 0) or 0)
                addon_overrides[aid] = "enabled"
        if addon_overrides:   # entitlement = tenant module overrides (same gating as everywhere)
            await db["tenants"].update_one({"_id": tid}, {"$set": {f"modules.{k}": v for k, v in addon_overrides.items()}})
        price_total = int(price) + sla_price + extra_total + addons_total
        sub_fields = {
            "plan": package_code or "free_trial",
            "status": "active" if activate else ("trialing" if trial_days else "active"),
            "billing_cycle": cycle, "sla": sla_code,
            "trial_ends_at": None if activate else _now() + timedelta(days=trial_days), "seats": chosen_seats,
            "price_per_pharmacy": price, "currency": "EUR",
            "price_includes_vat": bool((pkg or {}).get("price_includes_vat")),   # καθαρές τιμές → +ΦΠΑ στη χρέωση
            "addons": chosen_addons, "addons_total": addons_total,
            # cost analysis as agreed at signup (cents, for the chosen cycle)
            "sla_price": sla_price, "extra_users": extra_users, "extra_user_rate": extra_rate,
            "extra_users_total": extra_total, "price_total": price_total,
            "modules_included": (pkg or {}).get("modules") or _MODULES,
            "limits": {"pharmacies": 1, "history_months": 36, "api_sync": True},
            "current_period_end": _now() + timedelta(days=period_days),
            # paid activation → κάρτα αποθηκευμένη στη Viva (recurring seed = viva_transaction_id)
            "payment_provider": "viva" if activate else None,
            "payment_status": "card_saved" if activate else "trial",
            "viva_transaction_id": viva_transaction_id if activate else None,
            "started_at": _now(),
            # αποδοχή Όρων Χρήσης κατά τη δημιουργία της συνδρομής (GDPR/νομική τεκμηρίωση)
            "accepted_terms": bool(accepted_terms),
            "terms_version": terms_version,
            "terms_accepted_at": _now() if accepted_terms else None,
            # how the customer chose to pay at signup: "card" (Viva) or "bank" (manual transfer)
            "payment_method": payment_method or "card",
        }
        if reactivating:
            # καθάρισε προηγούμενα κλειδώματα λήξης· βάλε το νέο πακέτο ως ενεργό (upsert για ασφάλεια)
            await db["subscriptions"].update_one(
                {"tenant_id": tid}, {"$set": {**sub_fields, "reactivated_at": _now()},
                                     "$unset": {"expired_at": "", "failed_attempts": ""}}, upsert=True)
        else:
            await db["subscriptions"].insert_one({"tenant_id": tid, "created_at": _now(), **sub_fields})

        owner_role = await db["roles"].find_one({"tenant_id": tid, "key": "owner"})
        if not owner_role:                       # νέος tenant (ή reactivation χωρίς roles) → seed RBAC
            await seed_rbac(tenant_id=tid)
            owner_role = await db["roles"].find_one({"tenant_id": tid, "key": "owner"})
        if reactivating and existing_user:       # υπάρχων χρήστης → νέος κωδικός + ενεργός + owner ρόλος
            await db["users"].update_one({"_id": existing_user["_id"]}, {"$set": {
                "password_hash": hash_password(password), "status": "active",
                "full_name": full_name or existing_user.get("full_name"),
                "role_ids": list({*(existing_user.get("role_ids") or []), owner_role["_id"]}),
                "updated_at": _now()}, "$inc": {"refresh_token_version": 1}})
        else:                                    # νέος χρήστης (νέα εγγραφή ή reactivation με νέο email)
            await db["users"].insert_one({
                "tenant_id": tid, "email": email, "password_hash": hash_password(password),
                "full_name": full_name, "role_ids": [owner_role["_id"]], "pharmacy_ids": [],
                "status": "active", "mfa_enabled": False, "refresh_token_version": 0,
                "created_at": _now(), "updated_at": _now(),
            })

        tokens = await AuthService().login(email, password, None)
        return {
            "tenant_id": tid, "country": country, "reactivated": reactivating,
            "ingestion_source": "HDIKA" if country == "GR" else "GESY",
            **(tokens or {}),
        }

    # ── Φάση 1: πληρωμή-πρώτα (pending registration → materialize μετά την πληρωμή) ──────────
    async def afm_exists(self, afm: str) -> bool:
        """Υπάρχει ήδη tenant με αυτό το ΑΦΜ; (για μπλοκ διπλής εγγραφής)."""
        afm = (afm or "").strip()
        if not afm:
            return False
        return await shared_db()["tenants"].count_documents({"billing_profile.afm": afm}) > 0

    async def reactivation_target(self, email: str, afm: str = "") -> dict | None:
        """Βρίσκει υπάρχοντα λογαριασμό (με email ή ΑΦΜ) και λέει αν ΔΙΚΑΙΟΥΤΑΙ επανενεργοποίηση.
        Επιστρέφει {tenant_id, blocked, had_trial}:
          • blocked=True → έχει ΕΝΕΡΓΗ ΠΛΗΡΩΜΕΝΗ συνδρομή (δεν ξαναγράφεται· να μπει από το app).
          • blocked=False → trial/ληγμένος → επιτρέπεται αγορά κανονικού πακέτου στον ΙΔΙΟ tenant.
        None αν δεν υπάρχει καθόλου (κανονική νέα εγγραφή)."""
        db = shared_db()
        tid = None
        if email:
            u = await db["users"].find_one({"email": email}, {"tenant_id": 1})
            if u:
                tid = u.get("tenant_id")
        afm = (afm or "").strip()
        if not tid and afm:
            t = await db["tenants"].find_one({"billing_profile.afm": afm}, {"_id": 1})
            tid = t.get("_id") if t else None
        if not tid:
            return None
        sub = await db["subscriptions"].find_one({"tenant_id": tid})
        pend = sub.get("current_period_end") if sub else None
        paid_active = bool(sub and sub.get("status") == "active"
                           and sub.get("plan") not in (None, "free_trial")
                           and sub.get("payment_status") not in ("trial", "expired", None)
                           and (pend is None or pend > _now()))
        return {"tenant_id": tid, "blocked": paid_active, "had_trial": bool(sub)}

    async def get_pending(self, pending_id: str) -> dict | None:
        return await shared_db()["pending_registrations"].find_one({"_id": pending_id})

    async def create_pending(self, *, pharmacy_name: str, country: str, owner_email: str,
                             owner_name: str, company: dict, package_code: str | None,
                             billing_cycle: str | None, sla: str | None, seats: int | None,
                             addons: list[str] | None, payment_method: str,
                             accepted_terms: bool = False, terms_version: str | None = None) -> dict:
        """Προσωρινή εγγραφή ΠΡΙΝ την πληρωμή — ΔΕΝ δημιουργεί λογαριασμό. Επιστρέφει {pending_id,
        amount_cents}. Ο λογαριασμός υλοποιείται με `materialize()` μετά την επιβεβαίωση πληρωμής."""
        country = (country or "GR").upper()
        if country not in _COUNTRY_SETTINGS:
            raise OnboardingError("unsupported_country")
        db = shared_db()
        afm = ((company or {}).get("afm") or "").strip()
        # REACTIVATION: αν υπάρχει ήδη λογαριασμός με ληγμένο/trial → επιτρέπεται αγορά ΚΑΝΟΝΙΚΟΥ πακέτου
        # στον ΙΔΙΟ tenant (ο πελάτης που το trial του έληξε & θέλει να συνεχίσει). ΜΟΝΟ ενεργή πληρωμένη
        # συνδρομή μπλοκάρει (τότε να το κάνει μέσα από το app, όχι νέα εγγραφή).
        reactivate_tid = None
        existing = await self.reactivation_target(owner_email, afm)
        if existing:
            if existing["blocked"]:
                raise OnboardingError("email_already_registered")
            reactivate_tid = existing["tenant_id"]
        pkg = await db["packages"].find_one({"_id": package_code}) if package_code else None
        yearly = (billing_cycle == "yearly")
        price = int((pkg or {}).get("price_yearly" if yearly else "price_monthly", 0) or 0)
        max_seats = int((pkg or {}).get("seats", 1) or 1)
        chosen_seats = min(max_seats, max(1, int(seats or 1)))
        extra_rate = int((pkg or {}).get("extra_user_price_yearly" if yearly else "extra_user_price", 0) or 0)
        extra_total = max(0, chosen_seats - 1) * extra_rate
        sla_code = sla or (pkg or {}).get("sla", "basic")
        sla_doc = await db["sla_tiers"].find_one({"_id": sla_code}) or {}
        sla_price = int(sla_doc.get("price_yearly" if yearly else "price_monthly", 0) or 0)
        addons_total = 0
        if addons:
            from app.services import addon_service
            cat = {a["_id"]: a for a in await addon_service.catalog()}
            for aid in addons:
                a = cat.get(aid)
                if a:
                    addons_total += int(a.get("price_yearly" if yearly else "price_monthly", 0) or 0)
        # Καθαρό σύνολο → χρεώσιμο ΜΕ ΦΠΑ (αν οι τιμές είναι καθαρές). create_for_payment αφαιρεί ΦΠΑ στο παραστατικό.
        from app.services.invoice_service import gross_from_price
        amount = gross_from_price(int(price) + sla_price + extra_total + addons_total,
                                  bool((pkg or {}).get("price_includes_vat")), country)
        # Δωρεάν trial πακέτο (μηδενικό κόστος): καμία πληρωμή → pending «paid» κατευθείαν (→ credentials).
        is_trial = amount <= 0
        # Reactivation ΔΕΝ ξαναδίνει δωρεάν trial — ο πελάτης πρέπει να επιλέξει ΠΛΗΡΩΜΕΝΟ πακέτο.
        if reactivate_tid and is_trial:
            raise OnboardingError("already_had_trial")
        status = "paid" if is_trial else ("awaiting_payment" if payment_method == "card" else "awaiting_bank_approval")
        pid = uuid.uuid4().hex
        await db["pending_registrations"].insert_one({
            "_id": pid, "status": status, "is_trial": is_trial,
            "pharmacy_name": pharmacy_name, "country": country,
            "owner_email": owner_email, "owner_name": owner_name, "company": company or {},
            "package_code": package_code, "billing_cycle": billing_cycle or "monthly", "sla": sla_code,
            "seats": chosen_seats, "addons": addons or [], "payment_method": payment_method,
            "amount_cents": amount, "created_at": _now(),
            "accepted_terms": bool(accepted_terms), "terms_version": terms_version,
            "terms_accepted_at": _now() if accepted_terms else None,
            "reactivate_tenant_id": reactivate_tid,   # → materialize επαναφέρει τον ΥΠΑΡΧΟΝΤΑ tenant
            "expires_at": _now() + timedelta(hours=2),
        })
        return {"pending_id": pid, "amount_cents": amount, "is_trial": is_trial,
                "reactivation": bool(reactivate_tid)}

    async def mark_pending_paid(self, pending_id: str, viva_transaction_id: str | None = None) -> bool:
        """Καλείται από το Viva webhook (signup:<id>) → η pending γίνεται `paid` (idempotent).
        Στέλνει email με link ολοκλήρωσης — καλύπτει IRIS (ασύγχρονο, έως 20') & τυχόν εγκατάλειψη."""
        db = shared_db()
        r = await db["pending_registrations"].update_one(
            {"_id": pending_id, "status": {"$in": ["awaiting_payment", "awaiting_bank_approval"]}},
            # paid → επέκταση παραθύρου (7μέρες) ώστε να ΜΗΝ χαθεί αν ο πελάτης δεν ολοκληρώσει άμεσα
            {"$set": {"status": "paid", "viva_transaction_id": viva_transaction_id, "paid_at": _now(),
                      "expires_at": _now() + timedelta(days=7)}})
        if r.modified_count > 0:
            await self._send_completion_email(await db["pending_registrations"].find_one({"_id": pending_id}))
        return r.modified_count > 0

    async def list_incomplete(self) -> list[dict]:
        """Εκκρεμείς εγγραφές (δεν ολοκληρώθηκαν): πλήρωσαν αλλά δεν όρισαν κωδικό, ή εκκρεμεί πληρωμή."""
        db = shared_db()
        return [r async for r in db["pending_registrations"].find(
            {"completed_tenant_id": {"$exists": False}, "status": {"$ne": "completed"},
             "is_trial": {"$ne": True}}).sort("created_at", -1).limit(300)]

    async def resend_completion(self, pending_id: str) -> bool:
        """Ξαναστέλνει το link ολοκλήρωσης σε PAID εκκρεμή εγγραφή (+ επεκτείνει το παράθυρο)."""
        db = shared_db()
        p = await db["pending_registrations"].find_one({"_id": pending_id})
        if not p or p.get("completed_tenant_id") or p.get("status") != "paid":
            return False
        await db["pending_registrations"].update_one(
            {"_id": pending_id}, {"$set": {"expires_at": _now() + timedelta(days=7)}})
        await self._send_completion_email(p)
        return True

    async def _send_completion_email(self, p: dict | None) -> None:
        """Email «η πληρωμή επιβεβαιώθηκε — όρισε κωδικό & ολοκλήρωσε». Best-effort (ποτέ δεν σπάει)."""
        if not p or not p.get("owner_email"):
            return
        try:
            from app.services import mailer
            link = f"https://app.rxvision.gr/register?pending={p['_id']}"
            html = (f"<p>Γεια σας {p.get('owner_name') or ''},</p>"
                    f"<p>Η πληρωμή για τη συνδρομή <b>{p.get('pharmacy_name') or ''}</b> στο RxVision "
                    f"επιβεβαιώθηκε. Ολοκληρώστε την εγγραφή ορίζοντας τον κωδικό σας:</p>"
                    f"<p><a href=\"{link}\">Ολοκλήρωση εγγραφής</a></p>"
                    f"<p style=\"color:#64748b;font-size:12px\">Ή αντιγράψτε τον σύνδεσμο: {link}</p>")
            await mailer.send_email(p["owner_email"], "RxVision — Ολοκληρώστε την εγγραφή σας", html)
        except Exception:  # noqa: BLE001
            pass

    async def materialize(self, *, pending_id: str, password: str, full_name: str | None = None) -> dict:
        """Δημιουργεί ΤΕΛΙΚΑ τον λογαριασμό (μετά από επιβεβαιωμένη πληρωμή) βάζοντας ο πελάτης κωδικό."""
        db = shared_db()
        p = await db["pending_registrations"].find_one({"_id": pending_id})
        if not p:
            raise OnboardingError("pending_not_found")
        if p.get("status") not in ("paid", "approved"):
            raise OnboardingError("payment_not_confirmed")
        if p.get("completed_tenant_id"):
            raise OnboardingError("already_completed")
        res = await self.register(
            pharmacy_name=p["pharmacy_name"], country=p["country"],
            email=p["owner_email"], password=password,
            full_name=full_name or p.get("owner_name") or p["owner_email"],
            company=p.get("company"), package_code=p.get("package_code"),
            billing_cycle=p.get("billing_cycle"), sla=p.get("sla"),
            seats=p.get("seats"), payment_method=p.get("payment_method") or "card",
            addons=p.get("addons"),
            # trial πακέτο → trialing (activate=False)· paid → active με αποθηκευμένη κάρτα
            activate=not p.get("is_trial"),
            viva_transaction_id=p.get("viva_transaction_id"),
            reactivate_tenant_id=p.get("reactivate_tenant_id"),
            accepted_terms=p.get("accepted_terms"), terms_version=p.get("terms_version"))
        await db["pending_registrations"].update_one(
            {"_id": pending_id}, {"$set": {"status": "completed",
                                           "completed_tenant_id": res["tenant_id"], "completed_at": _now()}})
        # Παραστατικό πρώτης συνδρομής (μόνο paid — όχι δωρεάν trial).
        if not p.get("is_trial") and p.get("amount_cents"):
            from app.services import invoice_service
            await invoice_service.create_for_payment(
                tenant_id=res["tenant_id"], kind="subscription", gross_cents=int(p["amount_cents"]),
                description="Συνδρομή RxVision (πρώτη περίοδος)",
                payment={"method": p.get("payment_method") or "card", "provider": "viva",
                         "transaction_id": p.get("viva_transaction_id")})
        return res
