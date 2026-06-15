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

        if request.method in _AUDITED_METHODS:
            ctx = getattr(request.state, "tenant", None)
            admin = getattr(request.state, "admin", None)
            path = request.url.path
            is_login = path.endswith("/auth/login")
            # Tenant mutations (as before) + platform-admin actions + login attempts (incl.
            # failures) — closes the forensic gaps on the highest-privilege surfaces.
            if ctx is not None or admin is not None or is_login:
                actor_kind = "tenant" if ctx else "platform_admin" if admin else "anonymous"
                await shared_db()["audit_logs"].insert_one({  # tenant-ok: platform audit record
                    "tenant_id": getattr(ctx, "tenant_id", None),
                    "actor_user_id": getattr(ctx, "user_id", None) or getattr(admin, "admin_id", None),
                    "actor_kind": actor_kind,
                    "action": f"{request.method} {path}",
                    "request_id": request_id,
                    "ip": (request.headers.get("cf-connecting-ip")
                           or (request.client.host if request.client else None)),
                    "outcome": "success" if response.status_code < 400 else "error",
                    "status_code": response.status_code,
                    "at": datetime.now(tz=timezone.utc),
                })
        response.headers["x-request-id"] = request_id
        return response
