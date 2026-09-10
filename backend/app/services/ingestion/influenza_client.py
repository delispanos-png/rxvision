"""Influenza Vaccination Registry API client (ΗΔΥΚΑ `vaccinationregistry`).

Same credentials as the PharmacistAPI, but a SEPARATE JSON service for seasonal-flu vaccinations.
The barcode 92… range that never showed up in the prescription data lives here.

⚠️ QUIRK 1: every request — even GET — MUST carry `Content-Type: application/json`, otherwise the
ΗΔΥΚΑ gateway returns 404 (not 400). The date query-params (Greek names) don't reliably filter, so
we paginate ALL pages and let the caller filter by executionDate.

⚠️ QUIRK 2 (ΚΡΙΣΙΜΟ): the registry keeps a server-side **connection/session** per user. Any data
call made before it exists — or after it expires — fails with HTTP 400 `error.Connection`
("You must create a first connection." / "You must refresh your connection."). Calling
`GET /users/me` ESTABLISHES/REFRESHES it. So every data call must be preceded by `ensure_connection()`.
This was the root cause of 8 of 9 pharmacies having ZERO flu vaccinations: the old code silently
swallowed the 400 and reported "ok, fetched: 0".
"""

from __future__ import annotations

import time
from urllib.parse import urlencode, urlparse

import httpx

_TIMEOUT = 40
_PAGE_SIZE = 50  # API max
# NB: the OpenAPI parameter NAMES are Greek labels but those DON'T bind — the real Spring query
# params are the standard English `page`/`size` (verified: page=1 returns a different result set).


def _is_connection_error(r) -> bool:
    """HTTP 400 με errorKey/message «Connection» = λήξε ή δεν άνοιξε ποτέ η σύνδεση του μητρώου."""
    if r.status_code != 400:
        return False
    try:
        d = r.json()
        return "connection" in str(d.get("errorKey", "") or d.get("message", "")).lower()
    except Exception:  # noqa: BLE001
        return False


class InfluenzaClient:
    def __init__(self, credentials: dict) -> None:
        c = credentials or {}
        base = (c.get("base_url") or "").rstrip("/")
        p = urlparse(base)
        host = f"{p.scheme}://{p.netloc}" if p.scheme else base
        self.base = f"{host}/vaccinationregistry/influenzavacregistry/api/v2"
        key = c.get("api_key", "")
        # NB: send exactly ONE api-key header — httpx merges case-variants into one comma-joined
        # value ("key, key") which ΗΔΥΚΑ rejects as "Application key is not valid".
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if key:
            headers["api-key"] = key
        if c.get("doctor_ip"):
            headers["X-DOCTOR-IP"] = c["doctor_ip"]
        self.throttle = float(c.get("throttle") or 0)
        self._client = httpx.Client(
            timeout=_TIMEOUT,
            auth=(c.get("username", ""), c.get("password", "")) if c.get("username") else None,
            headers=headers,
        )

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:  # noqa: BLE001
            pass

    def _get(self, path: str, params: dict | None = None):
        url = f"{self.base}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        try:
            return self._client.get(url)
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"Influenza API timeout: {exc}") from exc
        except httpx.TransportError as exc:
            raise ConnectionError(f"Influenza API transport error: {exc}") from exc

    def me(self) -> dict:
        r = self._get("/users/me")
        r.raise_for_status()
        return r.json()

    def ensure_connection(self) -> None:
        """Άνοιξε/ανανέωσε τη server-side σύνδεση του μητρώου (βλ. QUIRK 2). Χωρίς αυτό κάθε
        κλήση δεδομένων γυρίζει 400 `error.Connection`. Idempotent & φθηνό (μία κλήση)."""
        if getattr(self, "_connected", False):
            return
        r = self._get("/users/me")
        if r.status_code != 200:
            raise RuntimeError(
                f"Influenza API: αποτυχία σύνδεσης (HTTP {r.status_code}): {r.text[:200]}")
        self._connected = True

    def find_all_vaccines(self) -> list:
        self.ensure_connection()
        r = self._get("/find-all-vaccines")
        return r.json() if r.status_code == 200 and isinstance(r.json(), list) else []

    def iter_vaccinations(self):
        """Yield every vaccination execution record (paginated via page/size). The dataset is small
        (a few hundred per pharmacy) so we always full-sync; stops on lastPage / totalPages / empty."""
        self.ensure_connection()
        page = 0
        while True:
            r = self._get("/execution/search", {"page": page, "size": _PAGE_SIZE})
            if r.status_code != 200 and _is_connection_error(r) and page == 0:
                # Η σύνδεση έληξε ενδιάμεσα → μία ανανέωση και ξαναδοκίμασε (μία φορά).
                self._connected = False
                self.ensure_connection()
                r = self._get("/execution/search", {"page": page, "size": _PAGE_SIZE})
            if r.status_code != 200:
                # ΠΟΤΕ σιωπηλό break: ένα 401/403/503 έδινε «ok, fetched: 0» — δηλαδή ΑΠΟΤΥΧΙΑ που
                # έμοιαζε με επιτυχία, και το φαρμακείο έβλεπε λιγότερους εμβολιασμούς χωρίς να το
                # καταλάβει κανείς. Αν έχουμε ήδη σελίδες, ρίχνουμε — ο καλών καταγράφει το σφάλμα.
                raise RuntimeError(
                    f"Influenza API HTTP {r.status_code} στη σελίδα {page}: {r.text[:200]}")
            data = r.json()
            rows = data.get("content") or []
            for row in rows:
                if isinstance(row, dict):
                    yield row
            if self.throttle:
                time.sleep(self.throttle)
            total_pages = data.get("totalPages")
            if not rows or data.get("lastPage") in (True, "true"):
                break
            if total_pages is not None and page + 1 >= int(total_pages):
                break
            page += 1
