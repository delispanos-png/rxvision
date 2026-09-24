"""RxVision Connect — τα σενάρια συνεργασίας από άκρη σε άκρη (§36 της προδιαγραφής).

ΧΡΕΙΑΖΕΤΑΙ MONGO: αν δεν υπάρχει, τα τεστ παρακάμπτονται αντί να «κοκκινίσουν» ψευδώς. Τα
δοκιμαστικά φαρμακεία έχουν αναγνωριστικά `T-ZZTEST-*` και καθαρίζονται πριν και μετά — δεν
δημιουργούνται ποτέ εγγραφές στον πίνακα `tenants`, γι' αυτό ο κατάλογος φαρμακείων
αντικαθίσταται με δοκιμαστικό (monkeypatch).

ΤΙ ΦΥΛΑΕΙ ΚΥΡΙΩΣ: την ΟΡΑΤΟΤΗΤΑ. Ένα δίκτυο δεν επιτρέπεται να γίνει ορατό σε φαρμακείο που
δεν ανήκει σ' αυτό — ούτε καν η ΥΠΑΡΞΗ του (§3).
"""

from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.asyncio

A, B, C_ = "T-ZZTEST-A", "T-ZZTEST-B", "T-ZZTEST-C"
NAMES = {A: "Φ.Α", B: "Φ.Β", C_: "Φ.Γ"}
BARCODE = "9999999999999"


async def _cleanup(db, mod):
    ids = [A, B, C_]
    for coll in (mod.GROUPS, mod.INVITES, mod.REQUESTS, mod.OFFERS, mod.RESERVATIONS,
                 mod.MOVEMENTS, mod.RETURNS, mod.SETTLEMENTS, mod.DISPUTES):
        await db[coll].delete_many({"$or": [
            {"owner_tenant_id": {"$in": ids}}, {"members": {"$in": ids}},
            {"from_tenant_id": {"$in": ids}}, {"to_tenant_id": {"$in": ids}},
            {"tenant_id": {"$in": ids}}, {"source_tenant_id": {"$in": ids}},
            {"opened_by": {"$in": ids}}, {"by": {"$in": ids}}]})
    for coll in ("pharmacy_products", "pharmacy_stock_movements", "connect_policies"):
        await db[coll].delete_many({"tenant_id": {"$in": ids}})


@pytest.fixture
async def net(monkeypatch):
    """Τρία φαρμακεία σε καθαρή βάση, με δοκιμαστικό κατάλογο φαρμακείων."""
    try:
        from app.core.db import shared_db
        db = shared_db()
        await asyncio.wait_for(db.command("ping"), timeout=3)
    except Exception:  # noqa: BLE001
        pytest.skip("Δεν υπάρχει MongoDB — τα σενάρια συνεργασίας παρακάμπτονται")

    from app.repositories import connect as mod
    from app.services import pharmacy_directory as directory

    async def _block(target, *, module, require_module):
        return None

    async def _by_afm(afm):
        return {"1": A, "2": B, "3": C_}.get(str(afm))

    async def _name(t):
        return NAMES.get(t, t)

    async def _names(ids):
        return {i: NAMES.get(i, i) for i in ids}

    monkeypatch.setattr(directory, "join_block", _block)
    monkeypatch.setattr(directory, "find_tenant_by_afm", _by_afm)
    monkeypatch.setattr(directory, "tenant_name", _name)
    monkeypatch.setattr(directory, "names_of", _names)

    await _cleanup(db, mod)
    repos = {t: mod.ConnectRepository(tenant_id=t) for t in (A, B, C_)}
    yield {"db": db, "mod": mod, "r": repos}
    await _cleanup(db, mod)


async def _join(net, owner, guest, name):
    g = await net["r"][owner].create_group(name)
    await net["r"][owner].invite(g["id"], {A: "1", B: "2", C_: "3"}[guest])
    inv = await net["r"][guest].my_invites()
    await net["r"][guest].respond(inv[0]["id"], True)
    return g


async def test_invitation_must_be_accepted(net):
    g = await net["r"][A].create_group("Δίκτυο 1")
    await net["r"][A].invite(g["id"], "2")
    assert await net["r"][B].groups() == [], "πριν την αποδοχή δεν υπάρχει σχέση"
    inv = await net["r"][B].my_invites()
    await net["r"][B].respond(inv[0]["id"], False)
    assert await net["r"][B].groups() == [], "μετά την άρνηση ούτε"


async def test_one_pharmacy_never_learns_of_another_network(net):
    """Το Α ∈ Δίκτυο1, το Γ ∈ Δίκτυο2, το Β και στα δύο. Το Α δεν μαθαίνει ποτέ για το Γ."""
    await _join(net, A, B, "Δίκτυο 1")
    await _join(net, B, C_, "Δίκτυο 2")
    a_groups = {g["name"] for g in await net["r"][A].groups()}
    assert a_groups == {"Δίκτυο 1"}
    partners = {m["tenant_id"] for g in await net["r"][A].groups() for m in g["members"]}
    assert C_ not in partners
    assert len(await net["r"][B].groups()) == 2, "το Β βλέπει και τα δύο"


async def test_auto_offer_from_known_stock_then_reservation_and_delivery(net):
    from app.repositories.connect import ConnectPolicyRepository
    from app.repositories.pharmacy_catalog import PharmacyCatalogRepository

    g = await _join(net, A, B, "Δίκτυο 1")
    await net["db"]["pharmacy_products"].insert_one(
        {"tenant_id": B, "barcode": BARCODE, "name": "ΔΟΚΙΜΗ", "stock_qty": 100})
    await ConnectPolicyRepository(tenant_id=B).save({"global_pct": 30, "auto_offer": True})

    req = await net["r"][A].create_request(barcode=BARCODE, name="ΔΟΚΙΜΗ", qty=5,
                                           group_ids=[g["id"]])
    assert req["auto_offers"] == 1, "το ράφι που ξέρουμε απαντά μόνο του"

    offer = (await net["r"][A].my_requests())[0]["offers"][0]
    acc = await net["r"][A].accept_offer(offer["id"])
    assert acc["ok"] and acc["qty"] == 5

    cat = PharmacyCatalogRepository(tenant_id=B)
    assert (await cat.find_one({"barcode": BARCODE}))["stock_qty"] == 100, \
        "η κράτηση ΔΕΝ αγγίζει το απόθεμα"
    assert await net["r"][B]._auto_qty(B, BARCODE, g["id"]) == 25, \
        "η κράτηση μειώνει το διαθέσιμο καθολικά"

    assert (await net["r"][B].complete_movement(acc["movement_id"], doc_ref="ΔΑ-1"))["ok"]
    assert (await cat.find_one({"barcode": BARCODE}))["stock_qty"] == 95
    assert await net["db"]["pharmacy_stock_movements"].count_documents({"tenant_id": B}) == 1

    assert (await net["r"][A].balances())[0]["direction"] == "i_owe"
    assert (await net["r"][B].balances())[0]["direction"] == "they_owe"


async def test_partial_fulfilment_and_return_and_settlement(net):
    g = await _join(net, A, B, "Δίκτυο 1")
    req = await net["r"][A].create_request(barcode="8888888888888", name="ΑΛΛΟ", qty=5,
                                           group_ids=[g["id"]])
    assert (await net["r"][B].make_offer(req["id"], 2))["qty"] == 2
    offer = (await net["r"][A].my_requests())[0]["offers"][0]
    acc = await net["r"][A].accept_offer(offer["id"])
    row = (await net["r"][A].my_requests())[0]
    assert row["qty_covered"] == 2 and row["status"] == "open", "2/5 → μένει ανοιχτό"

    assert (await net["r"][B].make_offer(req["id"], 3))["error"] == "already_accepted", \
        "νέα προσφορά δεν γράφει πάνω σε αποδεκτή"

    mov = acc["movement_id"]
    await net["r"][B].complete_movement(mov)
    ret = await net["r"][A].request_return(mov, 1)
    await net["r"][B].respond_return(ret["id"], True)
    await net["r"][A].complete_return(ret["id"])
    assert (await net["r"][A].balances())[0]["qty"] == 1, "επιστροφή 1 από 2 → μένει 1"
    assert (await net["r"][A].settle(mov, qty=1, amount_cents=500))["ok"]
    assert await net["r"][A].balances() == [], "η τακτοποίηση κλείνει το υπόλοιπο"


async def test_reservation_expiry_returns_the_quantity(net):
    g = await _join(net, A, B, "Δίκτυο 1")
    req = await net["r"][A].create_request(barcode="7777777777777", name="Χ", qty=4,
                                           group_ids=[g["id"]])
    await net["r"][B].make_offer(req["id"], 4)
    offer = (await net["r"][A].my_requests())[0]["offers"][0]
    await net["r"][A].accept_offer(offer["id"])
    mod = net["mod"]
    await net["db"][mod.RESERVATIONS].update_many({"status": mod.RES_ACTIVE},
                                                  {"$set": {"expires_at": mod._now()}})
    assert (await mod.expire_reservations())["expired"] >= 1
    row = (await net["r"][A].my_requests())[0]
    assert row["qty_covered"] == 0 and row["status"] == "open"


async def test_outsider_can_neither_see_nor_act(net):
    """Σενάρια 19-20: μη εξουσιοδοτημένο φαρμακείο δεν βλέπει και δεν επεμβαίνει."""
    g = await _join(net, A, B, "Δίκτυο 1")
    req = await net["r"][A].create_request(barcode=BARCODE, name="ΔΟΚΙΜΗ", qty=2,
                                           group_ids=[g["id"]])
    await net["r"][B].make_offer(req["id"], 2)
    offer = (await net["r"][A].my_requests())[0]["offers"][0]

    assert await net["r"][C_].inbox() == []
    assert await net["r"][C_].movements() == []
    assert await net["r"][C_].balances() == []
    assert not (await net["r"][C_].make_offer(req["id"], 1))["ok"]
    assert not (await net["r"][C_].accept_offer(offer["id"]))["ok"]
    assert not (await net["r"][C_].cancel_request(req["id"]))["ok"]
