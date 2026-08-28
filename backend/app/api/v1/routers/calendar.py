"""Public (token-secured) iCalendar feeds. NO auth dependency by design — Google/Outlook/Apple
fetch these WITHOUT auth headers, so the unguessable token in the URL is the credential. Served
on the Cloudflare-fronted domains, so the origin-auth guard is satisfied upstream.

The pharmacist mints/copies the subscription link from the portal-admin UI; the patient from the
portal. Regenerating the link (same UIs) revokes the old token → the stale calendar 404s.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from app.services import calendar_feed_service as cf

router = APIRouter()


def _ics_response(body: str, filename: str) -> Response:
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.get("/pharmacy/{token}.ics")
async def pharmacy_feed(token: str):
    feed = await cf.resolve(token)
    if not feed or feed.get("kind") != "pharmacy":
        raise HTTPException(status_code=404, detail="not_found")
    return _ics_response(await cf.pharmacy_ics(feed), "rxvision-pharmacy.ics")


@router.get("/patient/{token}.ics")
async def patient_feed(token: str):
    feed = await cf.resolve(token)
    if not feed or feed.get("kind") != "patient":
        raise HTTPException(status_code=404, detail="not_found")
    return _ics_response(await cf.patient_ics(feed), "rxvision.ics")
