"""Στοχευμένη Προώθηση (Marketing) — ανεξάρτητο εμπορικό κύκλωμα του φαρμακείου.

Καρδιά: ένα dashboard με (α) ΑΠΟΔΟΤΙΚΟΤΗΤΑ (τι έστειλες, σε πόσους, ανά κανάλι) και (β) ΠΡΟΤΑΣΕΙΣ
ΕΝΕΡΓΕΙΩΝ — έτοιμες στοχευμένες καμπάνιες ανά θεραπευτική κατηγορία / segment, με ένα κλικ.

Πατάει σε υπάρχοντα: Patient Intelligence (θεραπευτικές κατηγορίες/winback/risk), comms (campaigns +
consent + wallet), push_service (δωρεάν κανάλι), future_prescriptions (επερχόμενες επαναλήψεις).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

# Θεραπευτικές κατηγορίες ανά ATC prefix (επεκτεταμένες σε σχέση με το Patient Intelligence).
THERAPY_CATEGORIES = [
    {"key": "diabetes", "label": "Διαβήτης", "atc": ["A10"], "icon": "🩸",
     "offer": "ταινίες μέτρησης, βελόνες, συμπληρώματα"},
    {"key": "hypertension", "label": "Υπέρταση", "atc": ["C03", "C07", "C08", "C09"], "icon": "❤️",
     "offer": "πιεσόμετρο, έλεγχος πίεσης, ω-3"},
    {"key": "cardio", "label": "Καρδιολογικά", "atc": ["C01", "B01"], "icon": "🫀",
     "offer": "συνέπεια αγωγής, ω-3, έλεγχος"},
    {"key": "cholesterol", "label": "Χοληστερίνη", "atc": ["C10"], "icon": "🧈",
     "offer": "ω-3, διατροφικά, έλεγχος λιπιδίων"},
    {"key": "thyroid", "label": "Θυρεοειδής", "atc": ["H03"], "icon": "🦋",
     "offer": "σελήνιο, έλεγχος, συνέπεια"},
    {"key": "respiratory", "label": "Αναπνευστικά", "atc": ["R03"], "icon": "🫁",
     "offer": "spacer, αντιγριπικά, βιταμίνες"},
    {"key": "allergy", "label": "Αλλεργίες", "atc": ["R06", "R01"], "icon": "🤧",
     "offer": "αντιισταμινικά, ρινικά sprays (εποχικά)"},
    {"key": "psych", "label": "Νευρο/Ψυχ.", "atc": ["N05", "N06"], "icon": "🧠",
     "offer": "συνέπεια, ύπνος, μαγνήσιο"},
    {"key": "osteo", "label": "Οστεοπόρωση", "atc": ["M05"], "icon": "🦴",
     "offer": "ασβέστιο, βιταμίνη D"},
    {"key": "gastro", "label": "Γαστρεντερικά", "atc": ["A02", "A03"], "icon": "🩹",
     "offer": "προβιοτικά, διατροφικές οδηγίες"},
]
THERAPY_ATC = {c["key"]: c["atc"] for c in THERAPY_CATEGORIES}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def category_sizes(tenant_id: str) -> list[dict]:
    """Πλήθος & αξία ασθενών ανά θεραπευτική κατηγορία (τελευταία εκτέλεση ATC). ΜΙΑ aggregation:
    executions → items → products.atc → group ανά ασθενή με το σετ των ATC prefixes → μέτρηση ανά κατηγορία."""
    db = shared_db()
    rows = await db["prescription_executions"].aggregate([
        {"$match": {"tenant_id": tenant_id, "status": {"$ne": "cancelled"}}},
        {"$lookup": {"from": "prescription_items", "localField": "_id",
                     "foreignField": "execution_id", "as": "it"}},
        {"$unwind": "$it"},
        {"$lookup": {"from": "products", "localField": "it.product_id", "foreignField": "_id", "as": "p"}},
        {"$set": {"atc": {"$toUpper": {"$ifNull": [{"$first": "$p.atc"}, ""]}}}},
        {"$match": {"atc": {"$ne": ""}}},
        {"$group": {"_id": {"pt": "$patient_ref", "atc4": {"$substrBytes": ["$atc", 0, 4]}},
                    "value": {"$sum": "$amount_total"}}},
    ], allowDiskUse=True).to_list(length=None)
    # ATC4 → κατηγορία (ταιριάζει με το πιο μακρύ prefix)
    out = {c["key"]: {"key": c["key"], "label": c["label"], "icon": c["icon"], "offer": c["offer"],
                      "patients": set(), "value": 0} for c in THERAPY_CATEGORIES}
    for r in rows:
        atc4 = r["_id"]["atc4"]
        for c in THERAPY_CATEGORIES:
            if any(atc4.startswith(pref) for pref in c["atc"]):
                out[c["key"]]["patients"].add(r["_id"]["pt"])
                out[c["key"]]["value"] += r["value"]
                break
    res = [{**v, "patients": len(v["patients"]), "value": round(v["value"])} for v in out.values()]
    res.sort(key=lambda x: x["patients"], reverse=True)
    return res


async def _campaign_performance(tenant_id: str, days: int = 30) -> dict:
    db = shared_db()
    cutoff = _now() - timedelta(days=days)
    rows = await db["comms_campaigns"].aggregate([
        {"$match": {"tenant_id": tenant_id, "created_at": {"$gte": cutoff}}},
        {"$group": {"_id": "$channel", "campaigns": {"$sum": 1},
                    "recipients": {"$sum": "$recipients"}, "sent": {"$sum": "$sent"},
                    "failed": {"$sum": "$failed"}}},
    ]).to_list(length=None)
    by_channel = {r["_id"]: {"campaigns": r["campaigns"], "recipients": r["recipients"],
                             "sent": r["sent"], "failed": r["failed"]} for r in rows}
    tot = {"campaigns": sum(r["campaigns"] for r in rows), "recipients": sum(r["recipients"] for r in rows),
           "sent": sum(r["sent"] for r in rows), "failed": sum(r["failed"] for r in rows)}
    return {"days": days, "total": tot, "by_channel": by_channel}


async def dashboard(tenant_id: str, *, demo: bool = False) -> dict:
    """Το βασικό dashboard του κυκλώματος: αποδοτικότητα + προτάσεις στοχευμένων ενεργειών."""
    from app.repositories.patient_intelligence import PatientIntelligenceRepository
    db = shared_db()
    pi = PatientIntelligenceRepository(tenant_id=tenant_id, demo=demo)

    perf = await _campaign_performance(tenant_id)
    cats = await category_sizes(tenant_id)

    # winback (ανενεργοί) + at-risk (συμμόρφωση) + upcoming (επερχόμενη επανάληψη) — για προτάσεις
    async def _safe(coro, default):
        try:
            return await coro
        except Exception:  # noqa: BLE001
            return default
    wb = await _safe(pi.winback(), {})
    risk = await _safe(pi.risk(), {})
    winback_n = len(wb.get("items", []) or []) if isinstance(wb, dict) else 0
    risk_n = len(risk.get("items", []) or []) if isinstance(risk, dict) else 0
    horizon = _now() + timedelta(days=30)
    upcoming_n = len(await db["future_prescriptions"].distinct(
        "patient_ref", {"tenant_id": tenant_id, "status": "pending",
                        "expected_open_date": {"$gte": _now(), "$lt": horizon}}))

    # ── ΠΡΟΤΑΣΕΙΣ ΕΝΕΡΓΕΙΩΝ (action cards) — κάθε μία ανοίγει καμπάνια με προ-επιλεγμένο κοινό ──
    cards: list[dict] = []
    if upcoming_n:
        cards.append({"id": "refill", "icon": "⏰", "urgency": "high",
                      "title": f"{upcoming_n} ασθενείς με επερχόμενη επανάληψη",
                      "why": "Θύμισέ τους πριν τους τελειώσει η αγωγή — καλύτερη συμμόρφωση & σίγουρη πώληση.",
                      "count": upcoming_n, "cta": "Υπενθύμιση επανάληψης",
                      "segment": "upcoming", "value": "30"})
    for c in cats[:4]:
        if c["patients"] >= 3:
            cards.append({"id": f"cat:{c['key']}", "icon": c["icon"], "urgency": "medium",
                          "title": f"{c['patients']} ασθενείς — {c['label']}",
                          "why": f"Στοχευμένη προσφορά: {c['offer']}.",
                          "count": c["patients"], "cta": "Στοχευμένη προσφορά",
                          "segment": "therapy", "value": c["key"]})
    if winback_n:
        cards.append({"id": "winback", "icon": "🔄", "urgency": "medium",
                      "title": f"{winback_n} ανενεργοί πελάτες",
                      "why": "Χάθηκαν — φέρ' τους πίσω με μια προσφορά win-back.",
                      "count": winback_n, "cta": "Καμπάνια win-back",
                      "segment": "inactive", "value": "180"})
    push_reach = await db["patient_push_subs"].estimated_document_count()

    return {
        "performance": perf,
        "categories": cats,
        "suggestions": cards,
        "campaigns": await campaigns_with_roi(tenant_id),
        "totals": {"upcoming": upcoming_n, "winback": winback_n, "at_risk": risk_n,
                   "push_reach": int(push_reach)},
        "generated_at": _now().isoformat(),
    }


# ── Κουπόνια ανά καμπάνια + μέτρηση απόδοσης (κλείσιμο κύκλου: στάλθηκε → εξαργυρώθηκε → αξία) ──────
import secrets  # noqa: E402


def _gen_code() -> str:
    return "RX" + secrets.token_hex(3).upper()   # π.χ. RX3F9A1C


async def create_coupon(tenant_id: str, *, campaign_id: str, discount_type: str = "pct",
                        discount_value: int = 0, valid_days: int = 30,
                        max_redemptions: int = 0) -> dict:
    """Κουπόνι συνδεδεμένο με καμπάνια. discount_type: 'pct' (%) ή 'fixed' (cents). max_redemptions=0 = χωρίς όριο."""
    db = shared_db()
    code = _gen_code()
    for _ in range(5):                                   # σπάνιο collision → ξαναδοκίμασε
        if not await db["campaign_coupons"].find_one({"_id": code}):
            break
        code = _gen_code()
    doc = {
        "_id": code, "tenant_id": tenant_id, "campaign_id": campaign_id,
        "discount_type": "fixed" if discount_type == "fixed" else "pct",
        "discount_value": max(0, int(discount_value)),
        "valid_until": _now() + timedelta(days=max(1, int(valid_days))),
        "max_redemptions": max(0, int(max_redemptions)),
        "redemptions": 0, "redeemed_value_cents": 0, "status": "active", "created_at": _now(),
    }
    await db["campaign_coupons"].insert_one(doc)
    return {"code": code, "discount_type": doc["discount_type"], "discount_value": doc["discount_value"],
            "valid_until": doc["valid_until"].isoformat()}


async def redeem_coupon(tenant_id: str, code: str, *, amount_cents: int = 0, by: str | None = None) -> dict:
    """Εξαργύρωση στο ταμείο (ή e-shop): επιβεβαιώνει ισχύ, αυξάνει μετρητές, καταγράφει το event & αξία."""
    db = shared_db()
    code = (code or "").strip().upper()
    c = await db["campaign_coupons"].find_one({"_id": code, "tenant_id": tenant_id})
    if not c:
        return {"ok": False, "error": "not_found"}
    if c.get("status") != "active":
        return {"ok": False, "error": "inactive"}
    if c.get("valid_until") and c["valid_until"] < _now():
        return {"ok": False, "error": "expired"}
    if c.get("max_redemptions") and c.get("redemptions", 0) >= c["max_redemptions"]:
        return {"ok": False, "error": "max_reached"}
    # υπολογισμός έκπτωσης (ενημερωτικά για το ταμείο)
    amt = max(0, int(amount_cents or 0))
    disc = round(amt * c["discount_value"] / 100) if c["discount_type"] == "pct" else min(amt, c["discount_value"])
    upd = await db["campaign_coupons"].find_one_and_update(
        {"_id": code, "tenant_id": tenant_id,
         **({"redemptions": {"$lt": c["max_redemptions"]}} if c.get("max_redemptions") else {})},
        {"$inc": {"redemptions": 1, "redeemed_value_cents": amt}, "$set": {"updated_at": _now()}})
    if not upd:
        return {"ok": False, "error": "max_reached"}
    await db["coupon_redemptions"].insert_one({
        "code": code, "tenant_id": tenant_id, "campaign_id": c.get("campaign_id"),
        "amount_cents": amt, "discount_cents": disc, "by": by, "at": _now()})
    return {"ok": True, "code": code, "discount_type": c["discount_type"],
            "discount_value": c["discount_value"], "discount_cents": disc, "amount_cents": amt}


async def campaigns_with_roi(tenant_id: str, days: int = 90, limit: int = 60) -> list[dict]:
    """Λίστα καμπανιών με απόδοση: στάλθηκε → εξαργυρώθηκε → αξία (conversion %). Join με τα κουπόνια."""
    db = shared_db()
    cutoff = _now() - timedelta(days=days)
    coupons = {c["campaign_id"]: c async for c in db["campaign_coupons"].find({"tenant_id": tenant_id})}
    out = []
    async for c in db["comms_campaigns"].find(
            {"tenant_id": tenant_id, "created_at": {"$gte": cutoff}}).sort("created_at", -1).limit(limit):
        cid = str(c["_id"])
        cp = coupons.get(cid)
        sent = int(c.get("sent", 0) or 0)
        red = int(cp.get("redemptions", 0)) if cp else 0
        out.append({
            "id": cid, "channel": c.get("channel"), "subject": c.get("subject"),
            "recipients": int(c.get("recipients", 0) or 0), "sent": sent,
            "created_at": c.get("created_at").isoformat() if c.get("created_at") else None,
            "coupon": cp["_id"] if cp else None,
            "redemptions": red,
            "redeemed_value_cents": int(cp.get("redeemed_value_cents", 0)) if cp else 0,
            "conversion_pct": round(red / sent * 100, 1) if sent else 0.0,
        })
    return out


# ── Ρυθμίσεις κυκλώματος (anti-fatigue frequency cap) ─────────────────────────
async def get_settings(tenant_id: str) -> dict:
    t = await shared_db()["tenants"].find_one({"_id": tenant_id}, {"marketing_frequency_cap": 1})
    return {"frequency_cap": int((t or {}).get("marketing_frequency_cap") or 0)}


async def set_settings(tenant_id: str, *, frequency_cap: int) -> dict:
    cap = max(0, min(int(frequency_cap), 60))
    await shared_db()["tenants"].update_one(
        {"_id": tenant_id}, {"$set": {"marketing_frequency_cap": cap, "updated_at": _now()}})
    return {"ok": True, "frequency_cap": cap}
