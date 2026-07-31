"""Patient-portal auth — self-registration (no pharmacist approval), login, pharmacy switch, refresh.

The ΑΜΚΑ is the universal key: on register/login we (re)scan the network and auto-link every pharmacy
where the patient already has records. The patient then picks an active pharmacy; the access token is
minted for that pharmacy (tenant + pseudonymised patient ref).
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.core.security import (
    create_patient_refresh_token, create_patient_token, decode_patient_token,
    hash_password, verify_password,
)
from app.repositories.patient_portal import PatientAccountRepository

_OTP_TTL_MIN = 10
_OTP_MAX_ATTEMPTS = 5
_PORTAL_BASE = "https://my.rxvision.gr"


class PatientError(Exception):
    pass


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _friendly_password(length: int = 10) -> str:
    """Εύκολος κωδικός για πληκτρολόγηση σε κινητό: μόνο αριθμοί + μικρά/κεφαλαία, ΧΩΡΙΣ σύμβολα
    και ΧΩΡΙΣ μπερδεμένους χαρακτήρες (0/O, 1/l/I). Εγγυάται ≥1 από κάθε κατηγορία."""
    import random
    lower = "abcdefghijkmnpqrstuvwxyz"   # χωρίς l
    upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"   # χωρίς I, O
    digits = "23456789"                  # χωρίς 0, 1
    pool = lower + upper + digits
    rng = random.SystemRandom()
    chars = [rng.choice(lower), rng.choice(upper), rng.choice(digits)]
    chars += [rng.choice(pool) for _ in range(max(0, length - 3))]
    rng.shuffle(chars)
    return "".join(chars)


def _hash_otp(code: str) -> str:
    return hashlib.sha256(f"{settings.JWT_SECRET}:{code}".encode()).hexdigest()


def _mask_email(e: str) -> str:
    e = (e or "").strip()
    if "@" not in e:
        return ""
    name, _, dom = e.partition("@")
    return f"{name[:1]}{'*' * max(1, len(name) - 1)}@{dom}"


def _mask_phone(p: str) -> str:
    p = "".join(ch for ch in (p or "") if ch.isdigit())
    return f"{p[:2]}{'*' * max(0, len(p) - 4)}{p[-2:]}" if len(p) >= 4 else ""


class PatientAuthService:
    def __init__(self):
        self.repo = PatientAccountRepository()

    async def start_registration(self, *, first_name: str, last_name: str, email: str,
                                 phone: str | None, amka: str, password: str,
                                 pharmacy: str | None = None) -> dict:
        """Step 1 of self-registration. We do NOT create the account or link anything yet: instead we
        send a one-time code to a contact the PHARMACY already holds on file for this ΑΜΚΑ, proving the
        registrant actually owns that ΑΜΚΑ (a Greek ΑΜΚΑ is semi-guessable → without this, anyone who knows
        a victim's ΑΜΚΑ could read their medical history). The pending registration lives in a short-TTL
        challenge; `verify_registration` creates the account once the code is confirmed."""
        email = (email or "").strip().lower()
        amka = (amka or "").strip()
        if await self.repo.get_by_email(email):
            raise PatientError("email_exists")
        if await self.repo.get_by_amka(amka):
            raise PatientError("amka_exists")
        contacts = await self.repo.find_amka_contacts(amka)
        emails = sorted({c["email"] for c in contacts if c.get("email")})
        mobiles = sorted({c["mobile"] for c in contacts if c.get("mobile")})
        if not emails and not mobiles:
            # No on-file contact anywhere → cannot prove ownership self-service. The pharmacy must
            # create the account at the counter (trusted `admin_create` path).
            raise PatientError("approval_required")
        code = f"{secrets.randbelow(1_000_000):06d}"
        cid = uuid.uuid4().hex
        await self.repo.create_otp_challenge({
            "_id": cid, "code_hash": _hash_otp(code), "attempts": 0,
            "first_name": first_name, "last_name": last_name, "email": email,
            "phone": (phone or "").strip(), "amka": amka,
            "password_hash": hash_password(password), "favorite_tenant_id": pharmacy,
            "created_at": _now(), "expires_at": _now() + timedelta(minutes=_OTP_TTL_MIN),
        })
        channels = await self._send_otp(code, emails, mobiles)
        if not channels:
            await self.repo.delete_otp_challenge(cid)
            raise PatientError("otp_send_failed")
        return {"otp_required": True, "challenge_id": cid, "channels": channels,
                "expires_in": _OTP_TTL_MIN * 60}

    async def _send_otp(self, code: str, emails: list[str], mobiles: list[str]) -> list[dict]:
        """Send the code to the on-file contacts. Email is free (platform SMTP); SMS goes through the
        central Apifon without per-tenant metering (tiny security volume). Returns masked hints of where
        it went (never the raw address — a wrong ΑΜΚΑ must not reveal a stranger's contact)."""
        sent: list[dict] = []
        text = (f"RxVision: ο κωδικός επιβεβαίωσης είναι {code}. Λήγει σε {_OTP_TTL_MIN} λεπτά. "
                "Αν δεν κάνατε εσείς εγγραφή, αγνοήστε το.")
        for e in emails[:2]:
            try:
                from app.services import mailer
                await mailer.send_email(
                    e, "RxVision — Κωδικός επιβεβαίωσης",
                    f"<p>Ο κωδικός επιβεβαίωσης για την εγγραφή σας στο RxVision είναι:</p>"
                    f"<p style='font-size:24px;font-weight:bold;letter-spacing:3px'>{code}</p>"
                    f"<p>Λήγει σε {_OTP_TTL_MIN} λεπτά. Αν δεν κάνατε εσείς εγγραφή, αγνοήστε το.</p>")
                sent.append({"type": "email", "hint": _mask_email(e)})
            except Exception:  # noqa: BLE001
                pass
        for m in mobiles[:2]:
            try:
                from app.services import comms
                await comms.send_otp_sms(m, text)
                sent.append({"type": "sms", "hint": _mask_phone(m)})
            except Exception:  # noqa: BLE001
                pass
        return sent

    async def verify_registration(self, challenge_id: str, code: str) -> dict:
        """Step 2: confirm the code, then create the account + auto-link the patient's pharmacies."""
        ch = await self.repo.get_otp_challenge((challenge_id or "").strip())
        if not ch or ch.get("expires_at") and ch["expires_at"] < _now():
            raise PatientError("otp_expired")
        if int(ch.get("attempts", 0)) >= _OTP_MAX_ATTEMPTS:
            await self.repo.delete_otp_challenge(challenge_id)
            raise PatientError("otp_locked")
        if not hmac.compare_digest(ch.get("code_hash", ""), _hash_otp((code or "").strip())):
            await self.repo.bump_otp_attempt(challenge_id)
            raise PatientError("otp_invalid")
        # Re-check uniqueness (a race could have registered the ΑΜΚΑ/email meanwhile).
        if await self.repo.get_by_email(ch["email"]) or await self.repo.get_by_amka(ch["amka"]):
            await self.repo.delete_otp_challenge(challenge_id)
            raise PatientError("amka_exists")
        acc = await self.repo.create(
            first_name=ch["first_name"], last_name=ch["last_name"], email=ch["email"],
            phone=ch.get("phone"), amka=ch["amka"], password_hash=ch["password_hash"])
        if ch.get("favorite_tenant_id"):
            await self.repo.set_favorite(acc["_id"], ch["favorite_tenant_id"])
            acc["favorite_tenant_id"] = ch["favorite_tenant_id"]
        await self.repo.delete_otp_challenge(challenge_id)
        links = await self.repo.refresh_links(acc["_id"], ch["amka"])
        return self._session(acc, links)

    async def admin_create(self, *, first_name: str, last_name: str, email: str,
                           phone: str | None, amka: str) -> dict:
        """Pharmacist-initiated account creation (my.rxvision.gr). Στέλνει στον πελάτη link «όρισε
        κωδικό» (email + SMS) ώστε να βάλει δικό του κωδικό, ΚΑΙ επιστρέφει έναν εύκολο προσωρινό
        κωδικό (χωρίς σύμβολα) ως εφεδρεία + υποχρεωτική αλλαγή στο 1ο login. Auto-links pharmacies."""
        email = (email or "").strip().lower()
        amka = (amka or "").strip()
        if not email or "@" not in email:
            return {"ok": False, "error": "bad_email"}
        if await self.repo.get_by_amka(amka):
            return {"ok": False, "error": "amka_exists"}
        if await self.repo.get_by_email(email):
            return {"ok": False, "error": "email_exists"}
        pw = _friendly_password()
        acc = await self.repo.create(
            first_name=first_name, last_name=last_name, email=email,
            phone=phone, amka=amka, password_hash=hash_password(pw),
            must_change_password=True)
        await self.repo.refresh_links(acc["_id"], amka)
        token = await self.repo.create_set_password_token(acc["_id"])
        link = f"{_PORTAL_BASE}/portal/set-password?token={token}" if token else None
        sent = await self._send_set_password_link(email, phone, link) if link else []
        return {"ok": True, "email": email, "temp_password": pw, "link_sent": sent}

    async def _send_set_password_link(self, email: str, phone: str | None, link: str) -> list[dict]:
        """Στέλνει το link «όρισε κωδικό» σε email (δωρεάν SMTP) + SMS (κεντρικό Apifon). Best-effort."""
        sent: list[dict] = []
        if email:
            try:
                from app.services import mailer
                await mailer.send_email(
                    email, "RxVision — Ορισμός κωδικού πρόσβασης",
                    f"<p>Δημιουργήθηκε ο λογαριασμός σας στην Πύλη Πελατών RxVision.</p>"
                    f"<p>Πατήστε για να ορίσετε τον δικό σας κωδικό πρόσβασης:</p>"
                    f"<p><a href='{link}' style='display:inline-block;padding:11px 20px;background:#4f46e5;"
                    f"color:#fff;text-decoration:none;border-radius:8px;font-weight:bold'>Ορισμός κωδικού</a></p>"
                    f"<p style='font-size:12px;color:#64748b'>ή αντιγράψτε: {link}</p>"
                    f"<p style='font-size:12px;color:#64748b'>Ο σύνδεσμος λήγει σε 7 ημέρες.</p>")
                sent.append({"type": "email", "hint": _mask_email(email)})
            except Exception:  # noqa: BLE001
                pass
        if phone:
            try:
                from app.services import comms
                await comms.send_otp_sms(
                    phone, f"RxVision: ορίστε τον κωδικό πρόσβασής σας: {link}")
                sent.append({"type": "sms", "hint": _mask_phone(phone)})
            except Exception:  # noqa: BLE001
                pass
        return sent

    async def set_password_by_token(self, token: str, new_password: str) -> dict | None:
        """Link flow (email/SMS): ο πελάτης ορίζει δικό του κωδικό μέσω single-use token → session."""
        acc = await self.repo.get_by_set_password_token((token or "").strip())
        if not acc:
            return None
        await self.repo.set_password(acc["_id"], hash_password(new_password))
        acc["must_change_password"] = False
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    async def set_own_password(self, account_id: str, new_password: str) -> dict | None:
        """Υποχρεωτική αλλαγή στο 1ο login: ο ήδη-συνδεδεμένος πελάτης ορίζει δικό του κωδικό → νέο session."""
        acc = await self.repo.get(account_id)
        if not acc:
            return None
        await self.repo.set_password(acc["_id"], hash_password(new_password))
        acc["must_change_password"] = False
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    async def change_password(self, account_id: str, current: str, new: str) -> dict | str | None:
        """Αλλαγή κωδικού από το προφίλ — απαιτεί τον ΤΡΕΧΟΝΤΑ κωδικό. Επιστρέφει νέο session,
        'bad_current' αν λάθος τρέχων, ή None αν δεν βρεθεί ο λογαριασμός."""
        acc = await self.repo.get(account_id)
        if not acc:
            return None
        if not verify_password(current, acc.get("password_hash", "")):
            return "bad_current"
        await self.repo.set_password(acc["_id"], hash_password(new))
        acc["must_change_password"] = False
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    async def login(self, email: str, password: str) -> dict | None:
        acc = await self.repo.get_by_email((email or "").strip().lower())
        if not acc or not verify_password(password, acc.get("password_hash", "")):
            return None
        links = await self.repo.refresh_links(acc["_id"], acc.get("amka", ""))
        return self._session(acc, links)

    async def logout(self, account_id: str) -> None:
        """Revoke every refresh token for this patient account (all devices)."""
        await self.repo.revoke_tokens(account_id)

    async def select_pharmacy(self, account_id: str, tenant_id: str) -> str | None:
        """Re-mint an access token for another pharmacy. Λειτουργεί για ΟΠΟΙΟΔΗΠΟΤΕ φαρμακείο με
        ενεργή πύλη: αν ο πελάτης δεν είναι ήδη linked (δεν έχει ιστορικό εκεί), δημιουργείται
        «καρτέλα χωρίς κίνηση» + link on-the-fly ώστε να μπορεί να το εξυπηρετηθεί (ερωτήματα/
        αγορές/ανάθεση). Το ιστορικό μένει ανά φαρμακείο (tenant-scoped)."""
        link = await self.repo.link_or_create(account_id, tenant_id)
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
            "must_change_password": bool(acc.get("must_change_password")),
            "pharmacies": links,
            "profile": {
                "first_name": acc.get("first_name"), "last_name": acc.get("last_name"),
                "email": acc.get("email"), "phone": acc.get("phone"),
                "address": acc.get("address"), "theme": acc.get("theme"),
                "avatar_url": f"/patient/avatar/{acc['avatar_id']}" if acc.get("avatar_id") else None,
            },
        }
