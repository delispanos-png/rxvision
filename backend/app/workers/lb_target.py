"""Αφαίρεση/επαναφορά app node στον Hetzner Load Balancer — για deploy ΧΩΡΙΣ 502 (26/10/2026).

ΓΙΑΤΙ: το deploy ξαναστήνει web/api σε κάθε κόμβο ενώ ο LB του στέλνει ακόμη κίνηση. Ο LB τον
βγάζει μόνος του μόνο μετά από 3 αποτυχημένους ελέγχους (~30″) → εκείνη την ώρα ~1/3 των αιτημάτων
έπαιρνε 502 (ο ιδιοκτήτης το είδε δύο φορές σε ένα deploy). Τώρα το deploy.sh:
  remove → αναμονή να τελειώσουν τα ανοιχτά αιτήματα → ανανέωση → υγεία → add → υγιής στον LB.

Χρήση (από deploy.sh, στο api container του MGMT):
  python -m app.workers.lb_target remove 10.0.0.6
  python -m app.workers.lb_target add 10.0.0.6       # περιμένει να γίνει healthy (έως 120″)
Έξοδος ≠ 0 σε αποτυχία — το deploy ΣΤΑΜΑΤΑ (καλύτερα ένας κόμβος εκτός, παρά μισή ανάπτυξη).
"""

from __future__ import annotations

import asyncio
import sys

import httpx

LB_ID = 6614941
_API = "https://api.hetzner.cloud/v1"


async def _token() -> str:
    from app.workers.capacity import _token as tok
    from app.workers.ingestion import _fresh_db
    client, db = _fresh_db()
    try:
        return await tok(db) or ""
    finally:
        client.close()


async def _server_id(cl, h, private_ip: str) -> int | None:
    for s in (await cl.get(f"{_API}/servers?per_page=50", headers=h)).json().get("servers", []):
        if any(n.get("ip") == private_ip for n in s.get("private_net") or []):
            return s["id"]
    return None


async def _targets(cl, h) -> dict[int, bool]:
    lb = (await cl.get(f"{_API}/load_balancers/{LB_ID}", headers=h)).json().get("load_balancer") or {}
    out = {}
    for t in lb.get("targets") or []:
        sid = (t.get("server") or {}).get("id")
        hs = t.get("health_status") or []
        out[sid] = bool(hs) and all(x.get("status") == "healthy" for x in hs)
    return out


async def main(action: str, ip: str) -> int:
    tok = await _token()
    if not tok:
        print("lb_target: λείπει Hetzner token", file=sys.stderr)
        return 2
    h = {"Authorization": f"Bearer {tok}"}
    async with httpx.AsyncClient(timeout=30) as cl:
        sid = await _server_id(cl, h, ip)
        if not sid:
            print(f"lb_target: δεν βρέθηκε server με IP {ip}", file=sys.stderr)
            return 2
        targets = await _targets(cl, h)
        if action == "remove":
            others_ok = [s for s, ok in targets.items() if s != sid and ok]
            if not others_ok:   # ΠΟΤΕ δεν βγάζουμε τον τελευταίο υγιή — θα ήταν ολική διακοπή
                print("lb_target: κανένας άλλος υγιής κόμβος — ΔΕΝ αφαιρώ", file=sys.stderr)
                return 3
            if sid in targets:
                await cl.post(f"{_API}/load_balancers/{LB_ID}/actions/remove_target", headers=h,
                              json={"type": "server", "server": {"id": sid}})
            print(f"removed {ip} (id={sid}); healthy others={len(others_ok)}")
            return 0
        if action == "add":
            if sid not in targets:
                await cl.post(f"{_API}/load_balancers/{LB_ID}/actions/add_target", headers=h,
                              json={"type": "server", "server": {"id": sid}, "use_private_ip": True})
            for _ in range(24):                       # έως 120″ να δηλωθεί healthy από τον LB
                await asyncio.sleep(5)
                if (await _targets(cl, h)).get(sid):
                    print(f"added {ip} (id={sid}) — healthy")
                    return 0
            print(f"lb_target: {ip} μπήκε στον LB αλλά δεν έγινε healthy σε 120″", file=sys.stderr)
            return 4
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
