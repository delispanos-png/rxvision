"""Fund groups — platform-admin-managed grouping of insurance funds (by ΗΔΥΚΑ code).

Defined ONCE centrally (shared DB) and applied to every tenant's fund breakdowns.
Funds are keyed by their ΗΔΥΚΑ `code`, which is identical across all pharmacies.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.db import shared_db
from app.core.deps import PlatformContext, get_platform_admin

router = APIRouter()


def _coll():
    return shared_db()["fund_groups"]


def _out(d: dict | None) -> dict | None:
    if not d:
        return d
    d["id"] = str(d.pop("_id"))
    return d


def _oid(group_id: str) -> ObjectId:
    try:
        return ObjectId(group_id)
    except (InvalidId, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Η ομάδα δεν βρέθηκε.") from exc


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    codes: list[str] = Field(default_factory=list)
    color: str | None = None
    order: int = 0


@router.get("")
async def list_groups(ctx: PlatformContext = Depends(get_platform_admin)):
    rows = await _coll().find().sort([("order", 1), ("name", 1)]).to_list(length=None)
    return {"items": [_out(r) for r in rows]}


@router.get("/catalog")
async def funds_catalog(ctx: PlatformContext = Depends(get_platform_admin)):
    """All distinct funds seen across ALL tenants + which group each is already in."""
    rows = await shared_db()["insurance_funds"].aggregate([
        {"$group": {"_id": "$code", "name": {"$first": "$name"}, "tenants": {"$addToSet": "$tenant_id"}}},
        {"$sort": {"name": 1}},
    ]).to_list(length=None)
    groups = await _coll().find().to_list(length=None)
    code2group = {c: g["name"] for g in groups for c in g.get("codes", [])}
    return {"items": [{"code": r["_id"], "name": r["name"],
                       "tenants": len(r.get("tenants", [])), "group": code2group.get(r["_id"])}
                      for r in rows if r["_id"]]}


@router.post("", status_code=201)
async def create_group(body: GroupIn, ctx: PlatformContext = Depends(get_platform_admin)):
    now = datetime.now(tz=timezone.utc)
    doc = {**body.model_dump(), "created_at": now, "updated_at": now}
    res = await _coll().insert_one(doc)
    return _out({**doc, "_id": res.inserted_id})


@router.put("/{group_id}")
async def update_group(group_id: str, body: GroupIn,
                       ctx: PlatformContext = Depends(get_platform_admin)):
    oid = _oid(group_id)
    await _coll().update_one({"_id": oid},
                             {"$set": {**body.model_dump(), "updated_at": datetime.now(tz=timezone.utc)}})
    return _out(await _coll().find_one({"_id": oid}))


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: str, ctx: PlatformContext = Depends(get_platform_admin)):
    await _coll().delete_one({"_id": _oid(group_id)})


class AssignIn(BaseModel):
    code: str
    group_id: str | None = None  # None → remove from every group (ungrouped)


@router.post("/assign")
async def assign(body: AssignIn, ctx: PlatformContext = Depends(get_platform_admin)):
    """Move a fund code to a group (single source of truth: a code lives in ≤1 group)."""
    await _coll().update_many({"codes": body.code}, {"$pull": {"codes": body.code}})
    if body.group_id:
        await _coll().update_one({"_id": _oid(body.group_id)},
                                 {"$addToSet": {"codes": body.code}})
    return {"ok": True}
