"""Patient-portal auth — self-registration (no pharmacist approval), login, pharmacy switch, refresh.

The ΑΜΚΑ is the universal key: on register/login we (re)scan the network and auto-link every pharmacy
where the patient already has records. The patient then picks an active pharmacy; the access token is
minted for that pharmacy (tenant + pseudonymised patient ref).
"""
from __future__ import annotations

from app.core.security import (
    create_patient_refresh_token, create_patient_token, decode_patient_token,
    hash_password, verify_password,
)
from app.repositories.patient_portal import PatientAccountRepository


class PatientError(Exception):
    pass


class PatientAuthService:
    def __init__(self):
        self.repo = PatientAccountRepository()

    async def register(self, *, first_name: str, last_name: str, email: str,
                       phone: str | None, amka: str, password: str,
                       pharmacy: str | None = None) -> dict:
        email = (email or "").strip().lower()
        amka = (amka or "").strip()
        if await self.repo.get_by_email(email):
            raise PatientError("email_exists")
        if await self.repo.get_by_amka(amka):
            raise PatientError("amka_exists")
        acc = await self.repo.create(
            first_name=first_name, last_name=last_name, email=email,
            phone=phone, amka=amka, password_hash=hash_password(password))
        # came in via a pharmacy's QR → that pharmacy becomes the «αγαπημένο» (default active)
        if pharmacy:
            await self.repo.set_favorite(acc["_id"], pharmacy)
            acc["favorite_tenant_id"] = pharmacy
        links = await self.repo.refresh_links(acc["_id"], amka)
        return self._session(acc, links)

    async def admin_create(self, *, first_name: str, last_name: str, email: str,
                           phone: str | None, amka: str) -> dict:
        """Pharmacist-initiated account creation for a patient (my.rxvision.gr). Generates a temp
        password to hand to the patient; returns it ONCE. Auto-links the patient's pharmacies."""
        email = (email or "").strip().lower()
        amka = (amka or "").strip()
        if not email or "@" not in email:
            return {"ok": False, "error": "bad_email"}
        if await self.repo.get_by_amka(amka):
            return {"ok": False, "error": "amka_exists"}
        if await self.repo.get_by_email(email):
            return {"ok": False, "error": "email_exists"}
        import secrets
        pw = secrets.token_urlsafe(8)
        acc = await self.repo.create(
            first_name=first_name, last_name=last_name, email=email,
            phone=phone, amka=amka, password_hash=hash_password(pw))
        await self.repo.refresh_links(acc["_id"], amka)
        return {"ok": True, "email": email, "temp_password": pw}

    async def login(self, email: str, password: str) -> dict | None:
        acc = await self.repo.get_by_email((email or "").strip().lower())
        if not acc or not verify_password(password, acc.get("password_hash", "")):
            return None
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    async def select_pharmacy(self, account_id: str, tenant_id: str) -> str | None:
        """Re-mint an access token for a different (already-linked) pharmacy."""
        link = await self.repo.link_for(account_id, tenant_id)
        if not link:
            return None
        return create_patient_token(account_id=str(account_id), tenant_id=tenant_id,
                                    patient_ref=str(link["patient_ref"]))

    async def refresh(self, refresh_token: str) -> dict | None:
        try:
            claims = decode_patient_token(refresh_token)
        except ValueError:
            return None
        if claims.get("scope") != "refresh" or not claims.get("pat"):
            return None
        acc = await self.repo.get(claims.get("sub"))
        if not acc or claims.get("ver", 0) != acc.get("refresh_token_version", 0):
            return None
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    def _session(self, acc: dict, links: list[dict]) -> dict:
        account_id = str(acc["_id"])
        # prefer the «αγαπημένο» pharmacy (set via a counter QR) as the default active one
        fav = acc.get("favorite_tenant_id")
        active = next((l for l in links if l.get("tenant_id") == fav), None) or (links[0] if links else None)
        access = (create_patient_token(account_id=account_id, tenant_id=active["tenant_id"],
                                       patient_ref=active["patient_ref"]) if active else None)
        refresh = create_patient_refresh_token(account_id=account_id,
                                               version=acc.get("refresh_token_version", 0))
        return {
            "access_token": access,
            "refresh_token": refresh,
            "active_tenant": active["tenant_id"] if active else None,
            "pharmacies": links,
            "profile": {
                "first_name": acc.get("first_name"), "last_name": acc.get("last_name"),
                "email": acc.get("email"), "phone": acc.get("phone"),
            },
        }
