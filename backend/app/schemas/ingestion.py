"""Ingestion request/response DTOs — ΗΔΥΚΑ connection settings.

Secrets (password, client_secret) go to Vault and are NEVER returned by reads.
Non-secret config + status is stored on the tenant for display in Settings.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# fields treated as secrets → Vault only, never returned
HDIKA_SECRET_FIELDS = {"password", "client_secret", "api_key"}


class HdikaCredentialsIn(BaseModel):
    """Everything a pharmacy registers to connect to the ΗΔΥΚΑ e-prescription API.

    The official ΗΔΥΚΑ interoperability spec (endpoint/auth) is provided under
    agreement (pharm.api.support@idika.gr); these fields cover the realistic set.
    """

    # ── e-Συνταγογράφηση pharmacy account ──
    # All credential fields optional on UPDATE: empty secrets (password/api_key/
    # client_secret) and empty username keep the stored value (merge on save).
    username: str | None = Field(None, description="Όνομα χρήστη e-Συνταγογράφησης")
    password: str | None = Field(None, description="Κωδικός (secret → Vault· κενό = αμετάβλητο)")

    # ── pharmacy identifiers ──
    afm: str | None = Field(None, description="ΑΦΜ φαρμακείου")
    eopyy_registry: str | None = Field(None, description="ΑΜ ΕΟΠΥΥ φαρμακείου")
    pharmacy_code: str | None = Field(None, description="Κωδικός φαρμακείου στο ΣΗΣ")

    # ── integration parameters (given by ΗΔΥΚΑ) ──
    environment: Literal["test", "production"] = "test"
    base_url: str | None = Field(None, description="ΗΔΥΚΑ API endpoint, π.χ. https://testeps.e-prescription.gr/pharmapiv2")
    api_key: str | None = Field(None, description="APPLICATION ACCESS API KEY — μοναδικό ανά εφαρμογή (secret → Vault)")
    doctor_ip: str | None = Field(None, description="X-DOCTOR-IP — εξωτερική IP κλήσης (αν απαιτείται)")
    client_id: str | None = Field(None, description="Integrator client id (αν OAuth)")
    client_secret: str | None = Field(None, description="Integrator client secret (secret → Vault)")

    # ── sync settings ──
    sync_enabled: bool = True
    sync_interval_minutes: int = Field(15, ge=5, le=1440)
    history_from: str | None = Field(None, description="Έναρξη άντλησης (ISO ημ/νία) — αρχή σύμβασης ΕΟΠΥΥ")


class HdikaConfigOut(BaseModel):
    """Non-secret connection status shown in Settings (no password/secret)."""

    configured: bool = False
    username: str | None = None              # masked
    afm: str | None = None
    eopyy_registry: str | None = None
    pharmacy_code: str | None = None
    pharmacy_id: str | None = None          # auto-discovered from ΗΔΥΚΑ
    pharmacy_name: str | None = None         # auto-discovered
    environment: str = "test"
    base_url: str | None = None
    has_api_key: bool = False
    doctor_ip: str | None = None
    client_id: str | None = None
    has_client_secret: bool = False
    sync_enabled: bool = True
    sync_interval_minutes: int = 15
    history_from: str | None = None
    last_test: dict | None = None            # {at, ok, message}
    last_sync: dict | None = None            # {at, status, stats}


class CredentialsStatusOut(BaseModel):
    source: str
    configured: bool
    credentials_ref: str | None = None


class ConnectionTestOut(BaseModel):
    ok: bool
    mode: str                                # "live" | "synthetic"
    message: str


class SyncTriggerOut(BaseModel):
    job_id: str
    status: str
    source: str
