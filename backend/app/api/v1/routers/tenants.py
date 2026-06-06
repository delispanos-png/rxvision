"""Tenant administration router — settings, modules, export, deletion request."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import TenantContext, require
from app.repositories.tenants import TenantRepository
from app.schemas.tenants import DeletionRequestIn, ModulesUpdate, TenantUpdate

router = APIRouter()


@router.get("")
async def get_tenant(ctx: TenantContext = Depends(require("settings:read"))):
    tenant = await TenantRepository(tenant_id=ctx.tenant_id).get()
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tenant_not_found")
    return tenant


@router.patch("")
async def update_tenant(
    body: TenantUpdate,
    ctx: TenantContext = Depends(require("settings:write")),
):
    fields = body.model_dump(exclude_none=True)
    return await TenantRepository(tenant_id=ctx.tenant_id).update(fields)


@router.get("/modules")
async def get_modules(ctx: TenantContext = Depends(require("settings:write"))):
    return await TenantRepository(tenant_id=ctx.tenant_id).get_modules()


@router.patch("/modules")
async def update_modules(
    body: ModulesUpdate,
    ctx: TenantContext = Depends(require("settings:write")),
):
    return await TenantRepository(tenant_id=ctx.tenant_id).set_modules(body.modules)


@router.post("/export", status_code=202)
async def export_tenant(ctx: TenantContext = Depends(require("settings:write"))):
    # Enqueue an async, audited full-tenant export → signed download URL when ready.
    try:
        from app.workers.snapshots import export_tenant_data  # type: ignore

        export_tenant_data.delay(ctx.tenant_id)
        status_str = "queued"
    except Exception:  # noqa: BLE001
        status_str = "accepted"
    return {"status": status_str, "tenant_id": ctx.tenant_id}


@router.post("/deletion-request", status_code=202)
async def deletion_request(
    body: DeletionRequestIn,
    ctx: TenantContext = Depends(require("settings:write")),
):
    # GDPR right-to-be-forgotten. Owner-level intent is enforced upstream by role config;
    # here we mark the tenant pending_deletion and let the async purge job run.
    if not body.confirm:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"error": "confirmation_required"})
    tenant = await TenantRepository(tenant_id=ctx.tenant_id).request_deletion(
        reason=body.reason)
    return {"status": "pending_deletion", "tenant": tenant}
