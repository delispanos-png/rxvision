"""Διαθεσιμότητα τύπων server στη Hetzner — ΜΙΑ πηγή για όλο τον κώδικα.

ΓΙΑΤΙ ΥΠΑΡΧΕΙ: η Hetzner **κατάργησε** το `/datacenters` (changelog 2026-06-02· σήμερα απαντά
410 `deprecated_api_endpoint`). Ο φύλακας χωρητικότητας και η επιλογή «Νέος app server» το
διάβαζαν με `.get("datacenters", [])` → η κατάργηση έμοιαζε με «κανένα απόθεμα πουθενά», δηλαδή
ΤΥΦΛΟΣ φύλακας χωρίς κανένα σφάλμα (διαπιστώθηκε 22/10/2026). Η διαθεσιμότητα ζει πλέον μέσα
στον ίδιο τον τύπο: `server_types[].locations[] = {name, available, …}`.

`available` = παραγγέλνεται ΤΩΡΑ στη συγκεκριμένη τοποθεσία. Χωριστό πεδίο «διαθέσιμο για
μετάπτωση (rescale)» δεν δίνεται πια — το χρησιμοποιούμε και ως ένδειξη για αναβάθμιση.
"""

from __future__ import annotations

API = "https://api.hetzner.cloud/v1"


class HetznerUnavailable(Exception):
    """Η Hetzner δεν απάντησε όπως περιμένουμε — ΔΕΝ σημαίνει «κανένα απόθεμα»."""


async def fetch(cl, h: dict) -> tuple[list[dict], dict[str, dict]]:
    """(server_types, locations ανά όνομα). Σηκώνει `HetznerUnavailable` σε κάθε απόκλιση,
    ώστε ο καλών να ΞΕΧΩΡΙΖΕΙ το «δεν υπάρχει» από το «δεν μπόρεσα να δω»."""
    st = await cl.get(f"{API}/server_types?per_page=80", headers=h)
    lc = await cl.get(f"{API}/locations", headers=h)
    if st.status_code != 200 or lc.status_code != 200:
        raise HetznerUnavailable(f"server_types {st.status_code} · locations {lc.status_code}")
    types = st.json().get("server_types")
    locs = lc.json().get("locations")
    if not isinstance(types, list) or not isinstance(locs, list) or not types:
        raise HetznerUnavailable("unexpected response shape")
    if not any(isinstance(t.get("locations"), list) for t in types):
        raise HetznerUnavailable("server_types without locations[] — API changed again")
    return types, {lo["name"]: lo for lo in locs if lo.get("name")}


def available_in(server_type: dict | None) -> list[str]:
    """Τοποθεσίες όπου ο τύπος παραγγέλνεται ΤΩΡΑ."""
    if not server_type:
        return []
    return sorted(lo["name"] for lo in (server_type.get("locations") or [])
                  if lo.get("available") and lo.get("name"))
