"""Backfill doctor phone/email from ΗΔΥΚΑ CDA (author telecom) for existing doctors.
One CDA fetch per doctor that lacks a phone. Bounded by LIMIT. Idempotent."""
import asyncio

from app.core.db import shared_db
from app.services.ingestion.hdika_cda import parse_cda
from app.services.ingestion.hdika_client import HdikaClient
from app.services.vault_service import vault

LIMIT = 2000


async def build_client(db, tid):
    creds = dict(vault.get_secret(f"tenants/{tid}/hdika") or {})
    plat = await db["platform_settings"].find_one({"_id": "idika"})
    if plat:
        env = plat.get("active_environment", "test")
        envcfg = plat.get(env) or {}
        if envcfg.get("base_url"):
            creds["base_url"] = envcfg["base_url"]
        creds["environment"] = env
        if env == "test":
            for s, d in (("integrator_username", "username"), ("integrator_password", "password"),
                         ("api_key", "api_key"), ("pharmacy_id", "pharmacy_id")):
                if envcfg.get(s):
                    creds[d] = envcfg[s]
    return HdikaClient(creds)


async def main():
    db = shared_db()
    tenants = await db["tenants"].find({"country": "GR"}).to_list(None)
    for t in tenants:
        tid = t["_id"]
        try:
            c = await build_client(db, tid)
        except Exception as e:
            print(f"{tid}: client error {e}")
            continue
        params = {"pharmacyId": c.pharmacy_id} if c.pharmacy_id else {}
        fetched = updated = 0
        async for doc in db["doctors"].find({"tenant_id": tid, "phone": {"$exists": False}}):
            if fetched >= LIMIT:
                break
            ex = await db["prescription_executions"].find_one(
                {"tenant_id": tid, "doctor_id": doc["_id"]}, {"external_id": 1})
            if not ex:
                continue
            bc = str(ex["external_id"]).split(":")[0]
            try:
                r = c._client.get(c._url(f"/api/v1/prescriptions/get/{bc}"),
                                  params=params, headers={"Accept": "application/x-hl7"})
                d = parse_cda(r.text).get("doctor") or {}
            except Exception:
                continue
            fetched += 1
            setf = {}
            if d.get("phone"):
                setf["phone"] = d["phone"]
            if d.get("email"):
                setf["email"] = d["email"]
            if setf:
                await db["doctors"].update_one({"_id": doc["_id"]}, {"$set": setf})
                updated += 1
        c._client.close()
        print(f"{tid}: fetched={fetched} updated={updated}")


if __name__ == "__main__":
    asyncio.run(main())
