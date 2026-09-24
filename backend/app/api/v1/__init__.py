from fastapi import APIRouter, Depends

from app.core.deps import require_padmin
from app.api.v1.routers import (
    addons,
    admin,
    admin_leads,
    nav,
    advisor,
    announcements,
    auth,
    calendar,
    communications,
    connect,
    dashboard,
    doctors,
    billing,
    feedback,
    fund_groups,
    future,
    pharmacy_availability,
    gdpr,
    softone_bridge,
    infra_cloud,
    icd10,
    ingestion,
    loyalty,
    marketing,
    monthly_closing,
    onboarding,
    orders,
    orders_delivery,
    copilot,
    advance_dispensings,
    daily_coach,
    patient,
    patient_intelligence,
    patients,
    portal_admin,
    pharmacat,
    pharmacy_catalog,
    pharmacy_chat,
    pharmacyone,
    platform,
    prescriptions,
    release_notes,
    profitability,
    reimbursement,
    security,
    subscriptions,
    vaccinations,
    vaccine_programs,
    tenants,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(calendar.router, prefix="/calendar", tags=["calendar"])
api_router.include_router(onboarding.router, prefix="/onboarding", tags=["onboarding"])
api_router.include_router(feedback.router, prefix="/feedback", tags=["feedback"])
api_router.include_router(billing.router, prefix="/billing", tags=["billing"])
api_router.include_router(patient.router, prefix="/patient", tags=["patient-portal"])
api_router.include_router(portal_admin.router, prefix="/portal", tags=["patient-portal-admin"])
api_router.include_router(patient_intelligence.router, prefix="/patient-intelligence", tags=["patient-intelligence"])
api_router.include_router(pharmacat.router, prefix="/pharmacat", tags=["pharmacat"])
api_router.include_router(copilot.router, prefix="/copilot", tags=["copilot"])
api_router.include_router(reimbursement.router, prefix="/reimbursement", tags=["reimbursement"])
api_router.include_router(pharmacy_availability.router, prefix="/pharmacy-availability", tags=["pharmacy-availability"])
api_router.include_router(loyalty.router, prefix="/loyalty", tags=["loyalty"])
api_router.include_router(pharmacy_catalog.router, prefix="/catalog", tags=["catalog"])
api_router.include_router(pharmacy_chat.router, prefix="/pharmacy-chat", tags=["pharmacy-chat"])
api_router.include_router(connect.router, prefix="/connect", tags=["connect"])
api_router.include_router(release_notes.router, prefix="/release-notes", tags=["release-notes"])
api_router.include_router(orders_delivery.router, prefix="/orders/delivery", tags=["orders-delivery"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(advisor.router, prefix="/advisor", tags=["advisor"])
api_router.include_router(daily_coach.router, prefix="/coach", tags=["coach"])
api_router.include_router(advance_dispensings.router,
                          prefix="/advance-dispensings",
                          tags=["advance-dispensings"])
api_router.include_router(announcements.router, prefix="/announcements", tags=["announcements"])
api_router.include_router(communications.router, prefix="/communications", tags=["communications"])
api_router.include_router(marketing.router, prefix="/marketing", tags=["marketing"])
api_router.include_router(gdpr.router, prefix="/gdpr", tags=["gdpr"])
api_router.include_router(softone_bridge.router, prefix="/softone", tags=["softone-bridge"])
api_router.include_router(prescriptions.router, prefix="/prescriptions", tags=["prescriptions"])
api_router.include_router(vaccinations.router, prefix="/vaccinations", tags=["vaccinations"])
api_router.include_router(vaccine_programs.router, prefix="/vaccine-programs", tags=["vaccine-programs"])

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
# Back-office authorization: ΕΝΑ σημείο για όλους τους routers του back-office.
# Το `require_padmin(scope)` ελέγχει ταυτότητα ΚΑΙ δικαίωμα ανά διαδρομή, με deny
# by default. Το `scope` πρέπει να ταιριάζει με τα κλειδιά του ROUTE_PERMISSIONS.
api_router.include_router(fund_groups.router, prefix="/platform/fund-groups", tags=["platform"],
                          dependencies=[Depends(require_padmin("fund_groups"))])
api_router.include_router(infra_cloud.router, prefix="/platform/cloud", tags=["platform"],
                          dependencies=[Depends(require_padmin("cloud"))])
api_router.include_router(admin.router, prefix="/admin", tags=["admin"],
                          dependencies=[Depends(require_padmin("admin"))])
# «Τι νέο υπάρχει» — διαχείριση από το back-office, ίδιος φρουρός με τον admin router.
api_router.include_router(release_notes.admin_router, prefix="/admin", tags=["admin"],
                          dependencies=[Depends(require_padmin("admin"))])
# Lead Engine — δικός του router (ο admin.py είναι ήδη 3.700+ γραμμές). Ο prefix είναι
# δηλωμένος ΜΕΣΑ στο module, γι' αυτό οι διαδρομές του στον χάρτη δικαιωμάτων γράφονται
# ολόκληρες (`/admin/leads/...`), σε αντίθεση με τους άλλους routers.
api_router.include_router(admin_leads.router, tags=["admin-leads"],
                          dependencies=[Depends(require_padmin("admin_leads"))])

# Admin: subscriptions, tenant, users/roles/permissions
api_router.include_router(subscriptions.router, prefix="/subscription", tags=["subscription"])
api_router.include_router(addons.router, prefix="/addons", tags=["addons"])
api_router.include_router(tenants.router, prefix="/tenant", tags=["tenant"])
# users router declares its own /users, /roles, /permissions paths → mount at root.
api_router.include_router(users.router, tags=["users"])
api_router.include_router(security.router, prefix="/security", tags=["security"])
# Προσωπικό μενού & μενού ανά ρόλο (ΕΜΦΑΝΙΣΗ — τα δικαιώματα μένουν στον server).
api_router.include_router(nav.router, prefix="/nav", tags=["nav"])
