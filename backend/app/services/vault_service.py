"""Vault secrets service (HashiCorp Vault, KV v2).

Single seam for every secret the app needs:
  - per-tenant ΗΔΙΚΑ/ΓΕΣΥ credentials   (path: tenants/<id>/hdika | tenants/<id>/gesy)
  - per-tenant anonymization pepper      (path: tenants/<id>/pepper)
  - app signing keys                     (path: app/jwt)

Credential endpoints are WRITE-ONLY from the API: set_secret persists to Vault, and the
value is never returned by any read endpoint — only ingestion workers read it at runtime.

If Vault is not configured (local dev without the container), it transparently falls back
to an in-memory dev store seeded from settings, so the app still boots. NEVER rely on the
fallback in production.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

_KV_MOUNT = "secret"


class VaultService:
    def __init__(self) -> None:
        self._client = None
        self._dev_store: dict[str, dict[str, Any]] = {}
        self._connect()

    def _connect(self) -> None:
        if not settings.VAULT_ADDR or not settings.VAULT_TOKEN:
            logger.warning("Vault not configured — using in-memory dev secret store.")
            # Seed dev fallbacks so the app is usable without Vault.
            self._dev_store["app/jwt"] = {"secret": settings.JWT_SECRET}
            self._dev_store["app/pepper"] = {"global": settings.ANONYMIZATION_GLOBAL_PEPPER}
            return
        try:
            import hvac  # imported lazily so dev without the dep still works

            self._client = hvac.Client(url=settings.VAULT_ADDR, token=settings.VAULT_TOKEN)
            if not self._client.is_authenticated():
                logger.error("Vault auth failed — falling back to dev store.")
                self._client = None
        except Exception as exc:  # noqa: BLE001
            logger.error("Vault init error (%s) — falling back to dev store.", exc)
            self._client = None

    # ── public API ─────────────────────────────────────────
    def set_secret(self, path: str, data: dict[str, Any]) -> None:
        """Write/overwrite a secret. Used by credential endpoints (write-only)."""
        if self._client is not None:
            self._client.secrets.kv.v2.create_or_update_secret(
                mount_point=_KV_MOUNT, path=path, secret=data
            )
        else:
            self._dev_store[path] = data

    def get_secret(self, path: str) -> dict[str, Any] | None:
        """Read a secret. Only called by workers/services, never returned to clients."""
        if self._client is not None:
            try:
                resp = self._client.secrets.kv.v2.read_secret_version(
                    mount_point=_KV_MOUNT, path=path, raise_on_deleted_version=False
                )
                return resp["data"]["data"]
            except Exception:  # noqa: BLE001
                return None
        return self._dev_store.get(path)

    def delete_secret(self, path: str) -> None:
        """Used on tenant deletion / credential revocation."""
        if self._client is not None:
            self._client.secrets.kv.v2.delete_metadata_and_all_versions(
                mount_point=_KV_MOUNT, path=path
            )
        else:
            self._dev_store.pop(path, None)

    def has_secret(self, path: str) -> bool:
        return self.get_secret(path) is not None

    # ── convenience helpers ────────────────────────────────
    def tenant_pepper(self, tenant_id: str) -> str:
        sec = self.get_secret(f"tenants/{tenant_id}/pepper")
        if sec and "value" in sec:
            return sec["value"]
        # Lazily derive a per-tenant pepper from the global one if not yet provisioned.
        return f"{settings.ANONYMIZATION_GLOBAL_PEPPER}:{tenant_id}"

    def set_tenant_credentials(self, tenant_id: str, source: str, creds: dict[str, Any]) -> str:
        path = f"tenants/{tenant_id}/{source}"
        self.set_secret(path, creds)
        return f"vault://{path}"


# module-level singleton used across the app
vault = VaultService()
