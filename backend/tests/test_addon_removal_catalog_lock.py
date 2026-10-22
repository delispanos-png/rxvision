"""Αφαίρεση προσθέτου στη λήξη + κλείδωμα Έτοιμου καταλόγου (απόφαση ιδιοκτήτη 20/10/2026).

1. Ο πελάτης που αφαιρεί πρόσθετο το έχει πληρώσει ως τη λήξη: μένει ενεργό ως τότε, ΔΕΝ ανανεώνεται.
2. Λήξη Έτοιμου καταλόγου: είδη RxVision χωρίς κίνηση σβήνονται· με κίνηση ΚΛΕΙΔΩΝΟΥΝ (φαίνονται, δεν
   χρησιμοποιούνται)· όσα έφτιαξε ο ίδιος δεν αγγίζονται. Ξεκλείδωμα ΜΟΝΟ με επανενεργοποίηση.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import app.core.db as core_db
import app.services.addon_service as addon_service
import app.services.billing_service as bs
from app.repositories.pharmacy_catalog import PharmacyCatalogRepository
from mongomock_motor import AsyncMongoMockClient

T = "ph-cat"
SRC = "ph-src"


async def _db(monkeypatch):
    db = AsyncMongoMockClient(tz_aware=True)["addon_rm"]
    monkeypatch.setattr(addon_service, "shared_db", lambda: db)
    monkeypatch.setattr(bs, "shared_db", lambda: db)
    monkeypatch.setattr(core_db.db_resolver, "resolve", lambda **k: db)
    await db["addons"].insert_one({"_id": "catalog_seed", "name": "Έτοιμος κατάλογος", "active": True,
                                   "price_monthly": 1500, "price_yearly": 15000})
    return db


async def test_removal_waits_for_paid_period_and_is_not_renewed(monkeypatch):
    db = await _db(monkeypatch)
    end = (datetime.now(timezone.utc) + timedelta(days=5)).replace(microsecond=0)
    await db["tenants"].insert_one({"_id": T, "modules": {"catalog_seed": "enabled"}})
    await db["subscriptions"].insert_one({"tenant_id": T, "addons": ["catalog_seed"], "billing_cycle": "monthly",
                                          "current_period_end": end})
    r = await addon_service.schedule_removal(T, "catalog_seed", by="u1")
    assert r["scheduled"] and r["effective_at"] == end
    t = await db["tenants"].find_one({"_id": T})
    sub = await db["subscriptions"].find_one({"tenant_id": T})
    assert t["modules"]["catalog_seed"] == "enabled" and "catalog_seed" in sub["addons"]     # ακόμη ενεργό
    ex = await bs.recurring_extras(db, sub, None, False)
    assert ex["addons"] == 0                                                                  # δεν ανανεώνεται

    # «Κράτησέ το» → ακύρωση ΧΩΡΙΣ χρέωση
    kept = await addon_service.activate(T, "catalog_seed")
    assert kept["kept"] and kept["charged_now"] == 0
    assert not (await db["subscriptions"].find_one({"tenant_id": T})).get("addon_removals")

    # ξανά αφαίρεση → στη λήξη κλείνει
    await addon_service.schedule_removal(T, "catalog_seed")
    assert await addon_service.apply_due_removals(now=end - timedelta(hours=1)) == 0
    assert await addon_service.apply_due_removals(now=end + timedelta(minutes=1)) == 1
    t = await db["tenants"].find_one({"_id": T})
    assert "catalog_seed" not in (t.get("modules") or {})
    assert not (await db["subscriptions"].find_one({"tenant_id": T})).get("addons")


async def test_no_paid_period_left_means_immediate(monkeypatch):
    db = await _db(monkeypatch)
    await db["tenants"].insert_one({"_id": T, "modules": {"catalog_seed": "enabled"}})
    await db["subscriptions"].insert_one({"tenant_id": T, "addons": ["catalog_seed"],
                                          "current_period_end": datetime.now(timezone.utc) - timedelta(days=1)})
    r = await addon_service.schedule_removal(T, "catalog_seed")
    assert r["ok"] and not r.get("scheduled")
    assert "catalog_seed" not in ((await db["tenants"].find_one({"_id": T})).get("modules") or {})


async def _seeded(db):
    """Πηγή με 6 είδη· ο πελάτης είχε ΗΔΗ δικό του το «own-1» (ίδιο barcode με πηγή) + «mine» χειροκίνητο."""
    for bc in ("idle-1", "idle-2", "stock-1", "sale-1", "moved-1", "own-1"):
        await db["pharmacy_products"].insert_one({"tenant_id": SRC, "barcode": bc, "name": bc,
                                                  "price_cents": 1000, "type": "parapharmacy"})
    await db["pharmacy_products"].insert_one({"tenant_id": T, "barcode": "own-1", "name": "δικό μου",
                                              "price_cents": 900, "stock_qty": 0})
    await db["pharmacy_products"].insert_one({"tenant_id": T, "barcode": "mine", "name": "χειροκίνητο",
                                              "price_cents": 500, "stock_qty": 0, "source": "manual"})
    repo = PharmacyCatalogRepository(tenant_id=T)
    r = await repo.copy_from(SRC, overwrite=True)
    assert r["copied"] == 5 and r["updated"] == 1
    col = db["pharmacy_products"]
    assert (await col.find_one({"tenant_id": T, "barcode": "own-1"})).get("origin") is None   # μένει δικό του
    assert (await col.find_one({"tenant_id": T, "barcode": "idle-1"}))["origin"] == "rxvision"
    # κίνηση: απόθεμα / προς πώληση / κίνηση αποθήκης / δική του αλλαγή τιμής
    await col.update_one({"tenant_id": T, "barcode": "stock-1"}, {"$set": {"stock_qty": 3}})
    await col.update_one({"tenant_id": T, "barcode": "sale-1"}, {"$set": {"for_sale": True}})
    await db["pharmacy_stock_movements"].insert_one({"tenant_id": T, "barcode": "moved-1", "delta": 1})
    await col.update_one({"tenant_id": T, "barcode": "idle-2"}, {"$set": {"price_cents": 1100}})
    return repo, col


async def test_expiry_deletes_idle_locks_used_keeps_own(monkeypatch):
    db = await _db(monkeypatch)
    repo, col = await _seeded(db)
    assert await repo.seed_release_preview() == {"delete": 1, "lock": 4}
    r = await repo.seed_release()
    assert r == {"ok": True, "deleted": 1, "locked": 4}
    left = {p["barcode"]: p async for p in col.find({"tenant_id": T})}
    assert "idle-1" not in left and {"own-1", "mine"} <= set(left)
    assert not left["own-1"].get("catalog_locked") and not left["mine"].get("catalog_locked")
    for bc in ("idle-2", "stock-1", "sale-1", "moved-1"):
        assert left[bc]["catalog_locked"] and left[bc]["active"] is False and left[bc]["for_sale"] is False

    # δεν ξαναμπαίνει σε χρήση με το χέρι
    assert (await repo.set_flags("sale-1", for_sale=True))["error"] == "catalog_locked"
    assert (await repo.set_flags("stock-1", active=True))["error"] == "catalog_locked"
    assert await repo.apply_stock("stock-1", delta=1) is None
    await repo.upsert({"barcode": "stock-1", "name": "αλλαγή", "active": True, "for_sale": True})
    p = await col.find_one({"tenant_id": T, "barcode": "stock-1"})
    assert p["active"] is False and p["for_sale"] is False and p["origin"] == "rxvision"
    # φαίνεται στην αποθήκη, όχι στις επιλογές των κυκλωμάτων
    wh = await repo.warehouse(origin="rxvision")
    assert {i["barcode"] for i in wh["items"]} == {"idle-2", "stock-1", "sale-1", "moved-1"}
    assert {i["barcode"] for i in (await repo.warehouse(origin="own"))["items"]} == {"own-1", "mine"}

    # επανενεργοποίηση → ξεκλείδωμα όπως ήταν
    assert (await repo.seed_unlock())["unlocked"] == 4
    p = await col.find_one({"tenant_id": T, "barcode": "sale-1"})
    assert p["active"] is True and p["for_sale"] is True and "catalog_locked" not in p


async def test_addon_deactivation_triggers_release(monkeypatch):
    db = await _db(monkeypatch)
    await _seeded(db)
    await db["tenants"].insert_one({"_id": T, "modules": {"catalog_seed": "enabled"}})
    await db["subscriptions"].insert_one({"tenant_id": T, "addons": ["catalog_seed"]})
    await addon_service.deactivate(T, "catalog_seed")
    col = db["pharmacy_products"]
    assert await col.count_documents({"tenant_id": T, "catalog_locked": True}) == 4
    assert not await col.find_one({"tenant_id": T, "barcode": "idle-1"})
