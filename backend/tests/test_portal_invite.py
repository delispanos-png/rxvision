"""Πρόσκληση πελάτη με email (19/10/2026): εγγραφή από το σπίτι, ΧΩΡΙΣ συνταγές στο φαρμακείο.
Ο πελάτης στην πύλη ΔΕΝ χρειάζεται να έχει εκτελέσεις στο φαρμακείο (κανόνας ιδιοκτήτη)."""

from __future__ import annotations

from types import SimpleNamespace

import app.api.v1.routers.patient_intelligence as pi
import app.api.v1.routers.portal_admin as pa
import app.repositories.patient_portal as pp
import app.services.auth_service as auth_service
from mongomock_motor import AsyncMongoMockClient

TID = "ph-inv"


async def _setup(monkeypatch):
    db = AsyncMongoMockClient()["portal_inv"]
    monkeypatch.setattr(pp, "shared_db", lambda: db)
    monkeypatch.setattr(pa, "shared_db", lambda: db)
    monkeypatch.setattr(pp.vault, "tenant_pepper", lambda tid: "pepper")

    async def modules(tid):
        return {"patient_portal": "enabled"}
    monkeypatch.setattr(auth_service, "resolve_tenant_modules", modules)
    mails: list[tuple] = []

    async def send_email(to, subject, body, **k):
        mails.append((to, subject, body))
    import app.services.mailer as mailer
    monkeypatch.setattr(mailer, "send_email", send_email)
    await db["tenants"].insert_one({"_id": TID, "name": "ΦΑΡΜΑΚΕΙΟ ΔΟΚΙΜΗΣ"})
    return db, mails


def _ctx():
    return SimpleNamespace(tenant_id=TID, user_id="u1", demo=False)


async def test_invite_new_person_without_prescriptions(monkeypatch):
    db, mails = await _setup(monkeypatch)
    r = await pa.invite_customer(pa.InviteIn(email="New@Mail.gr", amka="010101-01234",
                                             last_name="ΔΗΛΗΣ", first_name="ΠΑΝΑΓΙΩΤΗΣ"), _ctx())
    assert r["ok"] and r["email"].endswith("@mail.gr")
    acc = await db["patient_accounts"].find_one({"email": "new@mail.gr"})
    assert acc and acc["amka"] == "01010101234"
    link = await db["patient_links"].find_one({"account_id": acc["_id"], "tenant_id": TID})
    card = await db["patients_anonymized"].find_one({"_id": link["patient_ref"]})
    assert card["rx_count"] == 0 and card["full_name"] == "ΔΗΛΗΣ ΠΑΝΑΓΙΩΤΗΣ"   # καρτέλα χωρίς κίνηση, με όνομα
    to, subject, body = mails[-1]
    assert to == "new@mail.gr" and "ΦΑΡΜΑΚΕΙΟ ΔΟΚΙΜΗΣ" in subject and "set-password?token=" in body


async def test_invite_takes_name_from_existing_card(monkeypatch):
    db, _ = await _setup(monkeypatch)
    await db["patients_anonymized"].insert_one({"tenant_id": TID, "amka": "16106701895",
                                                "full_name": "ΠΑΠΑΓΙΑΝΝΟΠΟΥΛΟΣ ΙΩΑΝΝΗΣ", "rx_count": 9})
    r = await pa.invite_customer(pa.InviteIn(email="a@b.gr", amka="16106701895"), _ctx())
    assert r["ok"]
    acc = await db["patient_accounts"].find_one({"email": "a@b.gr"})
    assert acc["last_name"] == "ΠΑΠΑΓΙΑΝΝΟΠΟΥΛΟΣ" and acc["first_name"] == "ΙΩΑΝΝΗΣ"


async def test_invite_errors_are_specific(monkeypatch):
    db, _ = await _setup(monkeypatch)
    assert (await pa.invite_customer(pa.InviteIn(email="a@b.gr", amka="123"), _ctx()))["error"] == "bad_amka"
    assert (await pa.invite_customer(pa.InviteIn(email="nope", amka="16106701895"), _ctx()))["error"] == "bad_email"
    assert (await pa.invite_customer(pa.InviteIn(email="a@b.gr", amka="16106701895"), _ctx()))["error"] == "name_required"
    await pa.invite_customer(pa.InviteIn(email="a@b.gr", amka="16106701895", last_name="Χ"), _ctx())
    again = await pa.invite_customer(pa.InviteIn(email="c@d.gr", amka="16106701895", last_name="Χ"), _ctx())
    assert again["error"] == "amka_exists"


async def test_profile_status_says_already_registered(monkeypatch):
    db, _ = await _setup(monkeypatch)
    await db["patients_anonymized"].insert_one({"tenant_id": TID, "amka": "16106701895", "full_name": "Χ Ψ"})

    class Repo:
        async def _patient_by_amka(self, amka):
            return await db["patients_anonymized"].find_one({"tenant_id": TID, "amka": amka})
    monkeypatch.setattr(pi, "_repo", lambda ctx: Repo())
    assert (await pi.portal_account_status("16106701895", _ctx())) == {"exists": False}
    await pa.invite_customer(pa.InviteIn(email="gogosmou@yahoo.gr", amka="16106701895"), _ctx())
    st = await pi.portal_account_status("16106701895", _ctx())
    assert st["exists"] and st["linked"] and st["email"].startswith("g") and st["email"].endswith("@yahoo.gr")
