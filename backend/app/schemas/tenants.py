"""Tenant administration DTOs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TenantUpdate(BaseModel):
    name: str | None = None
    settings: dict[str, Any] | None = None


class ModulesUpdate(BaseModel):
    """Partial override of module states: module_key -> enabled|trial|locked."""

    modules: dict[str, str] = Field(default_factory=dict)


class DeletionRequestIn(BaseModel):
    reason: str | None = None
    confirm: bool = False
