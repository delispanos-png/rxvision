"""SoftOne (S1 Web Services) — έκδοση παραστατικών & διαβίβαση myDATA μέσω του SoftOne της CloudOn.

Ροή: login → authenticate → setData(SALDOC). Το SoftOne (πιστοποιημένος πάροχος) διαβιβάζει στο
myDATA και επιστρέφει MARK/υπογραφές. Τα credentials αποθηκεύονται κρυπτογραφημένα (platform_secrets).

ΦΑΣΗ 1: config + login/authenticate + test_connection. Το `issue()` (setData SALDOC) = Φάση 2.
"""

from __future__ import annotations

import httpx

from app.core.db import shared_db


async def platform_config() -> dict:
    from app.services.platform_secrets import decrypt_doc
    return decrypt_doc("softone", await shared_db()["platform_settings"].find_one({"_id": "softone"})) or {}


def is_configured(cfg: dict) -> bool:
    return bool(cfg.get("base_url") and cfg.get("username") and cfg.get("password") and cfg.get("app_id"))


async def _post(base_url: str, payload: dict, timeout: int = 30) -> dict:
    """POST JSON στο SoftOne WS endpoint. Επιστρέφει το JSON (ή {success:False,error:...})."""
    async with httpx.AsyncClient(timeout=timeout) as cl:
        r = await cl.post(base_url, json=payload,
                          headers={"Content-Type": "application/json; charset=utf-8"})
        r.raise_for_status()
        try:
            return r.json()
        except Exception:  # noqa: BLE001
            return {"success": False, "error": "invalid_json", "raw": r.text[:300]}


async def _login(cfg: dict) -> dict:
    """service=login → {clientID, objs (εταιρείες/υποκαταστήματα)}."""
    return await _post(cfg["base_url"], {
        "service": "login", "username": cfg["username"],
        "password": cfg["password"], "appId": cfg["app_id"]})


async def _authenticate(cfg: dict, client_id: str) -> dict:
    """service=authenticate → authenticated clientID. Το SoftOne BlackBook (σελ.468) θέλει ΠΕΖΑ κλειδιά:
    service, clientID, company, branch, module, refid."""
    body = {"service": "authenticate", "clientID": client_id}
    for key in ("company", "branch", "module", "refid"):
        if cfg.get(key):
            body[key] = cfg[key]
    return await _post(cfg["base_url"], body)


async def get_client_id(cfg: dict | None = None) -> str | None:
    """Πλήρες login+authenticate → authenticated clientID (ή None)."""
    cfg = cfg or await platform_config()
    if not is_configured(cfg):
        return None
    lg = await _login(cfg)
    if not lg.get("success") or not lg.get("clientID"):
        return None
    au = await _authenticate(cfg, lg["clientID"])
    return au.get("clientID") if au.get("success") else lg.get("clientID")


async def test_connection() -> dict:
    """Δοκιμή credentials: login (+authenticate). Επιστρέφει {ok, error?, companies?}."""
    cfg = await platform_config()
    if not is_configured(cfg):
        return {"ok": False, "error": "not_configured"}
    try:
        lg = await _login(cfg)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"connect_error:{type(e).__name__}"}
    if not lg.get("success"):
        return {"ok": False, "error": lg.get("error") or "login_failed", "code": lg.get("errorcode")}
    objs = lg.get("objs") or []
    companies = [{"company": o.get("COMPANY"), "name": o.get("COMPANYNAME"),
                  "branch": o.get("BRANCH"), "branchname": o.get("BRANCHNAME")} for o in objs][:20]
    # δοκίμασε και authenticate αν έχουν δηλωθεί company/branch
    auth_ok = None
    if cfg.get("company"):
        try:
            au = await _authenticate(cfg, lg["clientID"])
            auth_ok = bool(au.get("success"))
        except Exception:  # noqa: BLE001
            auth_ok = False
    return {"ok": True, "companies": companies, "authenticated": auth_ok}


async def issue(payload: dict) -> dict:
    """Έκδοση παραστατικού μέσω **custom JS web service** του SoftOne (Advanced JavaScript).
    BlackBook: εξωτερική κλήση σε `POST <base_url>/JS/<module>/<function>` με `clientID` (από
    authenticate) + το payload μας. Το SoftOne JS δημιουργεί SALDOC + διαβιβάζει myDATA & επιστρέφει
    το αποτέλεσμα (findoc/MARK). Το endpoint (module/function) ΔΕΝ είναι hardcoded — από adminpanel.
    `payload` = το συμβόλαιο δεδομένων που περιμένει η JS συνάρτηση (βλ. spec §JS contract)."""
    cfg = await platform_config()
    if not is_configured(cfg):
        return {"ok": False, "error": "not_configured"}
    js_path = (cfg.get("js_endpoint") or "").strip().strip("/")
    if not js_path:
        return {"ok": False, "error": "no_js_endpoint"}   # π.χ. "RXVISION/createInvoice"
    client_id = await get_client_id(cfg)
    if not client_id:
        return {"ok": False, "error": "auth_failed"}
    url = cfg["base_url"].rstrip("/") + "/JS/" + js_path
    body = {"clientID": client_id, "appId": cfg.get("app_id"), **payload}
    try:
        res = await _post(url, body)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"connect_error:{type(e).__name__}"}
    if not res.get("success"):
        return {"ok": False, "error": res.get("error") or "js_failed", "code": res.get("errorcode"), "raw": res}
    # Το ακριβές schema απόκρισης το ορίζει η JS συνάρτηση της SoftOne (findoc/mark/uid/aa).
    return {"ok": True, "findoc": res.get("findoc") or res.get("id"),
            "mark": res.get("mark") or res.get("MARK"), "uid": res.get("uid") or res.get("UID"),
            "aa": res.get("aa") or res.get("AA"), "raw": res}
