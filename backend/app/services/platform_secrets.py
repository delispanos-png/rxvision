"""Envelope-encryption for platform-level secrets stored in `platform_settings`.

These docs hold the platform's crown-jewel credentials — Anthropic / Revolut / Apifon / ΑΑΔΕ / SMTP /
ΗΔΥΚΑ-integrator keys and the Hetzner/Cloudflare/storage tokens. Storing them plaintext in Mongo means
a DB or backup leak yields payment + infra + LLM takeover at once. We encrypt the sensitive FIELDS
at rest with Fernet (AES-128-CBC + HMAC).

Design goals:
  • Backward-compatible: `pdec` passes any non-`enc:v1:` value through unchanged, so legacy plaintext
    keeps working until the one-time migration (or the next admin save) re-encrypts it. A read site
    that hasn't been updated therefore never breaks — it just sees plaintext until migrated.
  • Idempotent: `penc` skips a value that is already encrypted.
  • ΚΛΕΙΔΙ (2 εκδόσεις — έλεγχος ασφαλείας 2026-09):
      v2 «enc:v2:» → ΑΝΕΞΑΡΤΗΤΟ κλειδί `SECRETS_ENCRYPTION_KEY`. ΠΡΟΤΙΜΩΜΕΝΟ: διαρροή του JWT_SECRET
        (κλειδί ΥΠΟΓΡΑΦΗΣ token) δεν αποκρυπτογραφεί πλέον ΚΑΙ όλα τα credentials πληρωμών/υποδομής,
        και η περιστροφή του JWT_SECRET δεν απαιτεί re-encryption.
      v1 «enc:v1:» → legacy κλειδί παραγόμενο από το JWT_SECRET. Εξακολουθεί να ΔΙΑΒΑΖΕΤΑΙ.
    Όσο το `SECRETS_ENCRYPTION_KEY` είναι κενό, η συμπεριφορά είναι ΑΚΡΙΒΩΣ η παλιά (γράφει v1).
    Μόλις οριστεί: νέες εγγραφές v2, παλιές v1 διαβάζονται κανονικά → μηδέν κίνδυνος lockout.
    Μετάβαση: `python3 scripts/ops/migrate_secrets_kek.py` (re-encrypt v1 → v2).
    ΠΡΟΣΟΧΗ: το ίδιο σχήμα ΠΡΕΠΕΙ να καθρεφτίζεται στο `infra/scripts/rxsecret.py` (το χρησιμοποιούν
    mongo-backup / restore-backup / provision-app-node / ops-agent / adopt-node για τα `cloud` μυστικά).
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

_PREFIX = "enc:v1:"        # legacy: κλειδί ΠΑΡΑΓΟΜΕΝΟ από το JWT_SECRET
_PREFIX_V2 = "enc:v2:"     # νέο: ΑΝΕΞΑΡΤΗΤΟ κλειδί (settings.SECRETS_ENCRYPTION_KEY)

# Which fields of each platform_settings doc are secrets to encrypt at rest.
SECRET_FIELDS: dict[str, tuple[str, ...]] = {
    "anthropic": ("api_key",),
    "revolut": ("api_key", "webhook_secret"),
    "viva": ("api_key", "client_secret"),
    "softone": ("password",),
    "comms": ("apifon_token", "apifon_secret", "apifon_sms_token", "apifon_sms_secret"),
    "aade": ("password",),
    "smtp": ("password", "pass"),
    # `cloud` (Hetzner/Cloudflare/storage) IS read by bash tooling (mongo-backup/provision/ops-agent), but
    # those decrypt via infra/scripts/rxsecret.py (same Fernet key, derived from JWT_SECRET in .env).
    "cloud": ("hetzner_token", "cloudflare_token", "storage_password"),
}

# `idika` (ΗΔΥΚΑ integrator key) has a NESTED structure: secrets live under test/production sub-docs.
_IDIKA_ENVS = ("test", "production")
_IDIKA_SUBFIELDS = ("api_key", "integrator_password")


def _fernet() -> Fernet:
    """v1 — κλειδί ΠΑΡΑΓΟΜΕΝΟ από το JWT_SECRET (legacy· διατηρείται για ανάγνωση παλιών τιμών)."""
    key = base64.urlsafe_b64encode(
        hashlib.sha256(("rxvision-platform-secrets:" + settings.JWT_SECRET).encode()).digest())
    return Fernet(key)


def _fernet_v2() -> Fernet | None:
    """v2 — ΑΝΕΞΑΡΤΗΤΟ κλειδί. None αν δεν έχει προβλεφθεί (τότε παραμένουμε στο v1)."""
    raw = (settings.SECRETS_ENCRYPTION_KEY or "").strip()
    if not raw:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(("rxvision-secrets-kek:" + raw).encode()).digest())
    return Fernet(key)


def penc(value):
    """Encrypt a secret value (str). None/empty and already-encrypted values pass through.
    Γράφει v2 όταν υπάρχει ανεξάρτητο κλειδί, αλλιώς v1 (καμία αλλαγή συμπεριφοράς)."""
    if not isinstance(value, str) or value == "" or value.startswith((_PREFIX, _PREFIX_V2)):
        return value
    f2 = _fernet_v2()
    if f2 is not None:
        return _PREFIX_V2 + f2.encrypt(value.encode()).decode()
    return _PREFIX + _fernet().encrypt(value.encode()).decode()


def pdec(value):
    """Decrypt a secret value. Δέχεται ΚΑΙ v2 ΚΑΙ v1 (καμία διακοπή κατά τη μετάβαση).
    Legacy plaintext (no prefix) / non-str passes through unchanged."""
    if not isinstance(value, str):
        return value
    if value.startswith(_PREFIX_V2):
        f2 = _fernet_v2()
        if f2 is None:
            return value                      # κλειδί δεν είναι διαθέσιμο → μην καταστρέψεις την τιμή
        try:
            return f2.decrypt(value[len(_PREFIX_V2):].encode()).decode()
        except InvalidToken:
            return value
    if not value.startswith(_PREFIX):
        return value
    try:
        return _fernet().decrypt(value[len(_PREFIX):].encode()).decode()
    except InvalidToken:
        return value


def decrypt_doc(doc_id: str, doc: dict | None) -> dict | None:
    """Return `doc` with this doc-id's known secret fields decrypted (in place). Safe on None."""
    if not doc:
        return doc
    for f in SECRET_FIELDS.get(doc_id, ()):  # noqa: SIM118
        if f in doc:
            doc[f] = pdec(doc[f])
    if doc_id == "idika":                       # nested test/production sub-docs
        for env in _IDIKA_ENVS:
            sub = doc.get(env)
            if isinstance(sub, dict):
                for f in _IDIKA_SUBFIELDS:
                    if f in sub:
                        sub[f] = pdec(sub[f])
    return doc


def encrypt_fields(doc_id: str, fields: dict) -> dict:
    """Return `fields` with this doc-id's known secret fields encrypted (in place)."""
    for f in SECRET_FIELDS.get(doc_id, ()):  # noqa: SIM118
        if f in fields:
            fields[f] = penc(fields[f])
    if doc_id == "idika":                       # nested test/production sub-docs
        for env in _IDIKA_ENVS:
            sub = fields.get(env)
            if isinstance(sub, dict):
                for f in _IDIKA_SUBFIELDS:
                    if f in sub:
                        sub[f] = penc(sub[f])
    return fields
