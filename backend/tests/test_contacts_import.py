"""Εισαγωγή στοιχείων επικοινωνίας από το εμπορικό πρόγραμμα (mongomock-motor, χωρίς prod).

Κλειδώνει: ταίριασμα ΑΜΚΑ → αλλιώς ΜΟΝΑΔΙΚΟ όνομα· ΑΜΚΑ που δεν βρέθηκε δεν πέφτει σε όνομα·
ποτέ πάνω σε στοιχεία που επιβεβαίωσε άνθρωπος· αντικατάσταση ΗΔΥΚΑ μόνο με overwrite· καμία
συγκατάθεση/επιβεβαίωση· θανόντες εκτός· dry_run δεν γράφει και δίνει ΙΔΙΑ νούμερα με την εφαρμογή."""

from __future__ import annotations

import app.repositories.base as base_mod
from app.repositories.contacts import PatientContactRepository
from app.services.contacts_import import (
    looks_like_header,
    name_key,
    norm_amka,
    row_to_record,
    split_phones,
    suggest_mapping,
)
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

T = "tenant-imp"
MAP = {"amka": 0, "full_name": 1, "phone": 2, "email": 3}


def _wire(monkeypatch):
    db = AsyncMongoMockClient()["rxvision_import_test"]
    monkeypatch.setattr(base_mod.db_resolver, "resolve", lambda **_: db)

    # το mongomock δεν δέχεται UpdateOne της τρέχουσας pymongo στο bulk_write → εφαρμογή μία-μία
    async def bulk_write(self, ops, ordered=True):
        for op in ops:
            await self.update_one(op._filter, op._doc, upsert=bool(op._upsert))
    monkeypatch.setattr(type(db["patient_contacts"]), "bulk_write", bulk_write)
    return db


async def _patient(db, amka, name, tenant=T, **kw):
    oid = ObjectId()
    await db["patients_anonymized"].insert_one(
        {"_id": oid, "tenant_id": tenant, "amka": amka, "full_name": name, **kw})
    return oid


def _recs(rows):
    out = []
    for n, r in enumerate(rows, start=1):
        rec = row_to_record(r, MAP)
        rec["row"] = n
        out.append(rec)
    return out


# ── καθαρές συναρτήσεις ──
def test_amka_survives_excel_number_forms():
    assert norm_amka("01018012345") == "01018012345"
    assert norm_amka("1018012345") == "01018012345"          # χαμένο αρχικό μηδενικό
    assert norm_amka("1018012345.0") == "01018012345"
    assert norm_amka("1.018012345E9") == "01018012345"
    assert norm_amka("abc") == ""


def test_phone_kind_from_prefix_not_column():
    assert split_phones("+30 697 123 4567") == (["6971234567"], [], 0)
    assert split_phones("210 1234567 / 6971234567") == (["6971234567"], ["2101234567"], 0)
    assert split_phones("00302101234567") == ([], ["2101234567"], 0)
    assert split_phones("12345") == ([], [], 1)
    rec = row_to_record(["", "Α Β", "6971234567", ""], MAP)   # κινητό στη στήλη «Τηλέφωνο»
    assert rec["fields"] == {"mobile": "6971234567"}


def test_name_key_ignores_order_accents_case():
    assert name_key("Γεώργιος Παπαδόπουλος") == name_key("ΠΑΠΑΔΟΠΟΥΛΟΣ  ΓΕΩΡΓΙΟΣ")
    assert name_key("ΠΑΠΑΔΟΠΟΥΛΟΣ") == ""                     # μόνο επώνυμο = ασαφές


def test_split_name_columns_and_header_suggestion():
    head = ["Επώνυμο", "Όνομα", "Κινητό", "E-mail"]
    assert looks_like_header(head)
    m = suggest_mapping(head)
    assert m == {"last_name": 0, "first_name": 1, "mobile": 2, "email": 3}
    assert row_to_record(["Παπαδόπουλος", "Γιώργος", "", ""], m)["name"] == "Παπαδόπουλος Γιώργος"
    assert not looks_like_header(["01018012345", "Α Β", "6971234567"])


# ── ταίριασμα & συγχώνευση ──
async def test_match_rules(monkeypatch):
    db = _wire(monkeypatch)
    a = await _patient(db, "01018012345", "ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΕΩΡΓΙΟΣ")
    b = await _patient(db, "02028012345", "ΝΙΚΟΛΑΟΥ ΜΑΡΙΑ")
    await _patient(db, "03038012345", "ΙΩΑΝΝΟΥ ΕΛΕΝΗ")
    await _patient(db, "04048012345", "ΙΩΑΝΝΟΥ ΕΛΕΝΗ")        # συνωνυμία
    await _patient(db, "05058012345", "ΚΩΣΤΑ ΑΝΝΑ", deceased=True)
    other = await _patient(db, "06068012345", "ΑΛΛΟΣ ΤΕΝΑΝΤ", tenant="tenant-x")
    recs = _recs([
        ["1018012345", "", "6971111111", ""],                   # ΑΜΚΑ (Excel έκοψε το 0)
        ["", "Μαρία Νικολάου", "6972222222", ""],               # μοναδικό όνομα
        ["", "Ελένη Ιωάννου", "6973333333", ""],                # συνωνυμία → αμφίσημο
        ["09098012345", "Γεώργιος Παπαδόπουλος", "6974444444", ""],  # άγνωστος ΑΜΚΑ ≠ όνομα
        ["05058012345", "", "6975555555", ""],                  # θανών
        ["06068012345", "", "6976666666", ""],                  # άλλο φαρμακείο
    ])
    res = await PatientContactRepository(tenant_id=T).import_contacts(recs, dry_run=False)
    assert (res["by_amka"], res["by_name"], res["ambiguous"], res["not_found"], res["deceased"]) == \
        (2, 1, 1, 2, 1)
    assert res["patients_updated"] == 2
    assert (await db["patient_contacts"].find_one({"_id": a}))["mobile"] == "6971111111"
    assert (await db["patient_contacts"].find_one({"_id": b}))["mobile"] == "6972222222"
    assert await db["patient_contacts"].count_documents({}) == 2
    assert await db["patient_contacts"].find_one({"_id": other}) is None


async def test_merge_never_overrides_human_and_grants_nothing(monkeypatch):
    db = _wire(monkeypatch)
    h = await _patient(db, "01018012345", "Α Α")
    i = await _patient(db, "02028012345", "Β Β")
    await db["patient_contacts"].insert_many([
        {"_id": h, "tenant_id": T, "mobile": "6970000000", "contact_source": "patient",
         "contact_verified": True},
        {"_id": i, "tenant_id": T, "mobile": "6970000001", "contact_source": "idyka"}])
    recs = _recs([["01018012345", "", "6979999999", "a@b.gr"],
                  ["02028012345", "", "6978888888", "x@y.gr"]])
    repo = PatientContactRepository(tenant_id=T)

    keep = await repo.import_contacts(recs, overwrite=False, dry_run=True)
    assert keep["fields"]["mobile"]["protected"] == 1 and keep["fields"]["mobile"]["kept"] == 1
    assert (await db["patient_contacts"].find_one({"_id": i}))["mobile"] == "6970000001"  # dry_run

    done = await repo.import_contacts(recs, overwrite=True, dry_run=False)
    assert done["fields"]["mobile"]["overwritten"] == 1 and done["fields"]["mobile"]["protected"] == 1
    hd = await db["patient_contacts"].find_one({"_id": h})
    idd = await db["patient_contacts"].find_one({"_id": i})
    assert hd["mobile"] == "6970000000" and hd["email"] == "a@b.gr"     # κενό γεμίζει, το ίδιο όχι
    assert hd["contact_source"] == "patient" and hd["contact_verified"] is True
    assert idd["mobile"] == "6978888888" and idd["contact_source"] == "pharmacy_system"
    for d in (hd, idd):
        assert "marketing_consent" not in d
    assert "contact_verified" not in idd


async def test_dry_run_equals_apply(monkeypatch):
    db = _wire(monkeypatch)
    await _patient(db, "01018012345", "Α Α")
    recs = _recs([["01018012345", "", "6971234567 / 2101234567", "bad"]])
    repo = PatientContactRepository(tenant_id=T)
    dry = await repo.import_contacts(recs, dry_run=True)
    real = await repo.import_contacts(recs, dry_run=False)
    for k in ("matched", "patients_updated", "fields"):
        assert dry[k] == real[k]
    assert real["fields"]["email"]["invalid"] == 1
    again = await repo.import_contacts(recs, dry_run=True)            # ξανά = τίποτα νέο
    assert again["patients_updated"] == 0 and again["fields"]["mobile"]["same"] == 1
