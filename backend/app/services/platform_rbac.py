"""Platform (back-office) RBAC — permission catalog, route map, groups.

Το tenant-side RBAC ζει στο `rbac_seed.py` και αφορά χρήστες φαρμακείων. ΑΥΤΟ εδώ είναι
το αντίστοιχο για το προσωπικό CloudOn (`platform_admins`) και είναι σκόπιμα ξεχωριστό:
άλλη ταυτότητα, άλλο token, άλλος κατάλογος ενεργειών.

Τρεις αρχές:

1. **Τα δικαιώματα ζουν ΜΟΝΟ σε ομάδες** (`platform_groups`). Ο χρήστης παίρνει ομάδες·
   ποτέ μεμονωμένα δικαιώματα. Έτσι «τι μπορεί να κάνει ο ρόλος Υποστήριξη» απαντιέται
   σε ένα σημείο, όχι ανά άτομο.
2. **Ένα δικαίωμα ανά ΕΝΕΡΓΕΙΑ**, όχι ανά ενότητα. Το `tenants:read` δεν συνεπάγεται
   `tenants:delete`, και το `tenants:impersonate` δεν δίνεται ποτέ μαζί με τα υπόλοιπα.
3. **Deny by default.** Το `ROUTE_PERMISSIONS` χαρτογραφεί ΚΑΘΕ endpoint. Ό,τι δεν
   χαρτογραφείται απαγορεύεται — και το `tests/test_platform_rbac.py` σκάει αν προστεθεί
   endpoint χωρίς δήλωση, ώστε το κενό να πιάνεται στο CI και όχι στην παραγωγή.

Γιατί χάρτης αντί για `Depends(...)` σε κάθε handler: οι διαδρομές είναι 196 σε 4
routers. Ένας κεντρικός χάρτης διαβάζεται και ελέγχεται ολόκληρος· 196 διάσπαρτα
decorators όχι. Το gate είναι router-level dependency που διαβάζει το route template
από το `request.scope["route"].path`.

⚠️ Το template είναι **σχετικό ως προς τον router** που το δήλωσε (π.χ.
`/tenants/{tenant_id}` για τον `admin`, αλλά `/admin/leads/overview` για τον
`admin_leads` που κουβαλά δικό του prefix). Γι' αυτό ο χάρτης είναι ανά router.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from app.core.db import shared_db


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


# Sentinel: διαδρομή που επιτρέπεται σε ΚΑΘΕ συνδεδεμένο platform admin, ανεξαρτήτως
# ομάδων. Μόνο για metadata που χρειάζεται το ίδιο το UI για να ζωγραφιστεί.
ANY_ADMIN = "*any*"

# Wildcard που κουβαλά ο super_admin.
WILDCARD = "*"


# ── Ενότητες (μόνο για ομαδοποίηση στο UI) ─────────────────────────────────
SECTIONS: list[tuple[str, str]] = [
    ("dashboard", "Πίνακας"),
    ("customers", "Πελάτες & Συνδρομές"),
    ("billing", "Χρεώσεις & Πληρωμές"),
    ("government", "Κρατικές διασυνδέσεις"),
    ("ai_clinical", "AI & Κλινικά"),
    ("operations", "Λειτουργία & Παρακολούθηση"),
    ("system", "Σύστημα"),
]


# ── Κατάλογος δικαιωμάτων ──────────────────────────────────────────────────
# (key, section, ελληνική ετικέτα, sensitive)
# sensitive=True ⇒ δεν μπαίνει ΠΟΤΕ σε default ομάδα, σημαίνεται κόκκινο στο UI και
# κάθε χρήση του γράφεται ρητά στο audit log.
_DEFS: list[tuple[str, str, str, bool]] = [
    # ── Πίνακας ──
    ("dashboard:read", "dashboard", "Προβολή πίνακα & KPIs", False),

    # ── Πελάτες & Συνδρομές ──
    ("tenants:read", "customers", "Προβολή πελατών & καρτέλας", False),
    ("tenants:create", "customers", "Άνοιγμα νέου πελάτη", False),
    ("tenants:edit", "customers", "Επεξεργασία στοιχείων πελάτη", False),
    ("tenants:suspend", "customers", "Αναστολή / επανενεργοποίηση", False),
    ("tenants:modules", "customers", "Αλλαγή δυνατοτήτων (modules)", False),
    ("tenants:package", "customers", "Ανάθεση πακέτου", False),
    ("tenants:addons", "customers", "Ενεργοποίηση add-on", False),
    ("tenants:cancel", "customers", "Ακύρωση συνδρομής πελάτη", False),
    ("tenants:wallet_credit", "customers", "Πίστωση υπολοίπου μηνυμάτων", False),
    ("tenants:items_copy", "customers", "Αντιγραφή ειδών σε πελάτη", False),
    ("tenants:items_delete", "customers", "Διαγραφή ειδών πελάτη", True),
    ("tenants:delete", "customers", "Οριστική διαγραφή πελάτη", True),
    ("tenants:credentials", "customers", "Προβολή credentials πελάτη", True),
    ("tenants:send_credentials", "customers", "Έκδοση & αποστολή νέου κωδικού πελάτη", True),
    ("tenants:impersonate", "customers", "Σύνδεση ως πελάτης (δεδομένα ασθενών)", True),
    ("feedback:read", "customers", "Προβολή αξιολογήσεων", False),
    ("feedback:coupon", "customers", "Έκδοση κουπονιού αξιολόγησης", False),

    ("subscriptions:read", "customers", "Προβολή συνδρομών", False),
    ("subscriptions:edit", "customers", "Επεξεργασία συνδρομής", False),
    ("subscriptions:plan_change", "customers", "Έγκριση / απόρριψη αλλαγής πακέτου", False),
    ("subscriptions:lifecycle", "customers", "Ρυθμίσεις κύκλου ζωής", False),
    ("subscriptions:lifecycle_run", "customers", "Εκτέλεση κύκλου ζωής", False),
    ("subscriptions:notifications", "customers", "Ειδοποιήσεις συνδρομών", False),
    ("subscriptions:trials_purge", "customers", "Εκκαθάριση δοκιμαστικών", True),
    ("packages:read", "customers", "Προβολή πακέτων / add-ons / SLA", False),
    ("packages:write", "customers", "Δημιουργία & επεξεργασία πακέτων", False),
    ("packages:delete", "customers", "Διαγραφή πακέτων", False),
    ("eshop_fees:read", "customers", "Προβολή προμηθειών e-shop", False),
    ("eshop_fees:write", "customers", "Ρύθμιση προμηθειών e-shop", False),
    ("eshop_fees:charge", "customers", "Χρέωση προμήθειας e-shop", False),

    ("leads:read", "customers", "Προβολή leads", False),
    ("leads:edit", "customers", "Επεξεργασία lead (status, notes, tasks)", False),
    ("leads:segments", "customers", "Διαχείριση segments", False),
    ("leads:config", "customers", "Ρυθμίσεις Lead Engine", False),
    ("leads:refresh", "customers", "Ανανέωση projection", False),
    ("leads:grant_trial", "customers", "Χορήγηση δοκιμαστικής", False),
    ("leads:delete", "customers", "Διαγραφή lead", False),

    # ── Χρεώσεις & πληρωμές ──
    ("billing:read", "billing", "Προβολή τιμολόγησης & υπολοίπων", False),
    ("billing:config", "billing", "Ρυθμίσεις τραπέζης & τρόπων πληρωμής", False),
    ("billing:notify", "billing", "Ειδοποίηση ανοιχτών υπολοίπων", False),
    ("invoices:read", "billing", "Προβολή παραστατικών", False),
    ("invoices:create", "billing", "Έκδοση παραστατικού", False),
    ("invoices:edit", "billing", "Επεξεργασία παραστατικού", False),
    ("invoices:delete", "billing", "Διαγραφή παραστατικού", False),
    ("invoices:settle", "billing", "Εξόφληση παραστατικού", False),
    ("invoices:transmit", "billing", "Διαβίβαση στο myDATA", False),
    ("markup:read", "billing", "Προβολή διατίμησης", False),
    ("markup:write", "billing", "Αλλαγή διατίμησης", False),
    ("markup:recompute", "billing", "Επανυπολογισμός διατίμησης", False),

    ("content:read", "customers", "Προβολή άρθρων & ανακοινώσεων", False),
    ("content:write", "customers", "Δημιουργία & επεξεργασία", False),
    ("content:delete", "customers", "Διαγραφή", False),
    ("newsletter:read", "customers", "Προβολή newsletter & παραληπτών", False),
    ("newsletter:send", "customers", "Αποστολή newsletter", False),

    # ── Λειτουργία & Παρακολούθηση ──
    ("comms:read", "operations", "Προβολή χρήσης & υπολοίπων μηνυμάτων", False),
    ("comms:send", "operations", "Δοκιμαστική αποστολή", False),
    ("comms:senders", "operations", "Έγκριση sender IDs", False),
    ("comms:config", "operations", "Ρυθμίσεις ειδοποιήσεων & παραληπτών", False),

    # ── Κρατικές διασυνδέσεις ──
    ("integrations:read", "government", "Προβολή διασυνδέσεων (και AI Providers)", False),
    ("integrations:write", "government",
     "Αλλαγή κλειδιών & διαπιστευτηρίων (και AI Providers)", True),
    ("integrations:test", "government", "Δοκιμή σύνδεσης", False),
    ("integrations:rotate", "government", "Εναλλαγή κλειδιού SoftOne bridge", True),
    # Το /admin/integrations (κλειδιά παρόχων) είναι ΚΟΙΝΟ με τις Κρατικές διασυνδέσεις —
    # γι' αυτό τα όρια/τιμές AI έχουν δικά τους κλειδιά, αλλά τα κλειδιά παρόχων όχι.
    ("ai:read", "ai_clinical", "Προβολή ορίων & τιμολόγησης AI", False),
    ("ai:write", "ai_clinical", "Αλλαγή ορίων, τιμών & πακέτων AI", False),
    ("pharmacat:read", "ai_clinical", "Προβολή βάσης γνώσης PharmaCat", False),
    ("pharmacat:write", "ai_clinical", "Επεξεργασία βάσης γνώσης", False),
    ("pharmacat:delete", "ai_clinical", "Διαγραφή από βάση γνώσης", False),

    ("monitoring:read", "operations", "Επισκεψιμότητα & υγεία συγχρονισμού", False),
    ("monitoring:run", "operations", "Εκτέλεση ελέγχου ποσών", False),
    ("monitoring:sessions", "operations", "Προβολή συνδεδεμένων & ιστορικού", False),
    ("monitoring:session_revoke", "operations", "Αποσύνδεση χρήστη", False),
    ("monitoring:audit", "operations", "Αρχείο ενεργειών (όλοι οι πελάτες)", True),

    # ── Σύστημα ──
    ("staff:read", "system", "Προβολή ομάδας & δικαιωμάτων", False),
    ("staff:manage", "system", "Διαχείριση χρηστών & ομάδων", True),
    ("staff:password", "system", "Επαναφορά κωδικού συναδέλφου", True),
    ("system:read", "system", "Προβολή ρυθμίσεων συστήματος", False),
    ("system:smtp", "system", "Ρυθμίσεις SMTP", False),
    ("system:maintenance", "system", "Λειτουργία συντήρησης", False),
    ("system:write", "system", "Ρυθμίσεις πύλης & διατήρησης δεδομένων", False),
    ("system:purge", "system", "Εκκαθάριση δεδομένων βάσει πολιτικής", True),
    ("cloud:read", "system", "Προβολή υποδομής", False),
    ("cloud:write", "system", "Ρύθμιση παρόχου cloud", True),
    ("cloud:ops", "system", "Εκτέλεση λειτουργιών σε servers", True),
    ("fund_groups:read", "system", "Προβολή ομάδων ταμείων", False),
    ("fund_groups:write", "system", "Διαχείριση ομάδων ταμείων", False),
]

PERMISSIONS: list[dict] = [
    {"_id": key, "section": section, "label": label, "sensitive": sensitive}
    for key, section, label, sensitive in _DEFS
]

ALL_PERMISSION_KEYS: set[str] = {p["_id"] for p in PERMISSIONS}
SENSITIVE_KEYS: set[str] = {p["_id"] for p in PERMISSIONS if p["sensitive"]}


# ── Χάρτης route → δικαίωμα ────────────────────────────────────────────────
# Κλειδί: (HTTP method, route template ΟΠΩΣ το βλέπει το dependency).
# ⚠️ Τα templates είναι σχετικά ως προς τον router — δες το docstring.

_ADMIN: dict[tuple[str, str], str] = {
    # metadata που χρειάζεται το UI για να ζωγραφιστεί
    ("GET", "/sections"): ANY_ADMIN,
    ("GET", "/permissions"): ANY_ADMIN,

    # πίνακας
    ("GET", "/overview"): "dashboard:read",

    # συνδρομητές
    ("GET", "/tenants"): "tenants:read",
    ("POST", "/tenants"): "tenants:create",
    ("GET", "/tenants/{tenant_id}"): "tenants:read",
    ("PATCH", "/tenants/{tenant_id}"): "tenants:edit",
    ("DELETE", "/tenants/{tenant_id}"): "tenants:delete",
    ("PATCH", "/tenants/{tenant_id}/status"): "tenants:suspend",
    ("GET", "/tenants/{tenant_id}/addons"): "tenants:read",
    ("POST", "/tenants/{tenant_id}/addons/{addon_id}/{op}"): "tenants:addons",
    ("POST", "/tenants/{tenant_id}/cancel"): "tenants:cancel",
    ("POST", "/tenants/{tenant_id}/copy-items"): "tenants:items_copy",
    ("GET", "/catalog-seed/pharmacies"): "tenants:read",
    ("GET", "/catalog-seed/catalog"): "tenants:read",
    ("POST", "/catalog-seed/copy"): "tenants:items_copy",
    ("DELETE", "/tenants/{tenant_id}/items"): "tenants:items_delete",
    ("GET", "/tenants/{tenant_id}/credentials"): "tenants:credentials",
    ("POST", "/tenants/{tenant_id}/impersonate"): "tenants:impersonate",
    ("PUT", "/tenants/{tenant_id}/modules"): "tenants:modules",
    ("POST", "/tenants/{tenant_id}/package"): "tenants:package",
    ("GET", "/tenants/{tenant_id}/profarm-module"): "tenants:read",
    ("POST", "/tenants/{tenant_id}/profarm-module"): "tenants:modules",
    ("POST", "/tenants/{tenant_id}/users/send-credentials"): "tenants:send_credentials",
    ("GET", "/tenants/{tenant_id}/wallet"): "tenants:read",
    ("POST", "/tenants/{tenant_id}/wallet/credit"): "tenants:wallet_credit",
    ("GET", "/network/users"): "tenants:read",
    ("PUT", "/network/users/{user_id}"): "tenants:edit",
    ("GET", "/pending-registrations"): "tenants:read",
    ("POST", "/pending-registrations/{pending_id}/resend"): "tenants:send_credentials",
    ("GET", "/aade/{afm}"): "tenants:read",
    ("GET", "/feedback"): "feedback:read",
    ("POST", "/feedback/{token}/coupon"): "feedback:coupon",

    # συνδρομές & πακέτα
    ("GET", "/subscriptions"): "subscriptions:read",
    ("GET", "/subscriptions/{tenant_id}"): "subscriptions:read",
    ("PATCH", "/subscriptions/{tenant_id}"): "subscriptions:edit",
    ("GET", "/plan-changes"): "subscriptions:read",
    ("POST", "/plan-changes/{tenant_id}/approve"): "subscriptions:plan_change",
    ("POST", "/plan-changes/{tenant_id}/reject"): "subscriptions:plan_change",
    ("POST", "/plan-changes/{tenant_id}/clear-broken"): "subscriptions:plan_change",
    ("GET", "/lifecycle"): "subscriptions:read",
    ("PUT", "/lifecycle"): "subscriptions:lifecycle",
    ("POST", "/lifecycle/run"): "subscriptions:lifecycle_run",
    # Δοκιμές δυνατοτήτων — προβολή με το ίδιο δικαίωμα που βλέπει συνδρομές· η αποστολή
    # ενημέρωσης αγοράς & οι ρυθμίσεις με το δικαίωμα ειδοποιήσεων (φεύγει email σε πελάτη).
    ("GET", "/module-trials"): "subscriptions:read",
    ("POST", "/module-trials/notify"): "subscriptions:notifications",
    ("PUT", "/module-trials/settings"): "subscriptions:notifications",
    ("GET", "/subscription-notifications"): "subscriptions:read",
    ("PUT", "/subscription-notifications"): "subscriptions:notifications",
    ("POST", "/subscription-notifications/test"): "subscriptions:notifications",
    ("POST", "/trials/purge"): "subscriptions:trials_purge",
    ("GET", "/packages"): "packages:read",
    ("PUT", "/packages/{code}"): "packages:write",
    ("DELETE", "/packages/{code}"): "packages:delete",
    ("GET", "/addons"): "packages:read",
    ("PUT", "/addons/{code}"): "packages:write",
    ("DELETE", "/addons/{code}"): "packages:delete",
    ("GET", "/sla"): "packages:read",
    ("PUT", "/sla/{code}"): "packages:write",
    ("DELETE", "/sla/{code}"): "packages:delete",
    ("GET", "/credit-packages"): "packages:read",
    ("PUT", "/credit-packages/{code}"): "packages:write",
    ("DELETE", "/credit-packages/{code}"): "packages:delete",
    ("GET", "/ai-credit-packs"): "ai:read",
    ("PUT", "/ai-credit-packs/{code}"): "ai:write",
    ("DELETE", "/ai-credit-packs/{code}"): "ai:write",
    ("GET", "/ai-limits"): "ai:read",
    ("PUT", "/ai-pricing"): "ai:write",
    ("GET", "/eshop-fees/config"): "eshop_fees:read",
    ("PUT", "/eshop-fees/config"): "eshop_fees:write",
    ("GET", "/eshop-fees/overview"): "eshop_fees:read",
    ("PUT", "/eshop-fees/tenant/{tenant_id}"): "eshop_fees:write",
    ("POST", "/eshop-fees/tenant/{tenant_id}/charge"): "eshop_fees:charge",

    # leads — ρυθμίσεις που έμειναν στον admin.py
    ("PUT", "/leads-config"): "leads:config",

    # χρεώσεις & πληρωμές
    ("GET", "/billing"): "billing:read",
    ("GET", "/billing-bank"): "billing:read",
    ("PUT", "/billing-bank"): "billing:config",
    ("GET", "/payment-methods"): "billing:read",
    ("PUT", "/payment-methods"): "billing:config",
    ("GET", "/open-balances"): "billing:read",
    ("POST", "/open-balances/notify"): "billing:notify",
    ("GET", "/invoices"): "invoices:read",
    ("POST", "/invoices"): "invoices:create",
    ("GET", "/invoices/{invoice_id}"): "invoices:read",
    ("PATCH", "/invoices/{invoice_id}"): "invoices:edit",
    ("DELETE", "/invoices/{invoice_id}"): "invoices:delete",
    ("POST", "/invoices/{invoice_id}/settle"): "invoices:settle",
    ("POST", "/invoices/{invoice_id}/transmit"): "invoices:transmit",
    ("GET", "/markup"): "markup:read",
    ("PUT", "/markup"): "markup:write",
    ("POST", "/markup/recompute"): "markup:recompute",

    # περιεχόμενο
    ("GET", "/posts"): "content:read",
    ("POST", "/posts"): "content:write",
    ("PATCH", "/posts/{post_id}"): "content:write",
    ("DELETE", "/posts/{post_id}"): "content:delete",
    ("GET", "/announcements"): "content:read",
    ("POST", "/announcements"): "content:write",
    ("PUT", "/announcements/{ann_id}"): "content:write",
    ("DELETE", "/announcements/{ann_id}"): "content:delete",
    ("POST", "/announcements/{ann_id}/active"): "content:write",
    ("GET", "/announcements/{ann_id}/audience"): "content:read",
    ("POST", "/announcements/{ann_id}/move"): "content:write",
    ("GET", "/announcement-requests"): "content:read",
    ("POST", "/announcement-requests/grant"): "content:write",
    ("POST", "/announcement-requests/{req_id}/close"): "content:write",
    ("GET", "/announcement-copy/{addon_key}"): "content:read",
    ("GET", "/newsletter"): "newsletter:read",
    ("POST", "/newsletter"): "newsletter:send",
    ("POST", "/newsletter/preview"): "newsletter:read",
    ("GET", "/newsletter/recipients"): "newsletter:read",
    ("POST", "/newsletter/test"): "newsletter:send",

    # επικοινωνίες
    ("GET", "/comms/apifon-balance"): "comms:read",
    ("GET", "/comms/profit"): "comms:read",
    ("GET", "/comms/usage-by-tenant"): "comms:read",
    ("GET", "/comms/senders"): "comms:read",
    ("POST", "/comms/senders/approve"): "comms:senders",
    ("POST", "/comms/senders/clear"): "comms:senders",
    ("POST", "/comms/test-send"): "comms:send",
    ("GET", "/alert-recipients"): "comms:read",
    ("PUT", "/alert-recipients"): "comms:config",
    ("POST", "/alert-recipients/test"): "comms:send",
    ("GET", "/notifications"): "comms:read",
    ("PUT", "/notifications"): "comms:config",

    # διασυνδέσεις
    ("GET", "/integrations"): "integrations:read",
    ("PUT", "/integrations"): "integrations:write",
    ("POST", "/integrations/softone/test"): "integrations:test",
    ("GET", "/idika"): "integrations:read",
    ("PUT", "/idika"): "integrations:write",
    ("GET", "/softone/items"): "integrations:read",
    ("PUT", "/softone/items"): "integrations:write",
    ("GET", "/softone/bridge"): "integrations:read",
    ("POST", "/softone/bridge/rotate"): "integrations:rotate",
    ("GET", "/area-aliases"): "integrations:read",
    ("POST", "/area-aliases/override"): "integrations:write",
    ("GET", "/pharmacat-kb"): "pharmacat:read",
    ("PUT", "/pharmacat-kb/{sig}"): "pharmacat:write",
    ("DELETE", "/pharmacat-kb/{sig}"): "pharmacat:delete",
    ("POST", "/pharmacat-kb/{sig}/regenerate"): "pharmacat:write",
    ("POST", "/pharmacat-kb/{sig}/resolve"): "pharmacat:write",

    # παρακολούθηση
    ("GET", "/health"): "monitoring:read",
    ("GET", "/sync-health"): "monitoring:read",
    ("GET", "/amount-audit/log"): "monitoring:read",
    ("GET", "/amount-audit/status"): "monitoring:read",
    ("POST", "/amount-audit/run"): "monitoring:run",
    ("GET", "/sessions"): "monitoring:sessions",
    ("GET", "/session-history"): "monitoring:sessions",
    ("POST", "/sessions/{sid}/revoke"): "monitoring:session_revoke",
    ("GET", "/audit-logs"): "monitoring:audit",

    # σύστημα
    ("GET", "/staff"): "staff:read",
    ("POST", "/staff"): "staff:manage",
    ("PATCH", "/staff/{admin_id}"): "staff:manage",
    ("DELETE", "/staff/{admin_id}"): "staff:manage",
    ("PATCH", "/staff/{admin_id}/status"): "staff:manage",
    ("POST", "/staff/{admin_id}/reset-password"): "staff:password",
    ("POST", "/staff/{admin_id}/send-credentials"): "staff:password",
    ("GET", "/groups"): "staff:read",
    ("POST", "/groups"): "staff:manage",
    ("PATCH", "/groups/{group_id}"): "staff:manage",
    ("DELETE", "/groups/{group_id}"): "staff:manage",
    ("GET", "/smtp"): "system:read",
    ("PUT", "/smtp"): "system:smtp",
    ("POST", "/smtp/test"): "system:smtp",
    ("GET", "/maintenance"): "system:read",
    ("PUT", "/maintenance"): "system:maintenance",
    ("GET", "/portal-mode"): "system:read",
    ("PUT", "/portal-mode"): "system:write",
    ("GET", "/data-retention"): "system:read",
    ("PUT", "/data-retention/pricing"): "system:write",
    ("POST", "/data-retention/purge"): "system:purge",
}

_ADMIN_LEADS: dict[tuple[str, str], str] = {
    ("GET", "/admin/leads"): "leads:read",
    ("GET", "/admin/leads/overview"): "leads:read",
    ("GET", "/admin/leads/config"): "leads:read",
    ("PUT", "/admin/leads/config"): "leads:config",
    ("POST", "/admin/leads/refresh"): "leads:refresh",
    ("GET", "/admin/leads/segments"): "leads:read",
    ("POST", "/admin/leads/segments"): "leads:segments",
    ("GET", "/admin/leads/segments/fields"): "leads:read",
    ("POST", "/admin/leads/segments/preview"): "leads:read",
    ("DELETE", "/admin/leads/segments/{segment_id}"): "leads:segments",
    ("GET", "/admin/leads/tasks"): "leads:read",
    ("POST", "/admin/leads/tasks/{task_id}/done"): "leads:edit",
    ("GET", "/admin/leads/{lead_key:path}/detail"): "leads:read",
    ("GET", "/admin/leads/{lead_key:path}/trials"): "leads:read",
    ("POST", "/admin/leads/{lead_key:path}/assign"): "leads:edit",
    ("PATCH", "/admin/leads/{lead_key:path}/contact"): "leads:edit",
    ("POST", "/admin/leads/{lead_key:path}/notes"): "leads:edit",
    ("POST", "/admin/leads/{lead_key:path}/status"): "leads:edit",
    ("POST", "/admin/leads/{lead_key:path}/tags"): "leads:edit",
    ("POST", "/admin/leads/{lead_key:path}/tasks"): "leads:edit",
    ("POST", "/admin/leads/{lead_key:path}/grant-trial"): "leads:grant_trial",
    ("POST", "/admin/leads/{lead_key:path}/trial-allowed"): "leads:grant_trial",
    ("DELETE", "/admin/leads/{lead_key:path}"): "leads:delete",
}

_CLOUD: dict[tuple[str, str], str] = {
    ("GET", ""): "cloud:read",
    ("PUT", ""): "cloud:write",
    ("DELETE", ""): "cloud:write",
    ("POST", "/verify"): "cloud:read",
    ("GET", "/server-options"): "cloud:read",
    ("GET", "/infra"): "cloud:read",
    ("GET", "/backups"): "cloud:read",
    ("GET", "/serving"): "cloud:read",
    ("GET", "/ops"): "cloud:read",
    ("POST", "/ops"): "cloud:ops",
}

_FUND_GROUPS: dict[tuple[str, str], str] = {
    ("GET", ""): "fund_groups:read",
    ("GET", "/catalog"): "fund_groups:read",
    ("POST", ""): "fund_groups:write",
    ("PUT", "/{group_id}"): "fund_groups:write",
    ("DELETE", "/{group_id}"): "fund_groups:write",
    ("POST", "/assign"): "fund_groups:write",
}

# scope key → χάρτης. Το scope δηλώνεται όταν συνδέεται το gate στον router.
ROUTE_PERMISSIONS: dict[str, dict[tuple[str, str], str]] = {
    "admin": _ADMIN,
    "admin_leads": _ADMIN_LEADS,
    "cloud": _CLOUD,
    "fund_groups": _FUND_GROUPS,
}


def permission_for(scope: str, method: str, template: str) -> str | None:
    """Το δικαίωμα που απαιτεί μια διαδρομή, ή None αν δεν είναι χαρτογραφημένη
    (⇒ απαγόρευση)."""
    return ROUTE_PERMISSIONS.get(scope, {}).get((method.upper(), template))


# ── Default ομάδες ─────────────────────────────────────────────────────────
# Καμία ΔΕΝ περιέχει sensitive δικαίωμα: αυτά δίνονται πάντα ρητά, ανά περίπτωση.
def _read_only() -> list[str]:
    return sorted(k for k in ALL_PERMISSION_KEYS if k.endswith(":read") and k not in SENSITIVE_KEYS)


# Η ΜΟΝΗ default ομάδα που κουβαλά sensitive δικαιώματα, σκόπιμα: είναι ο ρόλος
# «διαχειριστής» με τα πάντα. Διαφέρει από το `super_admin` flag — ο flag παρακάμπτει τον
# έλεγχο εντελώς και παίρνει αυτόματα ό,τι νέο προστεθεί· αυτή η ομάδα είναι ρητή λίστα που
# τη βλέπεις και την πειράζεις στον πίνακα. Το test φροντίζει να μη μείνει πίσω.
ADMIN_GROUP_KEY = "admin"

DEFAULT_GROUPS: list[dict] = [
    {
        "key": ADMIN_GROUP_KEY,
        "name": "Διαχειριστές",
        "description": "Πλήρης πρόσβαση σε όλες τις δυνατότητες, συμπεριλαμβανομένων των "
                       "επικίνδυνων ενεργειών. Μόνο για όσους διαχειρίζονται την πλατφόρμα.",
        "permissions": sorted(ALL_PERMISSION_KEYS),
    },
    {
        "key": "readonly",
        "name": "Μόνο ανάγνωση",
        "description": "Βλέπει τα πάντα, δεν αλλάζει τίποτα. Κατάλληλο για integrations "
                       "και για νέα μέλη στις πρώτες μέρες.",
        "permissions": _read_only(),
    },
    {
        "key": "support",
        "name": "Υποστήριξη πελατών",
        "description": "Καθημερινή εξυπηρέτηση φαρμακείων: καρτέλα πελάτη, συνδρομή, "
                       "ανακοινώσεις, αξιολογήσεις. Χωρίς σύνδεση ως πελάτης.",
        "permissions": sorted({
            "dashboard:read", "tenants:read", "tenants:edit", "tenants:addons",
            "tenants:wallet_credit", "feedback:read", "feedback:coupon",
            "subscriptions:read", "packages:read", "content:read",
            "comms:read", "monitoring:read", "monitoring:sessions",
        }),
    },
    {
        "key": "sales",
        "name": "Πωλήσεις",
        "description": "Lead Engine, άνοιγμα νέων πελατών, πακέτα & δοκιμαστικές.",
        "permissions": sorted({
            "dashboard:read", "leads:read", "leads:edit", "leads:segments",
            "leads:refresh", "leads:grant_trial", "tenants:read", "tenants:create",
            "tenants:package", "subscriptions:read", "subscriptions:plan_change",
            "packages:read", "content:read",
        }),
    },
    {
        "key": "finance",
        "name": "Λογιστήριο",
        "description": "Τιμολόγηση, παραστατικά, myDATA, διατίμηση, ανοιχτά υπόλοιπα.",
        "permissions": sorted({
            "dashboard:read", "tenants:read", "subscriptions:read", "subscriptions:edit",
            "packages:read", "billing:read", "billing:notify",
            "invoices:read", "invoices:create", "invoices:edit", "invoices:settle",
            "invoices:transmit", "markup:read", "markup:write", "markup:recompute",
            "eshop_fees:read", "eshop_fees:write", "eshop_fees:charge",
        }),
    },
    {
        "key": "marketing",
        "name": "Marketing",
        "description": "Newsletter, ανακοινώσεις, άρθρα, καμπάνιες επικοινωνίας.",
        "permissions": sorted({
            "dashboard:read", "content:read", "content:write", "content:delete",
            "newsletter:read", "newsletter:send", "comms:read", "comms:send",
            "tenants:read", "leads:read",
        }),
    },
    {
        "key": "tech",
        "name": "Τεχνική υποστήριξη",
        "description": "Διασυνδέσεις, συγχρονισμοί, υποδομή, PharmaCat. Χωρίς κλειδιά "
                       "και χωρίς λειτουργίες σε servers — αυτά δίνονται ξεχωριστά.",
        "permissions": sorted({
            "dashboard:read", "tenants:read", "tenants:modules",
            "integrations:read", "integrations:test",
            "ai:read", "ai:write",
            "pharmacat:read", "pharmacat:write", "pharmacat:delete",
            "monitoring:read", "monitoring:run", "monitoring:sessions",
            "monitoring:session_revoke", "cloud:read", "system:read",
            "fund_groups:read", "fund_groups:write",
        }),
    },
]


# ── Επίλυση δικαιωμάτων ────────────────────────────────────────────────────
async def effective_permissions(admin: dict) -> set[str]:
    """Ένωση των δικαιωμάτων των ομάδων του χρήστη.

    `super_admin` → wildcard. Legacy λογαριασμοί χωρίς `group_ids` ΔΕΝ πέφτουν πίσω
    στο παλιό `permissions[]`: μετά το migration όποιος δεν έχει ομάδα δεν έχει
    πρόσβαση, που είναι και το ασφαλές default.
    """
    if admin.get("super_admin"):
        return {WILDCARD}
    gids = [g if isinstance(g, ObjectId) else ObjectId(g)
            for g in (admin.get("group_ids") or []) if g]
    if not gids:
        return set()
    perms: set[str] = set()
    async for g in shared_db()["platform_groups"].find({"_id": {"$in": gids}}, {"permissions": 1}):
        perms.update(g.get("permissions") or [])
    return perms & ALL_PERMISSION_KEYS


def has_permission(perms: set[str], needed: str) -> bool:
    if needed == ANY_ADMIN:
        return True
    return WILDCARD in perms or needed in perms


def clean_permissions(keys: list[str] | None) -> list[str]:
    """Κρατά μόνο υπαρκτά κλειδιά — άγνωστα πετιούνται σιωπηλά (όπως το παλιό
    `_clean_perms`), ώστε ένα παλιό UI να μη γράψει σκουπίδια στη βάση."""
    return sorted({k for k in (keys or []) if k in ALL_PERMISSION_KEYS})


def catalog_for_ui() -> dict[str, Any]:
    """Κατάλογος ομαδοποιημένος ανά ενότητα, έτοιμος για τη σελίδα ομάδων."""
    by_section: dict[str, list[dict]] = {}
    for p in PERMISSIONS:
        by_section.setdefault(p["section"], []).append(p)
    return {
        "sections": [
            {"key": key, "label": label, "permissions": by_section.get(key, [])}
            for key, label in SECTIONS
        ],
        "sensitive": sorted(SENSITIVE_KEYS),
    }


# ── Seed ───────────────────────────────────────────────────────────────────
async def seed_platform_groups() -> int:
    """Idempotent upsert των default ομάδων.

    Ενημερώνει ΜΟΝΟ όσες είναι ακόμη `is_system` και αμετάβλητες από άνθρωπο: αν κάποιος
    πείραξε τα δικαιώματα μιας default ομάδας, η επιλογή του δεν ξαναγράφεται σε κάθε
    deploy (`customized: True`).
    """
    db = shared_db()
    for g in DEFAULT_GROUPS:
        existing = await db["platform_groups"].find_one({"key": g["key"]})
        if existing and existing.get("customized"):
            continue
        await db["platform_groups"].update_one(
            {"key": g["key"]},
            {"$set": {"name": g["name"], "description": g["description"],
                      "permissions": clean_permissions(g["permissions"]),
                      "is_system": True, "updated_at": _now()},
             "$setOnInsert": {"tenant_scope": None, "created_at": _now()}},
            upsert=True)
    return len(DEFAULT_GROUPS)
