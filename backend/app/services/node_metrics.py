"""Lightweight per-node metrics reporter. Each app node writes its host CPU/RAM/load
(read straight from /proc, accurate inside the container) to the shared `node_metrics`
collection every 30s, keyed by NODE_NAME. The admin infra dashboard reads it back.
No-op if NODE_NAME is unset (e.g. local dev)."""

from __future__ import annotations

import asyncio
import os
import shutil
from datetime import datetime, timezone

from app.core.db import shared_db

_prev_cpu: tuple[int, int] | None = None


def _cpu_sample() -> tuple[int, int]:
    with open("/proc/stat") as f:
        nums = [int(x) for x in f.readline().split()[1:]]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return idle, sum(nums)


def _cpu_pct() -> float | None:
    global _prev_cpu
    idle, total = _cpu_sample()
    prev = _prev_cpu
    _prev_cpu = (idle, total)
    if not prev:
        return None
    d_idle, d_total = idle - prev[0], total - prev[1]
    return round((1 - d_idle / d_total) * 100, 1) if d_total > 0 else None


def _ram() -> tuple[int, float]:
    info: dict[str, int] = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, _, v = line.partition(":")
            if v:
                info[k.strip()] = int(v.split()[0])  # kB
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    pct = round((1 - avail / total) * 100, 1) if total else 0.0
    return total // 1024, pct  # MB total, used %


def _load() -> float:
    with open("/proc/loadavg") as f:
        return float(f.read().split()[0])


def _disk() -> tuple[float, float]:
    # statvfs("/") inside the container reports the underlying host filesystem (overlay is
    # backed by the host's root disk), so this reflects real host disk usage. Returns (GB total, used %).
    du = shutil.disk_usage("/")
    pct = round(du.used / du.total * 100, 1) if du.total else 0.0
    return round(du.total / 1_000_000_000, 1), pct


async def report_loop() -> None:
    name = os.environ.get("NODE_NAME")
    if not name:
        return
    _cpu_sample()  # prime the delta
    while True:
        await asyncio.sleep(2)
        try:
            cpu = _cpu_pct()
            ram_total, ram_pct = _ram()
            disk_total_gb, disk_pct = _disk()
            await shared_db()["node_metrics"].update_one(
                {"_id": name},
                {"$set": {"node": name, "cpu": cpu, "ram_pct": ram_pct,
                          "ram_total_mb": ram_total, "load": _load(),
                          "disk_pct": disk_pct, "disk_total_gb": disk_total_gb,
                          "ts": datetime.now(tz=timezone.utc)}},
                upsert=True)
        except Exception:  # noqa: BLE001 — metrics must never crash the app
            pass
        await asyncio.sleep(28)
