"""Κλειδιά API συνεργατών — έκδοση, επαλήθευση, δικαιώματα.

ΑΡΧΕΣ ΑΣΦΑΛΕΙΑΣ (μην τις χαλαρώσεις):

1. **Το κλειδί φαίνεται ΜΙΑ φορά.** Αποθηκεύεται μόνο το hash του, όπως ο κωδικός χρήστη.
   Χαμένο κλειδί δεν «ανακτάται» — εκδίδεται νέο και ανακαλείται το παλιό.
2. **Κάθε κλειδί ανήκει σε ΕΝΑ φαρμακείο.** Το `tenant_id` έρχεται ΠΑΝΤΑ από το κλειδί, ποτέ
   από το αίτημα. Έτσι δεν υπάρχει διαδρομή όπου ο συνεργάτης δηλώνει ποιανού δεδομένα θέλει.
3. **Δικαιώματα (scopes) ανά κλειδί.** Το πρόγραμμα που ενημερώνει απόθεμα δεν χρειάζεται —
   και δεν πρέπει να έχει — πρόσβαση σε δεδομένα ασθενών.
4. **Το πρόθεμα είναι ορατό, το μυστικό όχι.** Κρατάμε `prefix` (π.χ. `rxv_live_a1b2`) ώστε ο
   πελάτης να ξεχωρίζει ποιο κλειδί ανακαλεί, χωρίς να αποθηκεύουμε το μυστικό.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

COLLECTION = "api_keys"
PREFIX_LIVE = "rxv_live_"

#: Τι επιτρέπει το καθένα. Κράτα τα ΛΙΓΑ και ΣΑΦΗ — ένα scope που κανείς δεν καταλαβαίνει
#: καταλήγει να δίνεται «για σιγουριά» και ακυρώνει τον σκοπό του.
SCOPES: dict[str, str] = {
    "products:read": "Ανάγνωση καταλόγου ειδών και τιμών",
    "stock:read": "Ανάγνωση αποθέματος",
    "stock:write": "Ενημέρωση αποθέματος (παραλαβές, πωλήσεις, απογραφή)",
    "prescriptions:read": "Ανάγνωση εκτελέσεων συνταγών (χωρίς στοιχεία ταυτότητας ασθενή)",
    "patients:read": "Ανάγνωση ασθενών — ΠΕΡΙΕΧΕΙ ΔΕΔΟΜΕΝΑ ΥΓΕΙΑΣ",
    "orders:read": "Ανάγνωση παραγγελιών e-shop",
    "orders:write": "Αλλαγή κατάστασης παραγγελίας",
    "sales:write": "Αποστολή πωλήσεων ταμείου (ΜΗ.ΣΥ.ΦΑ., παραφάρμακα, υπηρεσίες)",
    "sales:read": "Ανάγνωση πωλήσεων ταμείου",
    "loyalty:read": "Ανάγνωση προγράμματος επιβράβευσης (υπόλοιπα, δώρα)",
    "loyalty:write": "Εγγραφή μελών και εξαργύρωση πόντων από το ταμείο",
    "clinical:read": "Έλεγχος αλληλεπιδράσεων & συμβουλές PharmaCat",
}

#: Scopes που αγγίζουν δεδομένα υγείας/ταυτότητας. Δίνονται μόνο με ρητή επιλογή και
#: καταγράφονται ξεχωριστά — ο φαρμακοποιός είναι ο υπεύθυνος επεξεργασίας.
SENSITIVE_SCOPES = {"patients:read"}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _aware(v: datetime) -> datetime:
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _hash(raw: str) -> str:
    """SHA-256 αντί bcrypt: το κλειδί είναι 256-bit τυχαίο, όχι κωδικός ανθρώπου.
    Δεν χρειάζεται (ούτε αντέχει σε κάθε αίτημα) αργό KDF."""
    return hashlib.sha256(raw.encode()).hexdigest()


def generate() -> tuple[str, str, str]:
    """(πλήρες κλειδί, πρόθεμα για εμφάνιση, hash για αποθήκευση)."""
    raw = PREFIX_LIVE + secrets.token_urlsafe(32)
    return raw, raw[: len(PREFIX_LIVE) + 4], _hash(raw)


#: Μέγιστη διάρκεια ζωής κλειδιού. Κλειδί που δεν λήγει ΠΟΤΕ είναι κλειδί που κανείς δεν
#: θυμάται ότι υπάρχει — και μένει ενεργό χρόνια μετά την αποχώρηση του προγραμματιστή.
MAX_TTL_DAYS = 365
DEFAULT_TTL_DAYS = 180


async def create(tenant_id: str, *, name: str, scopes: list[str],
                 by: str | None = None, ttl_days: int = DEFAULT_TTL_DAYS,
                 ip_allowlist: list[str] | None = None,
                 gdpr_ack: bool = False) -> dict:
    """Εκδίδει κλειδί. Επιστρέφει το ΠΛΗΡΕΣ κλειδί — η μόνη φορά που είναι ορατό."""
    bad = [s for s in scopes if s not in SCOPES]
    if bad:
        raise ValueError(f"unknown_scope:{','.join(bad)}")
    # ΔΕΔΟΜΕΝΑ ΥΓΕΙΑΣ: ο φαρμακοποιός είναι ο υπεύθυνος επεξεργασίας. Δεν του δίνουμε τρόπο να
    # παραχωρήσει πρόσβαση σε στοιχεία ασθενών «κατά λάθος» — απαιτείται ρητή δήλωση.
    if set(scopes) & SENSITIVE_SCOPES and not gdpr_ack:
        raise ValueError("gdpr_ack_required")
    ttl = max(1, min(int(ttl_days or DEFAULT_TTL_DAYS), MAX_TTL_DAYS))
    raw, prefix, h = generate()
    doc = {
        "tenant_id": tenant_id,
        "name": (name or "").strip()[:60] or "API key",
        "prefix": prefix,
        "key_hash": h,
        "scopes": sorted(set(scopes)),
        "ip_allowlist": [x.strip() for x in (ip_allowlist or []) if x.strip()][:10],
        "gdpr_ack": bool(gdpr_ack),
        "created_at": _now(),
        "expires_at": _now() + timedelta(days=ttl),
        "created_by": by,
        "last_used_at": None,
        "last_used_ip": None,
        "calls": 0,
        "revoked_at": None,
        "revoked_by": None,
    }
    res = await shared_db()[COLLECTION].insert_one(doc)
    return {"id": str(res.inserted_id), "key": raw, "prefix": prefix,
            "name": doc["name"], "scopes": doc["scopes"]}


def _ip_ok(allow: list[str], ip: str | None) -> bool:
    """Λίστα επιτρεπόμενων IP. Κενή λίστα = χωρίς περιορισμό (αλλά το λέμε στον πελάτη)."""
    if not allow:
        return True
    if not ip:
        return False
    import ipaddress
    for entry in allow:
        try:
            if "/" in entry:
                if ipaddress.ip_address(ip) in ipaddress.ip_network(entry, strict=False):
                    return True
            elif ipaddress.ip_address(ip) == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


async def verify(raw: str, *, ip: str | None = None) -> tuple[dict | None, str]:
    """(εγγραφή, λόγος απόρριψης). Ο λόγος επιστρέφεται ώστε το μήνυμα να λέει ΤΙ φταίει."""
    if not raw or not raw.startswith(PREFIX_LIVE):
        return None, "malformed"
    h = _hash(raw)
    doc = await shared_db()[COLLECTION].find_one({"key_hash": h})
    if not doc or not hmac.compare_digest(doc.get("key_hash", ""), h):
        return None, "unknown"
    if doc.get("revoked_at"):
        return None, "revoked"
    exp = doc.get("expires_at")
    if exp and _aware(exp) <= _now():
        return None, "expired"
    if not _ip_ok(doc.get("ip_allowlist") or [], ip):
        return None, "ip_blocked"
    return doc, "ok"


async def touch(key_id, ip: str | None = None) -> None:
    """Σημειώνει χρήση — ώστε ο πελάτης να βλέπει ποιο κλειδί δουλεύει και ποιο ξεχάστηκε."""
    try:
        await shared_db()[COLLECTION].update_one(
            {"_id": key_id},
            {"$set": {"last_used_at": _now(), "last_used_ip": ip},
             "$inc": {"calls": 1}})
    except Exception:  # noqa: BLE001 — η μέτρηση δεν πρέπει ΠΟΤΕ να ρίξει αίτημα
        pass


async def list_for(tenant_id: str) -> list[dict]:
    out = []
    async for d in shared_db()[COLLECTION].find({"tenant_id": tenant_id}).sort("created_at", -1):
        exp = d.get("expires_at")
        out.append({"id": str(d["_id"]), "name": d.get("name"), "prefix": d.get("prefix"),
                    "scopes": d.get("scopes") or [], "created_at": d.get("created_at"),
                    "expires_at": exp, "last_used_at": d.get("last_used_at"),
                    "last_used_ip": d.get("last_used_ip"), "calls": d.get("calls", 0),
                    "ip_allowlist": d.get("ip_allowlist") or [],
                    "sensitive": bool(set(d.get("scopes") or []) & SENSITIVE_SCOPES),
                    "expired": bool(exp and _aware(exp) <= _now()),
                    "revoked": bool(d.get("revoked_at"))})
    return out


async def revoke(tenant_id: str, key_id) -> bool:
    from bson import ObjectId
    try:
        oid = ObjectId(str(key_id))
    except Exception:  # noqa: BLE001
        return False
    res = await shared_db()[COLLECTION].update_one(
        {"_id": oid, "tenant_id": tenant_id, "revoked_at": None},
        {"$set": {"revoked_at": _now()}})
    return res.modified_count > 0
