"""Cloud credentials (Hetzner + Cloudflare) for infrastructure/scaling — stored in Vault,
managed only from the platform back-office. Tokens are never returned, logged or committed.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.db import shared_db
from app.core.deps import PlatformContext, get_platform_admin

router = APIRouter()


def _role(name: str) -> str:
    n = name.upper()
    if "DB" in n:
        return "db"
    if "LB" in n:
        return "lb"
    return "app"

_SECRETS = ("hetzner_token", "cloudflare_token", "storage_password")
_CONFIG = ("storage_host", "storage_user", "storage_path")


async def _cfg() -> dict:
    # stored in platform_settings (shared DB, auth-protected) like the SMTP config —
    # the app's Vault policy is scoped to tenants/* only.
    return await shared_db()["platform_settings"].find_one({"_id": "cloud"}) or {}


async def _save(cfg: dict) -> None:
    cfg["_id"] = "cloud"
    await shared_db()["platform_settings"].update_one({"_id": "cloud"}, {"$set": cfg}, upsert=True)


class CloudIn(BaseModel):
    hetzner_token: str | None = None
    cloudflare_token: str | None = None
    storage_host: str | None = None      # e.g. u599547.your-storagebox.de
    storage_user: str | None = None      # e.g. u599547
    storage_password: str | None = None
    storage_path: str | None = None      # subdir for backups, e.g. /rxvision-backups


@router.get("")
async def get_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    """Non-secret status only — never echoes the tokens/password."""
    c = await _cfg()
    return {
        "hetzner_configured": bool(c.get("hetzner_token")),
        "cloudflare_configured": bool(c.get("cloudflare_token")),
        "storage_configured": bool(c.get("storage_password")),
        "storage_host": c.get("storage_host"),
        "storage_user": c.get("storage_user"),
        "storage_path": c.get("storage_path"),
    }


@router.put("")
async def put_cloud(body: CloudIn, ctx: PlatformContext = Depends(get_platform_admin)):
    c = await _cfg()
    new = body.model_dump()
    # blank secret on the form = keep the stored one (masked round-trip)
    for k in _SECRETS:
        if not new.get(k) and c.get(k):
            new[k] = c[k]
    out = {k: v for k, v in new.items() if v and k in _SECRETS}          # secrets
    out.update({k: new[k] for k in _CONFIG if new.get(k) is not None})   # plain config
    # keep existing config the form didn't touch
    for k in _CONFIG:
        if k not in out and c.get(k):
            out[k] = c[k]
    await _save(out)
    return {"ok": True}


@router.delete("")
async def clear_cloud(ctx: PlatformContext = Depends(get_platform_admin)):
    await _save({k: None for k in (*_SECRETS, *_CONFIG)})
    return {"ok": True}


@router.post("/verify")
async def verify(ctx: PlatformContext = Depends(get_platform_admin)):
    """Validate the stored tokens against the live APIs (read-only)."""
    c = await _cfg()
    out: dict = {}
    if c.get("hetzner_token"):
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.get("https://api.hetzner.cloud/v1/servers",
                                 headers={"Authorization": f"Bearer {c['hetzner_token']}"})
            out["hetzner_ok"] = r.status_code == 200
            out["hetzner_servers"] = [s["name"] for s in r.json().get("servers", [])] if r.status_code == 200 else []
        except Exception as exc:  # noqa: BLE001
            out["hetzner_ok"] = False
            out["hetzner_error"] = str(exc)[:120]
    if c.get("cloudflare_token"):
        try:
            async with httpx.AsyncClient(timeout=15) as cl:
                r = await cl.get("https://api.cloudflare.com/client/v4/zones",
                                 headers={"Authorization": f"Bearer {c['cloudflare_token']}"})
            data = r.json()
            out["cloudflare_ok"] = bool(data.get("success"))
            out["cloudflare_zones"] = [z["name"] for z in data.get("result", [])] if data.get("success") else []
        except Exception as exc:  # noqa: BLE001
            out["cloudflare_ok"] = False
            out["cloudflare_error"] = str(exc)[:120]
    if c.get("storage_host"):
        try:
            fut = asyncio.open_connection(c["storage_host"], 23)  # Hetzner Storage Box SSH/SFTP
            reader, writer = await asyncio.wait_for(fut, timeout=10)
            writer.close()
            out["storage_ok"] = True
            out["storage_host"] = c["storage_host"]
        except Exception as exc:  # noqa: BLE001
            out["storage_ok"] = False
            out["storage_error"] = str(exc)[:120]
    if not out:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Δεν έχουν αποθηκευτεί tokens.")
    return out


async def _hetzner_cpu(cl: httpx.AsyncClient, h: dict, sid: int) -> float | None:
    """Last CPU% data-point from Hetzner's metrics API (best-effort)."""
    now = datetime.now(tz=timezone.utc)
    params = {"type": "cpu", "start": (now - timedelta(minutes=5)).isoformat(),
              "end": now.isoformat(), "step": "60"}
    try:
        r = await cl.get(f"https://api.hetzner.cloud/v1/servers/{sid}/metrics", headers=h, params=params)
        if r.status_code != 200:
            return None
        series = r.json().get("metrics", {}).get("time_series", {}).get("cpu", {}).get("values", [])
        return round(float(series[-1][1]), 1) if series else None
    except Exception:  # noqa: BLE001
        return None


@router.get("/infra")
async def infra(ctx: PlatformContext = Depends(get_platform_admin)):
    """Live infrastructure topology — servers (+ specs, status, live metrics), the load
    balancer (+ target health) and the private network. Powers the admin infra dashboard."""
    c = await _cfg()
    token = c.get("hetzner_token")
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Δεν έχει αποθηκευτεί Hetzner token.")
    h = {"Authorization": f"Bearer {token}"}

    # live RAM/CPU/load reported by each node's agent (node_metrics), keyed by node name
    live: dict[str, dict] = {}
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=3)
    async for m in shared_db()["node_metrics"].find({}):
        m["fresh"] = bool(m.get("ts") and m["ts"] > cutoff)
        live[m.get("node") or m.get("_id")] = m

    async with httpx.AsyncClient(timeout=20) as cl:
        srv_r, lb_r, net_r, st_r = await asyncio.gather(
            cl.get("https://api.hetzner.cloud/v1/servers", headers=h),
            cl.get("https://api.hetzner.cloud/v1/load_balancers", headers=h),
            cl.get("https://api.hetzner.cloud/v1/networks", headers=h),
            cl.get("https://api.hetzner.cloud/v1/server_types", headers=h),
        )
        servers_raw = srv_r.json().get("servers", []) if srv_r.status_code == 200 else []
        types = {t["id"]: t for t in (st_r.json().get("server_types", []) if st_r.status_code == 200 else [])}
        # CPU per server (parallel, best-effort)
        cpus = await asyncio.gather(*[_hetzner_cpu(cl, h, s["id"]) for s in servers_raw])

        servers = []
        for s, hz_cpu in zip(servers_raw, cpus):
            name = s["name"]
            st = types.get(s.get("server_type", {}).get("id")) or s.get("server_type", {})
            priv = [p["ip"] for p in s.get("private_net", [])]
            lm = live.get(name, {})
            servers.append({
                "name": name, "role": _role(name), "status": s.get("status"),
                "type": st.get("name"), "cores": st.get("cores"),
                "memory_gb": st.get("memory"), "disk_gb": st.get("disk"),
                "public_ip": (s.get("public_net", {}).get("ipv4") or {}).get("ip"),
                "private_ip": priv[0] if priv else None,
                "location": (s.get("datacenter", {}).get("location", {}) or {}).get("name"),
                "cpu": lm.get("cpu") if lm.get("fresh") else hz_cpu,
                "ram_pct": lm.get("ram_pct") if lm.get("fresh") else None,
                "load": lm.get("load") if lm.get("fresh") else None,
                "metrics_live": bool(lm.get("fresh")),
            })

        lbs = []
        for lb in (lb_r.json().get("load_balancers", []) if lb_r.status_code == 200 else []):
            tgts = []
            for t in lb.get("targets", []):
                tid = t.get("server", {}).get("id")
                tname = next((s["name"] for s in servers_raw if s["id"] == tid), str(tid))
                hs = [x.get("status") for x in t.get("health_status", [])]
                tgts.append({"name": tname, "healthy": all(x == "healthy" for x in hs) if hs else None})
            lbs.append({
                "name": lb["name"], "public_ip": (lb.get("public_net", {}).get("ipv4") or {}).get("ip"),
                "private_ip": (lb.get("private_net", [{}])[0] or {}).get("ip") if lb.get("private_net") else None,
                "services": [f"{s.get('protocol', '').upper()} {s.get('listen_port')}→{s.get('destination_port')}"
                             for s in lb.get("services", [])],
                "targets": tgts,
            })

        nets = [{"name": n["name"], "range": n.get("ip_range"),
                 "members": [str(x) for x in n.get("servers", [])]}
                for n in (net_r.json().get("networks", []) if net_r.status_code == 200 else [])]

    storage = {"configured": bool(c.get("storage_password")), "host": c.get("storage_host"),
               "path": c.get("storage_path")} if c.get("storage_host") else None

    return {"servers": servers, "load_balancers": lbs, "networks": nets, "storage": storage,
            "fetched_at": datetime.now(tz=timezone.utc).isoformat()}
