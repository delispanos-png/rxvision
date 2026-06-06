"""Audit middleware — records mutating requests to audit_logs."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.core.db import shared_db

_AUDITED_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
        request.state.request_id = request_id
        response = await call_next(request)

        if request.method in _AUDITED_METHODS and not request.url.path.endswith("/auth/login"):
            ctx = getattr(request.state, "tenant", None)
            if ctx is not None:
                await shared_db()["audit_logs"].insert_one({
                    "tenant_id": ctx.tenant_id,
                    "actor_user_id": ctx.user_id,
                    "action": f"{request.method} {request.url.path}",
                    "request_id": request_id,
                    "ip": request.client.host if request.client else None,
                    "outcome": "success" if response.status_code < 400 else "error",
                    "status_code": response.status_code,
                    "at": datetime.now(tz=timezone.utc),
                })
        response.headers["x-request-id"] = request_id
        return response
