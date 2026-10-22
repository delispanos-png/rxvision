"""Αποθήκη = βασική για ΟΛΑ τα πακέτα (21/10/2026)· το e-shop μένει πρόσθετο μόνο για την πώληση."""

from __future__ import annotations

from app.services.auth_service import resolve_modules, tenant_has


def test_every_plan_has_the_warehouse_but_not_the_eshop():
    mods = resolve_modules(set(), {})
    assert tenant_has(mods, "warehouse") and not tenant_has(mods, "order_delivery")
    with_shop = resolve_modules({"order_delivery"}, {})
    assert tenant_has(with_shop, "warehouse") and tenant_has(with_shop, "order_delivery")


def test_warehouse_endpoints_accept_old_tokens_and_selling_stays_eshop():
    import app.api.v1.routers.pharmacy_catalog as r
    assert r._WH == ["warehouse", "order_delivery"] and r._MODULE == "order_delivery"
