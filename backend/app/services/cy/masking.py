"""RxVision Κύπρος: «Λειτουργία παρουσίασης» (tenant.demo) — απόκρυψη ΠΡΟΣΩΠΩΝ σε ΚΑΘΕ απάντηση του /cy.

Δεν βασιζόμαστε σε κάθε endpoint να «θυμηθεί» το demo: το `CyMaskedRoute` (route_class του router /cy)
περνά ΚΑΘΕ JSON απάντηση από το `mask_tree` όταν ο χρήστης είναι σε παρουσίαση. Ένα νέο endpoint
καλύπτεται αυτόματα.

Ίδιο ύφος με την Ελλάδα (`utils/masking.py`): επίθετο → «Π****», μικρό όνομα ορατό· κωδικός ΟΑΥ, κινητό,
email, τηλέφωνα → «****». Το σκέτο κλειδί `name` είναι ΣΥΝΗΘΩΣ φάρμακο/είδος στην Κύπρο, άρα κρύβεται
ΜΟΝΟ όταν το dict είναι προφανώς πρόσωπο (έχει `doctor_id` / `patient_id` / `patient_ref`, ή βρίσκεται
κάτω από `doctor` / `doctors`). Ονόματα φαρμάκων, προμηθευτών και προσωπικού ΔΕΝ κρύβονται.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute

from app.utils.masking import REDACT, mask_name

_NAME_KEYS = frozenset({"full_name", "patient_name", "prescriber_name", "member_name"})
_REDACT_KEYS = frozenset({"hio_code", "amka", "mobile", "email", "phone", "telephone", "id_number"})
_PERSON_MARKERS = ("doctor_id", "patient_id", "patient_ref")


def _person(d: dict) -> dict:
    """Ένα dict που ΕΙΝΑΙ πρόσωπο (γιατρός / πελάτης): κρύβεται και το σκέτο `name`."""
    out = mask_tree(d)
    if isinstance(out.get("name"), str):
        out["name"] = mask_name(out["name"], True)
    return out


def mask_tree(obj: Any) -> Any:
    """Αναδρομική απόκρυψη προσώπων (επιστρέφει νέο αντικείμενο)."""
    if isinstance(obj, list):
        return [mask_tree(x) for x in obj]
    if not isinstance(obj, dict):
        return obj
    if any(k in obj for k in _PERSON_MARKERS) and isinstance(obj.get("name"), str):
        obj = {**obj, "name": mask_name(obj["name"], True)}
    out: dict = {}
    for k, v in obj.items():
        if k in _NAME_KEYS and isinstance(v, str):
            out[k] = mask_name(v, True)
        elif k in _REDACT_KEYS and isinstance(v, str) and v:
            out[k] = REDACT
        elif k == "phones" and isinstance(v, list):
            out[k] = [REDACT for _ in v]
        elif k == "doctor":
            out[k] = mask_name(v, True) if isinstance(v, str) else (_person(v) if isinstance(v, dict) else mask_tree(v))
        elif k == "doctors" and isinstance(v, list):
            out[k] = [mask_name(x, True) if isinstance(x, str) else (_person(x) if isinstance(x, dict) else x)
                      for x in v]
        else:
            out[k] = mask_tree(v)
    return out


def has_mask(value: Any) -> bool:
    """Τιμή που ήρθε από οθόνη παρουσίασης (περιέχει «*») — ΠΟΤΕ δεν γράφεται πάνω στο πραγματικό."""
    return isinstance(value, str) and "*" in value


class CyMaskedRoute(APIRoute):
    """route_class του /cy: σε παρουσίαση, κάθε JSON απάντηση περνά από `mask_tree`.
    Η σημαία μπαίνει στο `request.state.cy_demo` από το `require_cy` (που ΟΛΑ τα endpoints περνούν)."""

    def get_route_handler(self):
        inner = super().get_route_handler()

        async def handler(request: Request) -> Response:
            resp = await inner(request)
            if not getattr(request.state, "cy_demo", False) or "json" not in (resp.media_type or ""):
                return resp
            body = getattr(resp, "body", None)
            if not body:
                return resp
            masked = json.dumps(mask_tree(json.loads(body)), ensure_ascii=False).encode()
            headers = {k: v for k, v in resp.headers.items() if k.lower() != "content-length"}
            return Response(content=masked, status_code=resp.status_code, headers=headers,
                            media_type=resp.media_type)

        return handler
