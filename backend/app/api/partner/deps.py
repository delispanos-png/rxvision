"""Ταυτοποίηση συνεργάτη — `X-API-Key` και έλεγχος δικαιωμάτων.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΑ ΑΠΟ ΤΟ `core/deps.py`: το εσωτερικό API ταυτοποιεί ΑΝΘΡΩΠΟ με JWT που λήγει
σε 15΄. Το API συνεργατών ταυτοποιεί ΠΡΟΓΡΑΜΜΑ με κλειδί που ζει μήνες. Διαφορετική απειλή,
διαφορετικοί κανόνες — να μη μπερδευτούν ποτέ οι δύο ταυτότητες.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import APIKeyHeader

from app.core.db import shared_db
from app.services import api_keys

API_KEY_HEADER = APIKeyHeader(
    name="X-API-Key", auto_error=False,
    description="Your key, exactly as given to you. Starts with `rxv_live_`.",
)


@dataclass
class PartnerContext:
    """Ποιος καλεί, για ποιο φαρμακείο, και τι του επιτρέπεται."""
    tenant_id: str
    key_id: str
    key_name: str
    scopes: list[str] = field(default_factory=list)

    def allows(self, scope: str) -> bool:
        return scope in self.scopes


async def get_partner(request: Request,
                      raw: str | None = Depends(API_KEY_HEADER)) -> PartnerContext:
    if not raw:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail={"error": "missing_api_key",
                    "message": "The X-API-Key header is missing.",
                    "hint": "Send your key in the `X-API-Key` header."})
    ip = request.headers.get("X-Real-Client-IP") or (request.client.host if request.client else None)
    doc, why = await api_keys.verify(raw, ip=ip)
    if not doc:
        # Το μήνυμα λέει ΤΙ φταίει. Ένα σκέτο «άκυρο κλειδί» στέλνει τον προγραμματιστή να
        # ψάχνει για ώρες κάτι που του λύνεται σε μια πρόταση.
        detail = {
            "malformed": ("invalid_api_key", "The key is not in the expected format.",
                          "Keys start with `rxv_live_`. Check you copied it whole, with no "
                          "spaces or line breaks."),
            "unknown": ("invalid_api_key", "The key is not recognised.",
                        "It may belong to a different environment, or be mistyped. Ask the "
                        "pharmacy for a new one."),
            "revoked": ("key_revoked", "This key has been revoked.",
                        "The pharmacist disabled it. You need a new key."),
            "expired": ("key_expired", "This key has expired.",
                        "Keys expire for security. Ask the pharmacy to issue a new one — it "
                        "takes seconds."),
            "ip_blocked": ("ip_not_allowed", "Your IP address is not allowed for this key.",
                           "The key is restricted to specific addresses. Give the pharmacy the "
                           "address you are calling from so they can add it."),
        }.get(why, ("invalid_api_key", "The key is not valid.", None))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            detail={"error": detail[0], "message": detail[1], "hint": detail[2]})
    # ΛΗΓΜΕΝΗ ΣΥΝΔΡΟΜΗ → ΝΕΚΡΟ API.
    # Ίδια πηγή αλήθειας με όλη την εφαρμογή (`billing_service.effective_status`): η ΠΕΡΙΟΔΟΣ
    # αποφασίζει, όχι ξεχασμένο status. Το `past_due` ΔΕΝ κόβει — είναι περιθώριο πληρωμής, και
    # το ίδιο ισχύει και στον συγχρονισμό ΗΔΥΚΑ· δεν θα έκοβε νόημα να σταματά το API πριν
    # σταματήσουν τα δεδομένα. Ο έλεγχος γίνεται σε ΚΑΘΕ κλήση: μια συνδρομή που λήγει στη μέση
    # της ημέρας πρέπει να κόβει αμέσως, όχι στην επόμενη έκδοση κλειδιού.
    from app.services.billing_service import effective_status
    sub = await shared_db()["subscriptions"].find_one({"tenant_id": doc["tenant_id"]})
    state = effective_status(sub)
    if state in ("expired", "suspended", "cancelled", "none"):
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            detail={"error": "subscription_inactive",
                    "subscription_status": state,
                    "message": "The pharmacy's subscription is not active, so the API is not "
                               "serving requests.",
                    "hint": "Your key is fine — the issue is the pharmacy's subscription. Let "
                            "them know; the moment they renew, the API works again immediately "
                            "and no new key is needed."})

    ctx = PartnerContext(tenant_id=str(doc["tenant_id"]), key_id=str(doc["_id"]),
                         key_name=doc.get("name") or "", scopes=list(doc.get("scopes") or []))
    request.state.partner = ctx
    await api_keys.touch(doc["_id"], ip)
    return ctx


def require_scope(scope: str):
    """Φρουρός δικαιώματος. Το μήνυμα λέει ΤΙ λείπει και ΠΩΣ διορθώνεται."""
    async def _dep(ctx: PartnerContext = Depends(get_partner)) -> PartnerContext:
        if not ctx.allows(scope):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={"error": "missing_scope", "required": scope,
                        "granted": ctx.scopes,
                        "message": f"Your key does not have the scope “{scope}”.",
                        "hint": "Ask the pharmacy to issue a key with this scope "
                                "(Settings → API keys). Scopes cannot be added to an existing "
                                "key — a new one is issued."})
        return ctx
    return _dep


def require_module(*modules: str):
    """Φρουρός ΔΥΝΑΤΟΤΗΤΑΣ (module), πέρα από το δικαίωμα (scope).

    ΓΙΑΤΙ ΧΩΡΙΣΤΑ ΑΠΟ ΤΟ scope: το scope λέει «τι επιτρέπει ο φαρμακοποιός σε ΑΥΤΟ το κλειδί».
    Το module λέει «τι έχει αγοράσει το φαρμακείο». Ένα κλειδί με `loyalty:write` σε φαρμακείο
    που δεν έχει το πρόγραμμα επιβράβευσης ΔΕΝ πρέπει να δουλεύει — αλλιώς το API γίνεται πίσω
    πόρτα που δίνει δωρεάν ό,τι πουλάμε από την μπροστινή.

    Αρκεί ΕΝΑ από τα `modules` να είναι ενεργό (ή σε δοκιμή) — ίδια λογική με το εσωτερικό
    `require(module=[...])`.
    """
    async def _dep(ctx: PartnerContext = Depends(get_partner)) -> PartnerContext:
        from app.services.auth_service import resolve_tenant_modules
        active = await resolve_tenant_modules(ctx.tenant_id)
        if not any(active.get(m) in ("enabled", "trial") for m in modules):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={"error": "module_not_enabled", "required_any": list(modules),
                        "message": "The pharmacy has not enabled the feature this endpoint "
                                   "belongs to.",
                        "hint": "This is not a key problem — the pharmacy needs the feature on "
                                "their plan. They can add it themselves in Settings → Billing, "
                                "and most features offer a free trial."})
        return ctx
    return _dep


def require(scope: str, *modules: str):
    """Δικαίωμα ΚΑΙ δυνατότητα σε έναν φρουρό — ένα `Depends` ανά endpoint."""
    async def _dep(ctx: PartnerContext = Depends(require_scope(scope))) -> PartnerContext:
        if modules:
            await require_module(*modules)(ctx)
        return ctx
    return _dep
