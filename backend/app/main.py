"""FastAPI application factory."""

from __future__ import annotations

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.core.db import ensure_indexes, reap_orphan_jobs
from app.middleware.audit import AuditMiddleware
from app.services.vault_service import vault

_STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.assert_production_secrets()
    vault.assert_ready()  # prod: refuse to boot without a real Vault (no in-memory fallback)
    await ensure_indexes()
    await reap_orphan_jobs()  # clear sync_jobs orphaned by worker restarts
    import asyncio
    from app.services.node_metrics import report_loop
    asyncio.create_task(report_loop())  # per-node CPU/RAM/load → admin infra dashboard
    yield


def create_app() -> FastAPI:
    # SECURITY: never expose interactive docs / OpenAPI schema in prod/staging — it hands a
    # full endpoint+schema map (admin, gdpr, ingestion…) to anonymous visitors.
    _docs = None if settings.is_production else "/api/docs"
    _openapi = None if settings.is_production else "/api/openapi.json"
    _redoc = None if settings.is_production else "/api/redoc"
    app = FastAPI(
        title="RxVision API",
        version="1.0.0",
        docs_url=_docs,
        redoc_url=_redoc,
        openapi_url=_openapi,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(AuditMiddleware)
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": app.version, "uptime": int(time.time() - _STARTED_AT)}

    return app


app = create_app()
