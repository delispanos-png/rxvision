"""Back-office RBAC invariants.

Ο σκοπός αυτού του αρχείου είναι ΕΝΑΣ: να είναι αδύνατο να προστεθεί endpoint στο
back-office χωρίς να δηλωθεί ποιο δικαίωμα απαιτεί. Το gate απαγορεύει ό,τι δεν είναι
χαρτογραφημένο, οπότε ένα ξεχασμένο route δεν ανοίγει τρύπα — αλλά θα «σπάσει» σιωπηλά
στην παραγωγή. Αυτό το test το πιάνει στο CI.
"""

from __future__ import annotations

import pytest
from fastapi.routing import APIRoute

from app.api.v1.routers import admin, admin_leads, fund_groups, infra_cloud
from app.services.platform_rbac import (
    ADMIN_GROUP_KEY,
    ALL_PERMISSION_KEYS,
    ANY_ADMIN,
    DEFAULT_GROUPS,
    PERMISSIONS,
    ROUTE_PERMISSIONS,
    SECTIONS,
    SENSITIVE_KEYS,
    permission_for,
)

# scope key → το module που κρατά τον router. Ίδια αντιστοίχιση με αυτήν που
# χρησιμοποιείται όταν συνδέεται το gate στο app/api/v1/__init__.py.
ROUTERS = {
    "admin": admin.router,
    "admin_leads": admin_leads.router,
    "cloud": infra_cloud.router,
    "fund_groups": fund_groups.router,
}


def _routes() -> list[tuple[str, str, str]]:
    """(scope, method, template) για κάθε endpoint του back-office."""
    out = []
    for scope, router in ROUTERS.items():
        for r in router.routes:
            if isinstance(r, APIRoute):
                for method in sorted(r.methods - {"HEAD", "OPTIONS"}):
                    out.append((scope, method, r.path))
    return out


def test_every_backoffice_route_declares_a_permission():
    missing = [(s, m, p) for s, m, p in _routes() if permission_for(s, m, p) is None]
    assert not missing, (
        "Τα παρακάτω endpoints δεν έχουν δικαίωμα στο ROUTE_PERMISSIONS και επομένως "
        "θα απαγορεύονται σε όλους πλην super admin. Πρόσθεσέ τα στο platform_rbac.py:\n"
        + "\n".join(f"  ({m!r}, {p!r})  → scope {s}" for s, m, p in sorted(missing))
    )


def test_no_stale_entries_in_route_map():
    """Ο χάρτης δεν κρατά διαδρομές που δεν υπάρχουν πια — αλλιώς σέρνουμε ψέματα."""
    real = {(s, m, p) for s, m, p in _routes()}
    mapped = {(scope, m, p) for scope, table in ROUTE_PERMISSIONS.items() for (m, p) in table}
    stale = mapped - real
    assert not stale, (
        "Ο χάρτης αναφέρεται σε ανύπαρκτες διαδρομές:\n"
        + "\n".join(f"  {s}: {m} {p}" for s, m, p in sorted(stale))
    )


def test_mapped_permissions_exist_in_catalog():
    used = {perm for table in ROUTE_PERMISSIONS.values() for perm in table.values()}
    unknown = {p for p in used if p != ANY_ADMIN and p not in ALL_PERMISSION_KEYS}
    assert not unknown, f"Άγνωστα κλειδιά δικαιωμάτων στον χάρτη: {sorted(unknown)}"


def test_catalog_keys_are_unique_and_well_formed():
    keys = [p["_id"] for p in PERMISSIONS]
    assert len(keys) == len(set(keys)), "Διπλότυπο κλειδί δικαιώματος"
    sections = {k for k, _ in SECTIONS}
    for p in PERMISSIONS:
        assert ":" in p["_id"], f"{p['_id']}: αναμένεται μορφή resource:action"
        assert p["section"] in sections, f"{p['_id']}: άγνωστη ενότητα {p['section']}"
        assert p["label"], f"{p['_id']}: λείπει ετικέτα"


def test_every_permission_is_reachable():
    """Δικαίωμα που δεν προστατεύει καμία διαδρομή είναι παραπλανητικό στο UI:
    ο διαχειριστής το τικάρει και δεν κάνει τίποτα."""
    used = {perm for table in ROUTE_PERMISSIONS.values() for perm in table.values()}
    orphans = ALL_PERMISSION_KEYS - used
    assert not orphans, f"Δικαιώματα χωρίς καμία διαδρομή: {sorted(orphans)}"


@pytest.mark.parametrize("group", DEFAULT_GROUPS, ids=lambda g: g["key"])
def test_default_groups_never_carry_sensitive_permissions(group):
    """Οι επικίνδυνες ενέργειες δίνονται πάντα ρητά, ποτέ «κατά λάθος» μέσω ρόλου.

    Εξαίρεση: η ομάδα «Διαχειριστές» ΠΡΕΠΕΙ να τα έχει — αυτός είναι ο σκοπός της. Η
    εξαίρεση είναι ονομαστική ώστε καμία ΑΛΛΗ ομάδα να μην μπορεί να τα αποκτήσει αθόρυβα.
    """
    if group["key"] == ADMIN_GROUP_KEY:
        pytest.skip("η ομάδα διαχειριστών έχει σκόπιμα τα πάντα")
    leaked = set(group["permissions"]) & SENSITIVE_KEYS
    assert not leaked, f"Η ομάδα «{group['name']}» περιέχει επικίνδυνα: {sorted(leaked)}"


def test_admin_group_has_every_permission():
    """Αν προστεθεί νέο δικαίωμα και ξεχαστεί από τους «Διαχειριστές», ο διαχειριστής θα
    ανακαλύψει το κενό σε λάθος στιγμή — στην παραγωγή."""
    admin = next(g for g in DEFAULT_GROUPS if g["key"] == ADMIN_GROUP_KEY)
    missing = ALL_PERMISSION_KEYS - set(admin["permissions"])
    assert not missing, f"Λείπουν από τους «Διαχειριστές»: {sorted(missing)}"


@pytest.mark.parametrize("group", DEFAULT_GROUPS, ids=lambda g: g["key"])
def test_default_groups_reference_real_permissions(group):
    unknown = set(group["permissions"]) - ALL_PERMISSION_KEYS
    assert not unknown, f"Η ομάδα «{group['name']}» αναφέρει άγνωστα: {sorted(unknown)}"


def test_readonly_group_can_feed_the_lovable_integration():
    """Ο λογαριασμός του Lovable τρέχει με την ομάδα «Μόνο ανάγνωση». Αν κάποιος
    αφαιρέσει αυτά τα δύο, το integration σπάει σιωπηλά."""
    readonly = next(g for g in DEFAULT_GROUPS if g["key"] == "readonly")
    assert {"tenants:read", "subscriptions:read"} <= set(readonly["permissions"])


def test_readonly_group_has_no_write_access():
    readonly = next(g for g in DEFAULT_GROUPS if g["key"] == "readonly")
    assert all(p.endswith(":read") for p in readonly["permissions"])
