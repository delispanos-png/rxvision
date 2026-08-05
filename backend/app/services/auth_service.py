"""AuthService — login / refresh with role→permission resolution."""

from __future__ import annotations

import re
from datetime import datetime, timezone

from bson import ObjectId

from app.core.db import shared_db
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_password,
    verify_totp,
)
from app.services import session_service as sessions


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


# Core modules are tenant-admin surfaces (settings: users/roles, plan, billing,
# ΗΔΥΚΑ connection) — always available regardless of subscription plan. Actual
# access is still enforced per-request by RBAC permissions (settings:read/write).
_CORE_MODULES = {"settings"}


def resolve_modules(included: set[str], overrides: dict[str, str]) -> dict[str, str]:
    """Merge plan modules + core modules, then apply tenant overrides (override wins)."""
    keys = set(included) | _CORE_MODULES
    modules = {m: overrides.get(m, "enabled") for m in keys}
    modules.update(overrides)
    return modules


def allowed_tenants(user: dict) -> list[str]:
    """Φαρμακεία στα οποία επιτρέπεται να συνδεθεί ο χρήστης: το κύριο (`tenant_id`) + όσα έχει
    δηλώσει ΡΗΤΑ η πλατφόρμα στο `tenant_ids` (δίκτυο φαρμακείων — ίδιο ή διαφορετικό ΑΦΜ).

    ΑΣΦΑΛΕΙΑ: το `tenant_ids` το γράφει ΜΟΝΟ το adminpanel. Αν μπορούσε να το θέσει ο διαχειριστής
    του φαρμακείου, θα έδινε στον εαυτό του πρόσβαση σε ξένο φαρμακείο.
    """
    out = [str(user["tenant_id"])]
    for t in (user.get("tenant_ids") or []):
        if str(t) not in out:
            out.append(str(t))
    return out


_AFM_RE = re.compile(r"^\d{9}$")


async def _has_owner_role(user: dict) -> bool:
    """Έχει ο χρήστης ρόλο ΙΔΙΟΚΤΗΤΗ στο δικό του φαρμακείο; (roles.key == 'owner')"""
    ids = [_as_object_id(r) for r in (user.get("role_ids") or [])]
    if not ids:
        return False
    r = await shared_db()["roles"].find_one(
        {"_id": {"$in": ids}, "tenant_id": user["tenant_id"], "key": "owner"})
    return bool(r)


async def resolve_allowed_tenants(user: dict) -> list[str]:
    """Πλήρης λίστα φαρμακείων στα οποία επιτρέπεται να συνδεθεί ο χρήστης:

      1. Το κύριο του + όσα δήλωσε ΡΗΤΑ η πλατφόρμα (`tenant_ids`) → για δίκτυα με ΔΙΑΦΟΡΕΤΙΚΑ ΑΦΜ.
      2. ΑΥΤΟΜΑΤΑ: όλα τα φαρμακεία με το ΙΔΙΟ ΑΦΜ — αλλά ΜΟΝΟ αν ο χρήστης είναι ΙΔΙΟΚΤΗΤΗΣ.
         Ίδιο ΑΦΜ = ίδια νομική οντότητα, άρα ο ιδιοκτήτης δικαιούται να τα βλέπει όλα.

    ΑΣΦΑΛΕΙΑ (μη το χαλαρώσεις): το ταίριασμα γίνεται ΜΟΝΟ σε έγκυρο 9ψήφιο ΑΦΜ. Στην παραγωγή τα
    tenants μπορεί να έχουν ΚΕΝΟ ΑΦΜ — ένα `find({"company.afm": ""})` θα τα τσουβάλιαζε ΟΛΑ μαζί
    και θα έδινε σε κάθε ιδιοκτήτη πρόσβαση σε ξένα φαρμακεία.
    """
    out = allowed_tenants(user)
    if not await _has_owner_role(user):
        return out
    db = shared_db()
    home = await db["tenants"].find_one({"_id": user["tenant_id"]}, {"company.afm": 1})
    afm = str(((home or {}).get("company") or {}).get("afm") or "").strip()
    if not _AFM_RE.match(afm):
        return out                      # κενό/άκυρο ΑΦΜ → ΚΑΝΕΝΑ αυτόματο ταίριασμα
    async for t in db["tenants"].find({"company.afm": afm}, {"_id": 1}):
        tid = str(t["_id"])
        if tid not in out:
            out.append(tid)
    return out


async def resolve_tenant_modules(tenant_id: str) -> dict[str, str]:
    """Resolve a tenant's effective modules OUTSIDE a request (e.g. a Celery worker) — same merge
    the login flow does (plan modules_included + tenant overrides). Use for entitlement checks
    where there is no JWT/TenantContext available."""
    db = shared_db()
    tenant = await db["tenants"].find_one({"_id": tenant_id})
    sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
    return resolve_modules(set((sub or {}).get("modules_included", [])),
                           (tenant or {}).get("modules", {}))


def tenant_has(modules: dict[str, str], key: str) -> bool:
    """True when a module is enabled or in trial (not locked / absent)."""
    return modules.get(key, "locked") in ("enabled", "trial")


def _as_object_id(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001
        return value


class AuthService:
    async def login(self, email: str, password: str, mfa_code: str | None,
                    user_agent: str | None = None, ip: str | None = None) -> dict | None:
        db = shared_db()
        user = await db["users"].find_one({"email": email, "status": "active"})
        if not user or not verify_password(password, user["password_hash"]):
            return None
        # Enforce subscription/tenant access (kept fresh locally) —
        # a suspended/expired tenant cannot log in, no external call at login time.
        _state = await self._access_state(user["tenant_id"])
        if _state == "blocked":               # αναστολή/ακύρωση → σκληρό μπλόκο
            return {"access_blocked": True}
        if _state == "expired":               # ΛΗΓΜΕΝΗ → επιτρέπεται ΑΝΑΝΕΩΣΗ (renew token, όχι πρόσβαση)
            from app.core.security import create_renew_token
            _sub = await db["subscriptions"].find_one({"tenant_id": user["tenant_id"]}) or {}
            return {"access_blocked": True, "reason": "expired",
                    "current_plan": _sub.get("plan"), "current_plan_name": _sub.get("plan_name"),
                    "renew_token": create_renew_token(tenant_id=str(user["tenant_id"]))}
        # MFA: if enabled, require a valid TOTP code (previously the code was ignored).
        # Distinct signal so the client can prompt for the code after a correct password.
        if user.get("mfa_enabled") and not verify_totp(user.get("mfa_secret", ""), mfa_code or ""):
            return {"mfa_required": True}
        # Concurrent-session (seat) cap: a NEW device/browser opens a NEW session. If the tenant
        # already holds `seats` live sessions, block — even if it's the same username elsewhere.
        tid = str(user["tenant_id"])
        sub = await db["subscriptions"].find_one({"tenant_id": user["tenant_id"]})
        seats = sessions.tenant_seats(sub)
        if not await sessions.has_free_seat(tid, seats):
            return {"seat_limit": True, "seats": seats}
        sid = await sessions.open_session(tid, str(user["_id"]), ua=user_agent, ip=ip)
        await db["users"].update_one({"_id": user["_id"]},
                                     {"$set": {"last_login_at": _utcnow()}})
        modules, roles, perms, demo = await self._resolve(user)
        # (Η λίστα φαρμακείων του χρήστη δίνεται από το /auth/me — το TokenOut είναι αυστηρό.)
        return self._issue(user, roles, modules, perms, demo, sid=sid)

    async def accessible_pharmacies(self, user: dict) -> list[dict]:
        """Τα φαρμακεία στα οποία επιτρέπεται να συνδεθεί ΑΥΤΟΣ ο χρήστης (για τον επιλογέα).
        Φιλτράρονται όσα είναι σε αναστολή/ληγμένη συνδρομή."""
        db = shared_db()
        out = []
        for tid in await resolve_allowed_tenants(user):
            if not await self._tenant_access_ok(tid):
                continue
            t = await db["tenants"].find_one({"_id": tid}) or {}
            out.append({"tenant_id": tid,
                        "name": (t.get("company") or {}).get("name") or t.get("name") or tid,
                        "primary": tid == str(user["tenant_id"])})
        return out

    async def select_tenant(self, user_id: str, tenant_id: str, sid: str | None = None) -> dict | None:
        """Εναλλαγή ενεργού φαρμακείου για χρήστη ΔΙΚΤΥΟΥ (π.χ. ιδιοκτήτης 5 φαρμακείων).

        Η απομόνωση δεν σπάει: το νέο token κουβαλά ΕΝΑ `tid` — απλά άλλο. Επιτρέπεται μόνο σε
        φαρμακείο που έχει δηλωθεί ΡΗΤΑ πάνω στον χρήστη (από την πλατφόρμα, όχι από το φαρμακείο).
        """
        db = shared_db()
        user = await db["users"].find_one({"_id": _as_object_id(user_id), "status": "active"})
        if not user:
            return None
        tid = str(tenant_id)
        if tid not in await resolve_allowed_tenants(user):
            return None
        if not await self._tenant_access_ok(tid):
            return None
        # Θέση (seat) ανά ΦΑΡΜΑΚΕΙΟ: κλείνει η συνεδρία στο παλιό, ανοίγει στο νέο → τίμια μέτρηση.
        sub = await db["subscriptions"].find_one({"tenant_id": tid})
        if not await sessions.has_free_seat(tid, sessions.tenant_seats(sub)):
            return {"seat_limit": True, "seats": sessions.tenant_seats(sub)}
        await sessions.close_session(sid)
        new_sid = await sessions.open_session(tid, str(user["_id"]))
        modules, roles, perms, demo = await self._resolve(user, tid)
        res = self._issue(user, roles, modules, perms, demo, sid=new_sid, tid=tid)
        res["active_tenant"] = tid
        return res

    async def _tenant_access_ok(self, tenant_id) -> bool:
        return (await self._access_state(tenant_id)) == "ok"

    async def _access_state(self, tenant_id) -> str:
        """"ok" (πρόσβαση) · "expired" (ληγμένη → ΑΝΑΝΕΩΣΙΜΗ, soft στο login) · "blocked" (αναστολή/ακύρωση).
        Βασίζεται στο ΕΝΟΠΟΙΗΜΕΝΟ effective_status (πηγή αλήθειας η ΠΕΡΙΟΔΟΣ) — ΟΧΙ στο ξεχασμένο raw status·
        έτσι πελάτης με ΜΕΛΛΟΝΤΙΚΗ λήξη ΔΕΝ μπλοκάρεται ακόμη κι αν το status είχε μείνει "expired"."""
        from app.services import billing_service
        db = shared_db()
        tenant = await db["tenants"].find_one({"_id": tenant_id})
        if tenant and tenant.get("status") == "suspended":
            return "blocked"
        sub = await db["subscriptions"].find_one({"tenant_id": tenant_id})
        if not sub:
            return "ok"
        eff = billing_service.effective_status(sub)
        if eff in ("suspended", "cancelled"):
            return "blocked"
        if eff == "expired":
            return "expired"
        return "ok"                              # active · trial · past_due → πρόσβαση

    async def refresh(self, refresh_token: str) -> dict | None:
        try:
            claims = decode_token(refresh_token)
        except ValueError:
            return None
        if claims.get("scope") != "refresh":
            return None
        db = shared_db()
        user = await db["users"].find_one({"_id": _as_object_id(claims["sub"])})
        if not user or user.get("refresh_token_version") != claims.get("ver"):
            return None  # revoked
        # Keep the SAME session across a refresh (no new seat). If it lapsed (idle → TTL-reaped),
        # revive it only if a seat is free — otherwise this refresh is over the cap → force re-login.
        # ΔΙΚΤΥΟ: κράτα το ΕΠΙΛΕΓΜΕΝΟ φαρμακείο (claim `tid`) — αλλιώς κάθε refresh θα τον γύριζε
        # στο κύριο και θα «πεταγόταν» από αυτό που δουλεύει. Αν έπαψε να επιτρέπεται → κύριο.
        claim_tid = str(claims.get("tid") or "")
        tid = claim_tid if (claim_tid in await resolve_allowed_tenants(user)
                            and await self._tenant_access_ok(claim_tid)) else str(user["tenant_id"])
        # Επιβολή περιόδου & σε ΕΝΕΡΓΕΣ συνεδρίες: αν έληξε/ανασταλεί η πρόσβαση → force re-login (μπλόκο).
        if not await self._tenant_access_ok(tid):
            return None
        sid = claims.get("sid")
        if sid and not await sessions.is_live(sid):
            sub = await db["subscriptions"].find_one({"tenant_id": tid})   # seats του ΕΝΕΡΓΟΥ
            if not await sessions.has_free_seat(tid, sessions.tenant_seats(sub), exclude_sid=sid):
                return None
        # Adopt/revive/refresh the session. Legacy refresh tokens minted before the seat system
        # carry no sid → open_session(sid=None) gives them a fresh TRACKED session so they can no
        # longer refresh forever outside the cap (closes the pre-`sid` escape without a mass logout).
        sid = await sessions.open_session(tid, str(user["_id"]), sid=sid)
        modules, roles, perms, demo = await self._resolve(user, tid)
        return self._issue(user, roles, modules, perms, demo, sid=sid, tid=tid)

    async def issue_for_user(self, user: dict) -> dict:
        """Mint tokens for a user WITHOUT a password check or last_login update — used
        for admin impersonation. Opens an impersonation session (excluded from the seat cap)."""
        sid = await sessions.open_session(
            str(user["tenant_id"]), str(user["_id"]), impersonation=True)
        modules, roles, perms, demo = await self._resolve(user)
        return self._issue(user, roles, modules, perms, demo, sid=sid)

    async def _resolve(self, user: dict, tid: str | None = None) -> tuple[dict, list[str], list[str], bool]:
        """tid = ΕΝΕΡΓΟ φαρμακείο (default: το κύριο του χρήστη).

        ΠΡΟΣΟΧΗ στα δύο διαφορετικά scopes:
          • modules/συνδρομή → του ΦΑΡΜΑΚΕΙΟΥ-ΣΤΟΧΟΥ (μπορεί να μην έχει π.χ. loyalty)
          • ρόλοι/δικαιώματα → του ΚΥΡΙΟΥ φαρμακείου του χρήστη (εκεί ζουν τα role docs του)
        """
        db = shared_db()
        tid = tid or str(user["tenant_id"])
        tenant = await db["tenants"].find_one({"_id": tid})
        sub = await db["subscriptions"].find_one({"tenant_id": tid})

        # modules: plan + core modules, with tenant overrides applied
        modules = resolve_modules(
            set((sub or {}).get("modules_included", [])),
            (tenant or {}).get("modules", {}),
        )
        # expire self-service module trials: a "trial" override whose end date has passed → locked
        trials = (tenant or {}).get("module_trials") or {}
        if trials:
            now = _utcnow()
            for m, exp in trials.items():
                if modules.get(m) == "trial" and exp and exp < now:
                    modules[m] = "locked"

        # permissions: union of the user's roles. role_ids may be stored as strings
        # (created via the API) — coerce to ObjectId so the $in actually matches.
        role_ids = [_as_object_id(r) for r in (user.get("role_ids") or [])]
        roles: list[str] = []
        perms: set[str] = set()
        # SECURITY: scope role lookup to the user's OWN tenant — otherwise a role_id from
        # another tenant (smuggled in via the users API) unions foreign permissions into
        # this token = cross-tenant privilege escalation.
        async for role in db["roles"].find(
            {"_id": {"$in": role_ids}, "tenant_id": user["tenant_id"]}):
            roles.append(role.get("key", str(role["_id"])))
            perms.update(role.get("permissions", []))
        # PII masking applies when EITHER the tenant is a «πελάτης παρουσίασης» (demo) OR this
        # specific user is GDPR-restricted (mask_pii) — e.g. a health advisor at the counter who
        # may operate but must not see patients' surname/ΑΜΚΑ/contact details.
        demo = bool((tenant or {}).get("demo")) or bool(user.get("mask_pii"))
        return modules, roles, sorted(perms), demo

    def _issue(self, user: dict, roles: list[str], modules: dict, perms: list[str],
               demo: bool = False, sid: str | None = None, tid: str | None = None) -> dict:
        uid = str(user["_id"])
        tid = tid or str(user["tenant_id"])   # ΕΝΕΡΓΟ φαρμακείο → μπαίνει στο claim `tid`
        return {
            "access_token": create_access_token(
                user_id=uid, tenant_id=tid, roles=roles, modules=modules, permissions=perms,
                demo=demo, sid=sid),
            "refresh_token": create_refresh_token(
                user_id=uid, tenant_id=tid, version=user.get("refresh_token_version", 0), sid=sid),
            "expires_in": 900,
        }
