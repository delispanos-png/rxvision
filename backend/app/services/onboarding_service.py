"""Onboarding — self-service pharmacy (tenant) registration.

Creates tenant + free trial subscription + system roles + owner user, then logs in.
Country drives locale/timezone and (downstream) the allowed ingestion source
(GR→ΗΔΙΚΑ, CY→ΓΕΣΥ) via sources.py.
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
                       sla: str | None = None) -> dict:
        country = country.upper()
        if country not in _COUNTRY_SETTINGS:
            raise OnboardingError("unsupported_country")
        db = shared_db()
        if await db["users"].find_one({"email": email}):
            raise OnboardingError("email_already_registered")

        tid = _slugify(pharmacy_name)
        settings = {**_COUNTRY_SETTINGS[country], "fiscal_month_close_day": 31}

        await db["tenants"].insert_one({
            "_id": tid, "name": pharmacy_name, "slug": tid, "country": country,
            "status": "trial", "isolation_tier": "shared", "settings": settings,
            "modules": {}, "credentials_ref": {"hdika": None, "gesy": None},
            "billing_profile": company or {},
            "created_at": _now(), "updated_at": _now(),
        })

        # subscription — from the chosen package (else the legacy free trial)
        pkg = await db["packages"].find_one({"_id": package_code}) if package_code else None
        cycle = billing_cycle or "monthly"
        trial_days = int((pkg or {}).get("trial_days", _TRIAL_DAYS))
        price = (pkg or {}).get("price_yearly" if cycle == "yearly" else "price_monthly", 0) if pkg else 0
        await db["subscriptions"].insert_one({
            "tenant_id": tid, "plan": package_code or "free_trial",
            "status": "trialing" if trial_days else "active",
            "billing_cycle": cycle, "sla": sla or (pkg or {}).get("sla", "basic"),
            "trial_ends_at": _now() + timedelta(days=trial_days), "seats": (pkg or {}).get("seats", 3),
            "price_per_pharmacy": price, "currency": "EUR", "addons": [],
            "modules_included": (pkg or {}).get("modules") or _MODULES,
            "limits": {"pharmacies": 1, "history_months": 36, "api_sync": True},
            "current_period_end": _now() + timedelta(days=trial_days), "created_at": _now(),
            "payment_provider": None, "payment_status": "trial",
        })
        await seed_rbac(tenant_id=tid)
        owner_role = await db["roles"].find_one({"tenant_id": tid, "key": "owner"})
        await db["users"].insert_one({
            "tenant_id": tid, "email": email, "password_hash": hash_password(password),
            "full_name": full_name, "role_ids": [owner_role["_id"]], "pharmacy_ids": [],
            "status": "active", "mfa_enabled": False, "refresh_token_version": 0,
            "created_at": _now(), "updated_at": _now(),
        })

        tokens = await AuthService().login(email, password, None)
        return {
            "tenant_id": tid, "country": country,
            "ingestion_source": "HDIKA" if country == "GR" else "GESY",
            **(tokens or {}),
        }
