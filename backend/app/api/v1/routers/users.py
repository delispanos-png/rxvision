"""Users & roles administration router + permission catalog."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import TenantContext, require
from app.core.security import hash_password
from app.repositories.base import jsonsafe
from app.repositories.users import RoleRepository, UserRepository
from app.schemas.users import RoleCreate, ResetPasswordIn, RoleUpdate, UserCreate, UserUpdate
from app.services import mailer
from app.services.rbac_seed import ALL_PERMISSION_KEYS, PERMISSIONS

router = APIRouter()

_PERM = "users:manage"
_LOGIN_URL = "https://app.rxvision.gr/login"


async def _role_names(tenant_id: str) -> dict[str, str]:
    roles = await RoleRepository(tenant_id=tenant_id).list_roles(skip=0, limit=200)
    return {r["_id"]: r["name"] for r in roles}


async def _validate_role_ids(tenant_id: str, role_ids: list[str] | None) -> None:
    """Reject any role_id that doesn't belong to THIS tenant — blocks attaching another
    tenant's role to a user (cross-tenant privilege escalation at login)."""
    if not role_ids:
        return
    roles = await RoleRepository(tenant_id=tenant_id).list_roles(skip=0, limit=500)
    valid = {str(r["_id"]) for r in roles}
    bad = [str(r) for r in role_ids if str(r) not in valid]
    if bad:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"error": "invalid_role_ids", "ids": bad})


def _shape_user(u: dict, role_names: dict[str, str]) -> dict:
    """Frontend-friendly shape: id / role names / active flag (hides internals)."""
    u = jsonsafe(u)
    return {
        "id": u.get("_id") or u.get("id"),
        "email": u.get("email"),
        "full_name": u.get("full_name", ""),
        "role_ids": u.get("role_ids", []),
        "roles": [role_names.get(rid, rid) for rid in u.get("role_ids", [])],
        "active": u.get("status", "active") == "active",
        "mask_pii": bool(u.get("mask_pii", False)),
    }


def _welcome_email(full_name: str, email: str, password: str) -> str:
    return (
        f"<div style='font-family:system-ui,Arial,sans-serif;color:#0f172a'>"
        f"<h2 style='color:#4f46e5'>Καλώς ήρθατε στο RxVision</h2>"
        f"<p>Γεια σας {full_name},</p>"
        f"<p>Δημιουργήθηκε λογαριασμός για εσάς. Τα στοιχεία πρόσβασης:</p>"
        f"<p><b>Email:</b> {email}<br><b>Προσωρινός κωδικός:</b> "
        f"<code style='background:#f1f5f9;padding:2px 6px;border-radius:4px'>{password}</code></p>"
        f"<p><a href='{_LOGIN_URL}' style='display:inline-block;background:#4f46e5;color:#fff;"
        f"padding:10px 18px;border-radius:8px;text-decoration:none'>Σύνδεση</a></p>"
        f"<p style='color:#64748b;font-size:13px'>Για την ασφάλειά σας, αλλάξτε τον κωδικό μετά "
        f"την πρώτη σύνδεση.</p></div>"
    )


# ── Users ──────────────────────────────────────────────────
@router.get("/users")
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = UserRepository(tenant_id=ctx.tenant_id)
    items = await repo.list_users(skip=(page - 1) * page_size, limit=page_size)
    names = await _role_names(ctx.tenant_id)
    return {"page": page, "page_size": page_size,
            "items": [_shape_user(u, names) for u in items]}


@router.get("/users/{user_id}")
async def get_user(user_id: str, ctx: TenantContext = Depends(require(_PERM))):
    user = await UserRepository(tenant_id=ctx.tenant_id).get(user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    return _shape_user(user, await _role_names(ctx.tenant_id))


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, ctx: TenantContext = Depends(require(_PERM))):
    repo = UserRepository(tenant_id=ctx.tenant_id)
    await _validate_role_ids(ctx.tenant_id, body.role_ids)
    # one account per email within a tenant
    if await repo._coll.find_one(repo._scope({"email": str(body.email)})):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "email_exists"})

    temp_password = body.password or ("Rx-" + secrets.token_urlsafe(9))
    doc = body.model_dump(exclude={"password"})
    doc["email"] = str(body.email)
    doc["password_hash"] = hash_password(temp_password)
    user = await repo.create(doc)

    shaped = _shape_user(user, await _role_names(ctx.tenant_id))
    # email the credentials when we generated them (best-effort; SMTP may be unset)
    emailed = False
    if not body.password:
        try:
            await mailer.send_email(
                str(body.email), "RxVision — τα στοιχεία πρόσβασής σας",
                _welcome_email(body.full_name, str(body.email), temp_password))
            emailed = True
        except Exception:  # noqa: BLE001
            emailed = False
    shaped["credentials_emailed"] = emailed
    if not emailed and not body.password:
        # SMTP not available → hand the password back once so the owner can deliver it
        shaped["temporary_password"] = temp_password
    return shaped


@router.patch("/users/{user_id}")
async def update_user(
    user_id: str,
    body: UserUpdate,
    ctx: TenantContext = Depends(require(_PERM)),
):
    if body.status == "suspended" and user_id == ctx.user_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "cannot_suspend_self"})
    await _validate_role_ids(ctx.tenant_id, getattr(body, "role_ids", None))
    repo = UserRepository(tenant_id=ctx.tenant_id)
    user = await repo.update(user_id, body.model_dump(exclude_none=True))
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    return _shape_user(user, await _role_names(ctx.tenant_id))


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: str,
    body: ResetPasswordIn,
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = UserRepository(tenant_id=ctx.tenant_id)
    user = await repo.get(user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    temp_password = body.password or ("Rx-" + secrets.token_urlsafe(9))
    await repo.set_password(user_id, hash_password(temp_password))

    emailed = False
    if not body.password:  # auto-generated → email it to the user
        try:
            await mailer.send_email(
                user["email"], "RxVision — επαναφορά κωδικού",
                _welcome_email(user.get("full_name", ""), user["email"], temp_password))
            emailed = True
        except Exception:  # noqa: BLE001
            emailed = False
    out = {"id": user_id, "credentials_emailed": emailed}
    if not emailed and not body.password:
        out["temporary_password"] = temp_password
    return out


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, ctx: TenantContext = Depends(require(_PERM))):
    if user_id == ctx.user_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"error": "cannot_delete_self"})
    await UserRepository(tenant_id=ctx.tenant_id).delete(user_id)


# ── Roles ──────────────────────────────────────────────────
@router.get("/roles")
async def list_roles(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = RoleRepository(tenant_id=ctx.tenant_id)
    items = await repo.list_roles(skip=(page - 1) * page_size, limit=page_size)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/roles/{role_id}")
async def get_role(role_id: str, ctx: TenantContext = Depends(require(_PERM))):
    role = await RoleRepository(tenant_id=ctx.tenant_id).get(role_id)
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role_not_found")
    return role


def _clean_perms(perms: list[str]) -> list[str]:
    """Δέξου ΜΟΝΟ δικαιώματα που υπάρχουν στον κατάλογο.

    Χωρίς αυτό, ένα ορθογραφικό λάθος («paitents:read») αποθηκευόταν κανονικά και ο ρόλος
    απλώς δεν έκανε τίποτα — σιωπηλά, χωρίς να το μάθει κανείς.
    """
    known = set(ALL_PERMISSION_KEYS)
    bad = sorted({p for p in perms if p not in known and p != "*"})
    if bad:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            detail={"error": "unknown_permission", "keys": bad})
    return sorted(set(perms))


async def _guard_last_admin(repo: RoleRepository, *, role_id=None, new_perms=None) -> None:
    """Πρέπει ΠΑΝΤΑ να μένει τουλάχιστον ένας ρόλος που μπορεί να διαχειριστεί χρήστες.

    Αλλιώς ο πελάτης κλειδώνεται έξω από τη διαχείριση του ίδιου του λογαριασμού του και
    χρειάζεται εμάς για να ξεκλειδώσει — κάτι που δεν πρέπει να μπορεί να συμβεί με ένα κλικ.
    """
    keeps = 0
    for r in await repo.list_roles():
        perms = list(r.get("permissions") or [])
        if role_id is not None and str(r["_id"]) == str(role_id):
            if new_perms is None:          # διαγραφή → δεν μετράει
                continue
            perms = new_perms
        if "*" in perms or "users:manage" in perms:
            keeps += 1
    if keeps == 0:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "last_admin_role"})


@router.post("/roles", status_code=201)
async def create_role(body: RoleCreate, ctx: TenantContext = Depends(require(_PERM))):
    repo = RoleRepository(tenant_id=ctx.tenant_id)
    if await repo.by_key(body.key):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "key_exists"})
    doc = body.model_dump()
    doc["permissions"] = _clean_perms(doc.get("permissions") or [])
    return await repo.create(doc)


@router.patch("/roles/{role_id}")
async def update_role(
    role_id: str,
    body: RoleUpdate,
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = RoleRepository(tenant_id=ctx.tenant_id)
    existing = await repo.get(role_id)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role_not_found")
    if existing.get("is_system"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "cannot_modify_system_role"})
    fields = body.model_dump(exclude_none=True)
    if "permissions" in fields:
        fields["permissions"] = _clean_perms(fields["permissions"])
        await _guard_last_admin(repo, role_id=role_id, new_perms=fields["permissions"])
    return await repo.update(role_id, fields)


@router.delete("/roles/{role_id}", status_code=204)
async def delete_role(role_id: str, ctx: TenantContext = Depends(require(_PERM))):
    repo = RoleRepository(tenant_id=ctx.tenant_id)
    existing = await repo.get(role_id)
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"error": "role_not_found"})
    if existing.get("is_system"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"error": "cannot_delete_system_role"})
    n = await repo.users_with(role_id)
    if n:
        # Διαγραφή ρόλου που χρησιμοποιείται θα άφηνε χρήστες χωρίς δικαιώματα, σιωπηλά.
        raise HTTPException(status.HTTP_409_CONFLICT,
                            detail={"error": "role_in_use", "users": n})
    await _guard_last_admin(repo, role_id=role_id, new_perms=None)
    await repo.delete(role_id)


# ── Permission catalog ─────────────────────────────────────
# Ελληνικά ονόματα ανά περιοχή — ο κατάλογος έχει κλειδιά τύπου «prescriptions:read»,
# που δεν λένε τίποτα σε φαρμακοποιό.
_RESOURCE_EL: dict[str, str] = {
    "dashboard": "Πίνακας", "prescriptions": "Συνταγές", "doctors": "Ιατροί",
    "patients": "Ασφαλισμένοι", "icd10": "ICD-10", "profitability": "Κερδοφορία",
    "future": "Μελλοντικές συνταγές", "orders": "Παραγγελίες",
    "closing": "Κλείσιμο μήνα", "ingestion": "Δεδομένα ΗΔΥΚΑ",
    "pharmacyone": "PharmacyOne", "settings": "Ρυθμίσεις", "users": "Χρήστες & ρόλοι",
    "billing": "Συνδρομή & χρεώσεις", "portal": "Πύλη πελατών", "gdpr": "GDPR",
}
_ACTION_EL: dict[str, str] = {
    "read": "Προβολή", "write": "Αλλαγή", "export": "Εξαγωγή", "run": "Εκτέλεση",
    "manage": "Διαχείριση", "rectify": "Διόρθωση", "erase": "Διαγραφή",
}


@router.get("/permissions")
async def list_permissions(ctx: TenantContext = Depends(require(_PERM))):
    """Ο κατάλογος δικαιωμάτων, ΟΜΑΔΟΠΟΙΗΜΕΝΟΣ ανά περιοχή και σε ελληνικά."""
    groups: dict[str, dict] = {}
    for p in PERMISSIONS:
        g = groups.setdefault(p["resource"], {
            "resource": p["resource"],
            "label": _RESOURCE_EL.get(p["resource"], p["resource"]),
            "items": [],
        })
        g["items"].append({**p,
                           "action_label": _ACTION_EL.get(p["action"], p["action"]),
                           "label": p["description"]})
    ordered = [groups[r] for r in _RESOURCE_EL if r in groups]
    ordered += [g for r, g in groups.items() if r not in _RESOURCE_EL]
    return {"items": PERMISSIONS, "groups": ordered}
