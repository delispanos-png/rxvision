"""Security telemetry — Content-Security-Policy violation reports.

Browsers POST here when a CSP directive is violated (report-uri / report-to). Used to observe what a
tightened CSP would break BEFORE flipping it from Report-Only to enforced. Public + unauthenticated (the
browser sends no credentials), best-effort, bounded: only a few fields are kept and rows TTL-expire
(index in core/db.py). Body is size-capped so it can't be used to flood the DB."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response, status

from app.core.db import shared_db

router = APIRouter()

_MAX_BODY = 16 * 1024  # a CSP report is tiny; ignore anything larger


@router.post("/csp-report", status_code=status.HTTP_204_NO_CONTENT, include_in_schema=False)
async def csp_report(request: Request) -> Response:
    try:
        raw = await request.body()
        if len(raw) > _MAX_BODY:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        data = json.loads(raw or b"{}")
        # Accept both the legacy `{"csp-report": {...}}` and the Reporting-API `[{"body": {...}}]` shapes.
        rep = {}
        if isinstance(data, dict):
            rep = data.get("csp-report") or data.get("body") or data
        elif isinstance(data, list) and data:
            rep = (data[0] or {}).get("body") or data[0] or {}
        await shared_db()["csp_reports"].insert_one({  # tenant-ok: platform security telemetry
            "at": datetime.now(tz=timezone.utc),
            "directive": str(rep.get("violated-directive") or rep.get("effectiveDirective") or "")[:200],
            "blocked_uri": str(rep.get("blocked-uri") or rep.get("blockedURL") or "")[:400],
            "document_uri": str(rep.get("document-uri") or rep.get("documentURL") or "")[:400],
        })
    except Exception:  # noqa: BLE001 — telemetry must never error the browser
        pass
    return Response(status_code=status.HTTP_204_NO_CONTENT)
