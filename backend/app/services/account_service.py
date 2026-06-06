"""Self-service account actions for the logged-in tenant user:
profile view/update, change password, and forgot/reset password (email token).

Secrets never leave the server: passwords are Argon2-hashed; reset tokens are random,
single-use, time-limited, and stored hashed-by-value (opaque) on the user doc.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId

from app.core.db import shared_db
from app.core.security import hash_password, verify_password
from app.services import mailer

_RESET_TTL_MIN = 60
_RESET_URL = "https://app.rxvision.gr/reset-password?token={token}"


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001
        return value


class AccountError(Exception):
    pass


class AccountService:
    # ── profile ────────────────────────────────────────────
    async def get_profile(self, user_id: str) -> dict:
        u = await shared_db()["users"].find_one({"_id": _oid(user_id)})
        if not u:
            raise AccountError("user_not_found")
        return {
            "full_name": u.get("full_name", ""),
            "email": u.get("email", ""),
            "phone": u.get("phone", ""),
            "mfa_enabled": bool(u.get("mfa_enabled", False)),
        }

    async def update_profile(self, user_id: str, *, full_name: str | None,
                             phone: str | None) -> dict:
        sets: dict = {"updated_at": _now()}
        if full_name is not None:
            sets["full_name"] = full_name.strip()
        if phone is not None:
            sets["phone"] = phone.strip()
        await shared_db()["users"].update_one({"_id": _oid(user_id)}, {"$set": sets})
        return await self.get_profile(user_id)

    # ── change password (authenticated) ────────────────────
    async def change_password(self, user_id: str, current: str, new: str) -> None:
        if len(new) < 8:
            raise AccountError("weak_password")
        db = shared_db()
        u = await db["users"].find_one({"_id": _oid(user_id)})
        if not u or not verify_password(current, u.get("password_hash", "")):
            raise AccountError("wrong_current_password")
        await db["users"].update_one({"_id": u["_id"]}, {"$set": {
            "password_hash": hash_password(new), "updated_at": _now()},
            "$inc": {"refresh_token_version": 1}})  # invalidate other sessions

    # ── forgot / reset (public) ────────────────────────────
    async def forgot_password(self, email: str) -> None:
        """Always succeeds (don't leak account existence). Emails a reset link if the
        account exists and SMTP is configured."""
        db = shared_db()
        u = await db["users"].find_one({"email": email, "status": "active"})
        if not u:
            return
        token = secrets.token_urlsafe(32)
        await db["users"].update_one({"_id": u["_id"]}, {"$set": {
            "reset_token": token, "reset_expires": _now() + timedelta(minutes=_RESET_TTL_MIN)}})
        link = _RESET_URL.format(token=token)
        html = (f"<p>Γεια σας {u.get('full_name','')},</p>"
                f"<p>Λάβαμε αίτημα επαναφοράς κωδικού για τον λογαριασμό σας στο RxVision.</p>"
                f"<p><a href='{link}'>Ορίστε νέο κωδικό</a> (ισχύει για {_RESET_TTL_MIN} λεπτά).</p>"
                f"<p>Αν δεν το ζητήσατε εσείς, αγνοήστε αυτό το email.</p>")
        try:
            await mailer.send_email(email, "RxVision — Επαναφορά κωδικού", html)
        except Exception:  # noqa: BLE001 — SMTP may be unconfigured; stay silent
            pass

    async def reset_password(self, token: str, new: str) -> None:
        if len(new) < 8:
            raise AccountError("weak_password")
        db = shared_db()
        u = await db["users"].find_one({"reset_token": token})
        if not u or (u.get("reset_expires") and u["reset_expires"] < _now()):
            raise AccountError("invalid_or_expired_token")
        await db["users"].update_one({"_id": u["_id"]}, {
            "$set": {"password_hash": hash_password(new), "updated_at": _now()},
            "$unset": {"reset_token": "", "reset_expires": ""},
            "$inc": {"refresh_token_version": 1}})
