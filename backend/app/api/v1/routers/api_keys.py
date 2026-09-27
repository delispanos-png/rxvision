"""Κλειδιά API — πλευρά ΦΑΡΜΑΚΟΠΟΙΟΥ (Ρυθμίσεις → Κλειδιά API).

ΔΙΚΑΙΩΜΑ `settings:write`: η έκδοση κλειδιού είναι παραχώρηση πρόσβασης σε δεδομένα του
φαρμακείου — και, με το `patients:read`, σε **δεδομένα υγείας**. Δεν είναι ενέργεια πάγκου.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.deps import TenantContext, require
from app.services import api_keys

router = APIRouter()


class KeyIn(BaseModel):
    name: str = Field(description="Πώς θα το θυμάσαι — π.χ. «Εμπορικό πρόγραμμα».")
    scopes: list[str] = Field(default_factory=list)
    ttl_days: int = Field(default=api_keys.DEFAULT_TTL_DAYS, ge=1, le=api_keys.MAX_TTL_DAYS)
    ip_allowlist: list[str] = Field(default_factory=list)
    gdpr_ack: bool = False


@router.get("/api-keys")
async def list_keys(ctx: TenantContext = Depends(require("settings:read"))):
    """Τα κλειδιά του φαρμακείου. **Το μυστικό δεν επιστρέφεται ποτέ** — μόνο το πρόθεμα."""
    return {"items": await api_keys.list_for(ctx.tenant_id),
            "scopes": api_keys.SCOPES,
            "sensitive": sorted(api_keys.SENSITIVE_SCOPES),
            "max_ttl_days": api_keys.MAX_TTL_DAYS}


@router.post("/api-keys", status_code=status.HTTP_201_CREATED)
async def create_key(body: KeyIn, ctx: TenantContext = Depends(require("settings:write"))):
    """Εκδίδει κλειδί. Το **πλήρες** κλειδί επιστρέφεται ΜΟΝΟ εδώ, μία φορά."""
    if not body.scopes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={
            "error": "no_scopes",
            "message": "Διάλεξε τουλάχιστον ένα δικαίωμα.",
            "hint": "Δώσε τα λιγότερα δυνατά — αν το πρόγραμμα ενημερώνει μόνο απόθεμα, "
                    "αρκούν τα «Ανάγνωση αποθέματος» και «Ενημέρωση αποθέματος»."})
    try:
        return await api_keys.create(
            ctx.tenant_id, name=body.name, scopes=body.scopes, by=ctx.user_id,
            ttl_days=body.ttl_days, ip_allowlist=body.ip_allowlist, gdpr_ack=body.gdpr_ack)
    except ValueError as e:
        msg = str(e)
        if msg == "gdpr_ack_required":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={
                "error": "gdpr_ack_required",
                "message": "Το δικαίωμα «Ανάγνωση ασθενών» δίνει πρόσβαση σε δεδομένα υγείας.",
                "hint": "Πρέπει να το επιβεβαιώσεις ρητά. Είσαι ο υπεύθυνος επεξεργασίας — "
                        "δώσ' το μόνο σε συνεργάτη με τον οποίο έχεις γραπτή συμφωνία."}) from e
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={
            "error": "bad_scope", "message": f"Άγνωστο δικαίωμα: {msg}", "hint": None}) from e


@router.delete("/api-keys/{key_id}")
async def revoke_key(key_id: str, ctx: TenantContext = Depends(require("settings:write"))):
    """Ανακαλεί κλειδί **αμέσως**. Η επόμενη κλήση του συνεργάτη παίρνει 401."""
    if not await api_keys.revoke(ctx.tenant_id, key_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={
            "error": "not_found", "message": "Το κλειδί δεν βρέθηκε ή έχει ήδη ανακληθεί.",
            "hint": None})
    return {"ok": True, "message": "Το κλειδί ανακλήθηκε. Ισχύει αμέσως."}
