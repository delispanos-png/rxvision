from fastapi import APIRouter

from app.api.v1.routers import (
    admin,
    advisor,
    auth,
    communications,
    dashboard,
    doctors,
    billing,
    fund_groups,
    future,
    pharmacy_availability,
    gdpr,
    infra_cloud,
    icd10,
    ingestion,
    loyalty,
    monthly_closing,
    onboarding,
    orders,
    copilot,
    patient,
    patient_intelligence,
    patients,
    portal_admin,
    pharmacat,
    pharmacyone,
    platform,
    prescriptions,
    profitability,
    reimbursement,
    subscriptions,
    vaccinations,
    tenants,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(onboarding.router, prefix="/onboarding", tags=["onboarding"])
api_router.include_router(billing.router, prefix="/billing", tags=["billing"])
api_router.include_router(patient.router, prefix="/patient", tags=["patient-portal"])
api_router.include_router(portal_admin.router, prefix="/portal", tags=["patient-portal-admin"])
api_router.include_router(patient_intelligence.router, prefix="/patient-intelligence", tags=["patient-intelligence"])
api_router.include_router(pharmacat.router, prefix="/pharmacat", tags=["pharmacat"])
api_router.include_router(copilot.router, prefix="/copilot", tags=["copilot"])
api_router.include_router(reimbursement.router, prefix="/reimbursement", tags=["reimbursement"])
api_router.include_router(pharmacy_availability.router, prefix="/pharmacy-availability", tags=["pharmacy-availability"])
api_router.include_router(loyalty.router, prefix="/loyalty", tags=["loyalty"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(advisor.router, prefix="/advisor", tags=["advisor"])
api_router.include_router(communications.router, prefix="/communications", tags=["communications"])
api_router.include_router(gdpr.router, prefix="/gdpr", tags=["gdpr"])
api_router.include_router(prescriptions.router, prefix="/prescriptions", tags=["prescriptions"])
api_router.include_router(vaccinations.router, prefix="/vaccinations", tags=["vaccinations"])

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
api_router.include_router(infra_cloud.router, prefix="/platform/cloud", tags=["platform"])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"])

# Admin: subscriptions, tenant, users/roles/permissions
api_router.include_router(subscriptions.router, prefix="/subscription", tags=["subscription"])
api_router.include_router(tenants.router, prefix="/tenant", tags=["tenant"])
# users router declares its own /users, /roles, /permissions paths → mount at root.
api_router.include_router(users.router, tags=["users"])
