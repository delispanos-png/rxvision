"""Users & roles administration router + permission catalog."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, require
from app.core.security import hash_password
from app.repositories.users import RoleRepository, UserRepository
from app.schemas.users import RoleCreate, RoleUpdate, UserCreate, UserUpdate
from app.services.rbac_seed import PERMISSIONS

router = APIRouter()

_PERM = "users:manage"


# ── Users ──────────────────────────────────────────────────
@router.get("/users")
async def list_users(
    page: int = 1,
    page_size: int = 50,
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = UserRepository(tenant_id=ctx.tenant_id)
    items = await repo.list_users(skip=(page - 1) * page_size, limit=page_size)
    return {"page": page, "page_size": page_size, "items": items}


@router.get("/users/{user_id}")
async def get_user(user_id: str, ctx: TenantContext = Depends(require(_PERM))):
    user = await UserRepository(tenant_id=ctx.tenant_id).get(user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    return user


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, ctx: TenantContext = Depends(require(_PERM))):
    doc = body.model_dump(exclude={"password"})
    doc["password_hash"] = hash_password(body.password)
    return await UserRepository(tenant_id=ctx.tenant_id).create(doc)


@router.patch("/users/{user_id}")
async def update_user(
    user_id: str,
    body: UserUpdate,
    ctx: TenantContext = Depends(require(_PERM)),
):
    repo = UserRepository(tenant_id=ctx.tenant_id)
    user = await repo.update(user_id, body.model_dump(exclude_none=True))
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")
    return user


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, ctx: TenantContext = Depends(require(_PERM))):
    await UserRepository(tenant_id=ctx.tenant_id).delete(user_id)


# ── Roles ──────────────────────────────────────────────────
@router.get("/roles")
async def list_roles(
    page: int = 1,
    page_size: int = 50,
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


@router.post("/roles", status_code=201)
async def create_role(body: RoleCreate, ctx: TenantContext = Depends(require(_PERM))):
    return await RoleRepository(tenant_id=ctx.tenant_id).create(body.model_dump())


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
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot_modify_system_role")
    return await repo.update(role_id, body.model_dump(exclude_none=True))


@router.delete("/roles/{role_id}", status_code=204)
async def delete_role(role_id: str, ctx: TenantContext = Depends(require(_PERM))):
    repo = RoleRepository(tenant_id=ctx.tenant_id)
    existing = await repo.get(role_id)
    if existing and existing.get("is_system"):
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot_delete_system_role")
    await repo.delete(role_id)


# ── Permission catalog ─────────────────────────────────────
@router.get("/permissions")
async def list_permissions(ctx: TenantContext = Depends(require(_PERM))):
    return {"items": PERMISSIONS}
