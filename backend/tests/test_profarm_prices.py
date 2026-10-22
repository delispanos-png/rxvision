"""Τιμές από Profarm (20/10/2026, REGAINE): χονδρική = η ΔΙΑΓΡΑΜΜΕΝΗ τιμή της σελίδας προϊόντος (16,07 €),
όχι η τιμολογιακή (15,59 €) ούτε η τιμή της λίστας (15,02 €)· λιανική = η «Προτεινόμενη» (23,00 €) σε κάθε
ενημέρωση, εκτός αν ο φαρμακοποιός έβαλε δική του· ΦΠΑ από τη σελίδα."""

from __future__ import annotations

import app.services.profarm_service as pf
from mongomock_motor import AsyncMongoMockClient

PAGE = """<h1>REGAINE Solution 60ml 5%</h1>
<div>Barcode: <strong>2801960303013, 3574661596914</strong></div>
<div class="rules">Έκπτωση <b>3%</b> από το <b>1ο τεμάχιο</b> (τιμολογιακή πολιτική).</div>
<div class="price_val"> <div class="first_price"><span id="price_notax29891">16,07</span> €</div>
<span class="sale_price" id="sale_price_notax29891">15,59</span> € </div>
<span class="sub_price_label">Συντελεστής ΦΠΑ: </span> <span class="sub_price_value">6%</span> -
<span class="sub_price_label">Αξία με ΦΠΑ: <span class="sub_price_value">16,52 €</span> -
<span class="sub_price_label">Προτεινόμενη Λιανική Τιμή: </span> <span class="sub_price_value">23,00 €</span>"""
# παλιά δομή χωρίς ρητή διαγραμμένη τιμή: μόνο η τιμολογιακή + «Έκπτωση 3% από το 1ο»
OLD = PAGE.replace('<div class="first_price"><span id="price_notax29891">16,07</span> €</div>', "")


def test_detail_gives_struck_wholesale_vat_and_suggested_retail():
    d = pf.parse_product(PAGE)
    assert d["wholesale_cents"] == 1607 and d["vat_rate"] == 6 and d["retail_cents"] == 2300
    assert d["barcodes"] == ["2801960303013", "3574661596914"]


def test_old_layout_derives_struck_price_from_first_unit_discount():
    assert pf.parse_product(OLD)["wholesale_cents"] == 1607


def test_discount_from_third_unit_does_not_touch_unit_price():
    page = OLD.replace("1ο τεμάχιο", "3ο τεμάχιο").replace(">15,59<", ">16,07<")
    assert pf.parse_product(page)["wholesale_cents"] == 1607


class _Resp:
    def __init__(self, text):
        self.text = text


class _Client:
    async def get(self, url):
        return _Resp(PAGE)


class _Repo:
    async def save_image(self, *a):
        return None


async def _col(doc):
    db = AsyncMongoMockClient()["pf_prices"]
    await db["pharmacy_products"].insert_one({"tenant_id": "T", "barcode": "2801960303013", **doc})
    return db["pharmacy_products"]


async def test_existing_item_gets_detail_wholesale_and_suggested_retail_not_list_price():
    col = await _col({"type": "otc_medicine", "source": "hdika", "price_cents": 2149, "wholesale_cents": 1502,
                      "image_id": "img", "profarm_pid": "29891", "profarm_list_price": 1502})
    res, _, _ = await pf._upsert_profarm_product(_Client(), col, _Repo(), "T", "29891", "otc_medicine",
                                                 list_price_cents=1502, force=True)
    p = await col.find_one({"barcode": "2801960303013"})
    assert res == "enriched" and p["wholesale_cents"] == 1607 and p["price_cents"] == 2300 and p["vat_rate"] == 6
    assert p["profarm_retail_cents"] == 2300 and p["profarm_price_checked_at"]


async def test_pharmacists_own_price_is_kept():
    col = await _col({"type": "otc_medicine", "source": "manual", "price_cents": 1999, "wholesale_cents": 1500,
                      "image_id": "img", "profarm_pid": "29891", "profarm_retail_cents": 2200})
    await pf._upsert_profarm_product(_Client(), col, _Repo(), "T", "29891", "otc_medicine", force=True)
    p = await col.find_one({"barcode": "2801960303013"})
    assert p["price_cents"] == 1999 and p["wholesale_cents"] == 1607   # χονδρική ενημερώνεται, λιανική του μένει


async def test_list_price_change_is_only_a_signal():
    col = await _col({"type": "otc_medicine", "price_cents": 2300, "wholesale_cents": 1607, "image_id": "img",
                      "profarm_pid": "29891", "profarm_list_price": 1600,
                      "profarm_synced_at": pf._now()})
    await pf._upsert_profarm_product(_Client(), col, _Repo(), "T", "29891", "otc_medicine",
                                     list_price_cents=1502)
    p = await col.find_one({"barcode": "2801960303013"})
    assert p["wholesale_cents"] == 1607          # η λίστα (15,02) ΔΕΝ γράφεται ως χονδρική


async def test_prescription_medicine_never_takes_supplier_prices():
    """Συνταγογραφούμενα: τιμές ΜΟΝΟ από ΗΔΥΚΑ — ακόμη κι αν δέθηκαν με Profarm για φωτογραφία."""
    col = await _col({"type": "rx_medicine", "source": "hdika", "price_cents": 2149, "wholesale_cents": 1500,
                      "vat_rate": 6, "image_id": "img", "profarm_pid": "29891"})
    await pf._upsert_profarm_product(_Client(), col, _Repo(), "T", "29891", "otc_medicine", force=True)
    p = await col.find_one({"barcode": "2801960303013"})
    assert p["type"] == "rx_medicine" and p["price_cents"] == 2149 and p["wholesale_cents"] == 1500
