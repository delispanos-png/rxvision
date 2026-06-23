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
    if "MGMT" in n or "CTRL" in n:
        return "mgmt"   # management/control node (not an LB target)
    return "app"


_MGMT_NODE = "RxVisionMGMT01"  # runs backups / provisioning / ops orchestration (deploy key + token)

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


async def _hetzner_topology(token: str, live: dict) -> tuple[list, list, list]:
    """Build (servers, load_balancers, networks) from the Hetzner API. Raises on an
    invalid token / non-200 so the caller can fall back to the live-metrics view."""
    h = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=20) as cl:
        srv_r, lb_r, net_r, st_r = await asyncio.gather(
            cl.get("https://api.hetzner.cloud/v1/servers", headers=h),
            cl.get("https://api.hetzner.cloud/v1/load_balancers", headers=h),
            cl.get("https://api.hetzner.cloud/v1/networks", headers=h),
            cl.get("https://api.hetzner.cloud/v1/server_types", headers=h),
        )
        if srv_r.status_code != 200:
            raise RuntimeError(f"hetzner {srv_r.status_code}")  # e.g. 401 invalid token
        servers_raw = srv_r.json().get("servers", [])
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
                "disk_pct": lm.get("disk_pct") if lm.get("fresh") else None,
                "disk_total_gb": lm.get("disk_total_gb") if lm.get("fresh") else st.get("disk"),
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
    return servers, lbs, nets


class OpsIn(BaseModel):
    type: str            # "prune" | "backup" | "restore"
    target: str = "all"  # "all" or a specific node name
    file: str | None = None  # for restore: the backup archive filename


@router.post("/ops")
async def enqueue_op(body: OpsIn, ctx: PlatformContext = Depends(get_platform_admin)):
    """Queue a host-ops command (docker prune / backup / restore). A per-node systemd ops-agent
    picks it up and runs it on the host — the api never touches docker/SSH itself."""
    db = shared_db()
    if body.type not in ("prune", "backup", "restore", "add_node"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown_op")
    now = datetime.now(tz=timezone.utc)
    extra: dict = {}
    if body.type == "restore":
        # only allow restoring a file we actually know about (anti-injection)
        if not body.file or not await db["backups"].find_one({"file": body.file}):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown_backup_file")
        nodes = [_MGMT_NODE]
        extra["file"] = body.file
    elif body.type == "add_node":
        nodes = [_MGMT_NODE]   # provisioning runs on the mgmt node (deploy key + token + repo)
    elif body.type == "backup":
        nodes = [_MGMT_NODE]                            # backup runs on the mgmt node
    elif body.target == "all":
        nodes = [m["_id"] async for m in db["node_metrics"].find({}) if "DB" not in (m["_id"] or "")]
    else:
        nodes = [body.target]
    docs = [{"type": body.type, "node": n, "status": "pending", "requested_at": now,
             "requested_by": getattr(ctx, "email", None), **extra} for n in nodes]
    if docs:
        await db["ops_commands"].insert_many(docs)
    return {"ok": True, "queued": len(docs)}


@router.get("/ops")
async def list_ops(ctx: PlatformContext = Depends(get_platform_admin)):
    """Recent host-ops commands + their results (for the maintenance panel)."""
    from app.repositories.base import jsonsafe
    db = shared_db()
    items = [jsonsafe(c) async for c in db["ops_commands"].find({}).sort("requested_at", -1).limit(8)]
    return {"items": items}


@router.get("/serving")
async def serving_distribution(ctx: PlatformContext = Depends(get_platform_admin)):
    """Load visibility: which app node last served each tenant + per-node distribution.
    Tenants are NOT pinned — this is just where each tenant's most recent request landed."""
    from app.repositories.base import jsonsafe
    db = shared_db()
    names = {t["_id"]: t.get("name", t["_id"]) async for t in db["tenants"].find({}, {"name": 1})}
    rows = []
    by_node: dict[str, int] = {}
    async for s in db["tenant_serving"].find({}).sort("last_at", -1):
        node = s.get("node") or "—"
        by_node[node] = by_node.get(node, 0) + 1
        rows.append({"tenant_id": s["_id"], "tenant": names.get(s["_id"], s["_id"]),
                     "node": node, "last_at": s.get("last_at"), "hits": s.get("hits", 0)})
    dist = [{"node": k, "tenants": v} for k, v in sorted(by_node.items())]
    return jsonsafe({"distribution": dist, "tenants": rows})


@router.get("/backups")
async def list_backups(ctx: PlatformContext = Depends(get_platform_admin)):
    """Available DB backup archives (kept ~1 week), newest first — for the restore picker."""
    from app.repositories.base import jsonsafe
    db = shared_db()
    items = [jsonsafe(b) async for b in db["backups"].find({}).sort("ts", -1).limit(30)]
    return {"items": items}


@router.get("/infra")
async def infra(ctx: PlatformContext = Depends(get_platform_admin)):
    """Live infrastructure topology. Degrades gracefully — if the Hetzner token is missing
    or invalid it still shows the nodes actively reporting metrics, with hetzner_ok=false."""
    c = await _cfg()
    token = c.get("hetzner_token")

    live: dict[str, dict] = {}
    cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=3)
    async for m in shared_db()["node_metrics"].find({}):
        m["fresh"] = bool(m.get("ts") and m["ts"] > cutoff)
        live[m.get("node") or m.get("_id")] = m

    servers: list = []
    lbs: list = []
    nets: list = []
    hetzner_ok = False
    if token:
        try:
            servers, lbs, nets = await _hetzner_topology(token, live)
            hetzner_ok = True
        except Exception:  # noqa: BLE001 — invalid/expired token or API hiccup
            hetzner_ok = False

    if not hetzner_ok:  # fall back to the nodes actively reporting metrics
        for name, lm in sorted(live.items()):
            servers.append({
                "name": name, "role": _role(name),
                "status": "running" if lm.get("fresh") else "unknown",
                "type": None, "cores": None, "memory_gb": None, "disk_gb": None,
                "public_ip": None, "private_ip": None, "location": None,
                "cpu": lm.get("cpu") if lm.get("fresh") else None,
                "ram_pct": lm.get("ram_pct") if lm.get("fresh") else None,
                "load": lm.get("load") if lm.get("fresh") else None,
                "disk_pct": lm.get("disk_pct") if lm.get("fresh") else None,
                "disk_total_gb": lm.get("disk_total_gb") if lm.get("fresh") else None,
                "metrics_live": bool(lm.get("fresh")),
            })

    last_backup = await shared_db()["backup_status"].find_one({"_id": "last"})
    lb = last_backup or {}
    storage = ({"configured": bool(c.get("storage_password")), "host": c.get("storage_host"),
                "path": c.get("storage_path"),
                "last_backup_at": lb.get("ts"), "last_backup_size": lb.get("size"),
                "last_backup_location": lb.get("location"), "last_backup_ok": lb.get("ok"),
                # backup storage footprint + free space on the backups filesystem
                "backups_total": lb.get("backups_total"), "disk_avail": lb.get("disk_avail"),
                "disk_total": lb.get("disk_total"), "disk_used_pct": lb.get("disk_used_pct")}
               if c.get("storage_host") else None)

    return {"servers": servers, "load_balancers": lbs, "networks": nets, "storage": storage,
            "hetzner_ok": hetzner_ok, "fetched_at": datetime.now(tz=timezone.utc).isoformat()}
