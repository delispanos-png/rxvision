from fastapi import APIRouter

from app.api.v1.routers import (
    admin,
    auth,
    dashboard,
    doctors,
    fund_groups,
    future,
    icd10,
    ingestion,
    monthly_closing,
    onboarding,
    orders,
    patients,
    pharmacyone,
    platform,
    prescriptions,
    profitability,
    subscriptions,
    tenants,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(onboarding.router, prefix="/onboarding", tags=["onboarding"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(prescriptions.router, prefix="/prescriptions", tags=["prescriptions"])

# Analytics modules
api_router.include_router(doctors.router, prefix="/doctors", tags=["doctors"])
api_router.include_router(patients.router, prefix="/patients", tags=["patients"])
api_router.include_router(icd10.router, prefix="/icd10", tags=["icd10"])
api_router.include_router(profitability.router, prefix="/profitability", tags=["profitability"])

# Future prescriptions & orders
api_router.include_router(future.router, prefix="/future", tags=["future"])
api_router.include_router(orders.router, prefix="/orders", tags=["orders"])

# Monthly closing
api_router.include_router(monthly_closing.router, prefix="/closing", tags=["closing"])

# Ingestion
api_router.include_router(ingestion.router, prefix="/ingestion", tags=["ingestion"])

# PharmacyOne add-on
api_router.include_router(pharmacyone.router, prefix="/pharmacyone", tags=["pharmacyone"])

# Back-office (platform/CloudOn) — separate auth + cross-tenant admin
api_router.include_router(platform.router, prefix="/platform", tags=["platform"])
api_router.include_router(fund_groups.router, prefix="/platform/fund-groups", tags=["platform"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])

# Admin: subscriptions, tenant, users/roles/permissions
api_router.include_router(subscriptions.router, prefix="/subscription", tags=["subscription"])
api_router.include_router(tenants.router, prefix="/tenant", tags=["tenant"])
# users router declares its own /users, /roles, /permissions paths → mount at root.
api_router.include_router(users.router, tags=["users"])
