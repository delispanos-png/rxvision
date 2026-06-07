"""User & role management DTOs."""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    email: EmailStr
    # Optional: if omitted, a temporary password is generated and emailed to the user.
    password: str | None = Field(None, min_length=8)
    full_name: str = Field(..., min_length=1)
    role_ids: list[str] = Field(default_factory=list)
    pharmacy_ids: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    full_name: str | None = None
    role_ids: list[str] | None = None
    pharmacy_ids: list[str] | None = None
    status: str | None = None  # active|suspended


class RoleCreate(BaseModel):
    key: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    permissions: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    name: str | None = None
    permissions: list[str] | None = None
