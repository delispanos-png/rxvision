"""Ποιο φαρμακείο «έχει» μια εκτέλεση ΗΔΥΚΑ — ρωτώντας το feed του ΚΑΤΟΧΟΥ.

ΓΙΑΤΙ (29/09/2026): η υπόθεση «ό,τι μας φέρνει το feed με το δικό μας pharmacyId είναι δικό μας»
ΔΕΝ ισχύει πάντα. Σε μεμονωμένες ημέρες (31/08, 22–23/09, 27/09) η ΗΔΥΚΑ επέστρεψε εκτελέσεις
άλλων φαρμακείων με ΚΟΙΝΟΥΣ ασθενείς. Ο μηχανισμός «αυτόματης μεταφοράς» τις έπαιρνε από το σωστό
φαρμακείο, και ο επόμενος συγχρονισμός εκείνου τις έπαιρνε πίσω — ~20.000 μεταφορές πινγκ-πονγκ σε
11 ζεύγη. Επαληθεύτηκε ζωντανά: σε κανονική ημέρα τα feeds δύο φαρμακείων έχουν ΜΗΔΕΝ κοινές εγγραφές.

ΚΑΝΟΝΑΣ: όταν μια εκτέλεση υπάρχει ήδη σε άλλο φαρμακείο, ρωτάμε το feed του κατόχου για την ημέρα
της. Την έχει → η ΗΔΥΚΑ μάς την έδωσε κατά λάθος, ΜΕΝΕΙ εκεί. Δεν την έχει → πραγματική διαρροή,
μεταφέρεται. Δεν μπορούμε να ρωτήσουμε (σφάλμα δικτύου) → μένει εκεί, ξαναρωτάμε στον επόμενο
συγχρονισμό. ΠΟΤΕ δεν χρησιμοποιούμε διαπιστευτήρια φαρμακείου σε παύση λόγω λάθους κωδικού:
μια ακόμη αποτυχημένη σύνδεση μπορεί να κλειδώσει τον λογαριασμό του στην ΗΔΥΚΑ.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date

log = logging.getLogger(__name__)

#: Ο κάτοχος δεν έχει ενεργή σύνδεση ΗΔΥΚΑ (π.χ. διαγραμμένη δοκιμή) → δεν έχει νόμιμο feed.
NO_FEED = "no_feed"


class HdikaOwnership:
    """Ένα αντικείμενο ανά άντληση: cache (κάτοχος, ημέρα) → σύνολο (barcode, executionNo)."""

    def __init__(self, db) -> None:
        self.db = db
        self._cache: dict[tuple[str, date], set | str | None] = {}

    async def holder_owns(self, holder: str, external_id: str, executed_at) -> bool | None:
        """True = ο κάτοχος την έχει στο feed του · False = δεν την έχει (ή δεν έχει feed) ·
        None = άγνωστο (δεν μπορέσαμε να ρωτήσουμε)."""
        bc, _, no = (external_id or "").partition(":")
        if not bc or not executed_at:
            return None
        day = executed_at.date()
        key = (holder, day)
        if key not in self._cache:
            self._cache[key] = await self._keys(holder, day)
        keys = self._cache[key]
        if keys is None:
            return None
        if keys == NO_FEED:
            return False
        try:
            return (bc, int(no or 1)) in keys   # type: ignore[operator]
        except ValueError:
            return None

    async def _keys(self, holder: str, day: date) -> set | str | None:
        from app.api.v1.routers.ingestion import _effective_hdika_creds
        from app.services.ingestion.hdika_client import HdikaClient
        t = await self.db["tenants"].find_one(
            {"_id": holder}, {"ingestion_config.hdika.auth_paused": 1})
        if not t:
            return NO_FEED                                  # ο κάτοχος δεν υπάρχει πια
        if ((t.get("ingestion_config") or {}).get("hdika") or {}).get("auth_paused"):
            return None                                     # κίνδυνος κλειδώματος → δεν ρωτάμε
        try:
            creds = await _effective_hdika_creds(holder)
        except Exception:  # noqa: BLE001
            return None
        if not creds or not creds.get("pharmacy_id") or not creds.get("api_key"):
            return NO_FEED
        client = HdikaClient(dict(creds, throttle=0.05))
        try:
            return await asyncio.to_thread(client.search_keys, day)
        except Exception as e:  # noqa: BLE001 — άγνωστο, όχι «δεν την έχει»
            log.warning("ownership check failed holder=%s day=%s: %s", holder, day, e)
            return None
        finally:
            try:
                client._client.close()
            except Exception:  # noqa: BLE001
                pass
