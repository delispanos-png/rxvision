"""Billing receipts (παραστατικά) — a unified list of everything charged through RxVision for one
tenant: subscription renewals, plan upgrades, and message-credit top-ups.

* Subscription/upgrade charges are written to the ``payments`` collection at the moment they occur
  (``record()`` below, called from billing_service.bill_due and plan_change_service.apply_change).
* Message-credit top-ups are read from the existing ``message_ledger`` (kind=credit, channel=topup)
  so historical top-ups already show without any backfill.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db

_KIND_LABEL = {
    "subscription": {"el": "Συνδρομή", "en": "Subscription"},
    "upgrade": {"el": "Αναβάθμιση πλάνου", "en": "Plan upgrade"},
    "addon": {"el": "Πρόσθετο", "en": "Add-on"},
    "topup": {"el": "Αγορά credits μηνυμάτων", "en": "Message credits top-up"},
}


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


async def record(tenant_id: str, kind: str, description: str, amount_cents: int, *,
                 status: str = "paid", method: str | None = None, provider: str | None = None,
                 provider_order_id: str | None = None, meta: dict | None = None) -> None:
    """Write a payment record (best-effort — never breaks the charge that triggered it)."""
    try:
        await shared_db()["payments"].insert_one({
            "tenant_id": tenant_id, "kind": kind, "description": description,
            "amount_cents": int(amount_cents or 0), "status": status, "method": method,
            "provider": provider, "provider_order_id": provider_order_id,
            "meta": meta or {}, "created_at": datetime.now(tz=timezone.utc)})
    except Exception:  # noqa: BLE001
        pass


async def list_for_tenant(tenant_id: str, limit: int = 100) -> list[dict]:
    db = shared_db()
    out: list[dict] = []
    async for p in db["payments"].find({"tenant_id": tenant_id}).sort("created_at", -1).limit(limit):
        k = p.get("kind", "subscription")
        out.append({
            "id": str(p["_id"]), "kind": k, "kind_label": _KIND_LABEL.get(k, {"el": k, "en": k}),
            "description": p.get("description"), "amount_cents": int(p.get("amount_cents", 0) or 0),
            "status": p.get("status", "paid"), "method": p.get("method"), "provider": p.get("provider"),
            "created_at": _iso(p.get("created_at"))})
    # message-credit top-ups from the wallet ledger (paid credits only, channel=="topup")
    async for l in db["message_ledger"].find(
            {"tenant_id": tenant_id, "kind": "credit", "channel": "topup"}).sort("ts", -1).limit(limit):
        out.append({
            "id": f"topup:{l.get('_id')}", "kind": "topup", "kind_label": _KIND_LABEL["topup"],
            "description": _KIND_LABEL["topup"]["el"], "amount_cents": int(l.get("amount_cents", 0) or 0),
            "status": "paid", "method": None, "provider": "revolut", "created_at": _iso(l.get("ts"))})
    out.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return out[:limit]
