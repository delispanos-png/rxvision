"""Ημερολόγιο χρεώσεων (`payments`) — εσωτερική καταγραφή κάθε χρέωσης τη στιγμή που γίνεται.

Ο ΠΕΛΑΤΗΣ ΔΕΝ βλέπει αυτή τη λίστα: τα «Παραστατικά αγορών» του διαβάζουν τα ίδια τα παραστατικά
(`invoice_service.list_for_tenant`, ίδια πηγή με το adminpanel — 02/10/2026).
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.core.db import shared_db


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
