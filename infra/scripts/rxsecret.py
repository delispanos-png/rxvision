#!/usr/bin/env python3
"""Decrypt platform secrets for shell tooling — mirrors backend/app/services/platform_secrets.py so
bash scripts (mongo-backup, restore-backup, provision-app-node, ops-agent) can read encrypted `cloud`
fields from Mongo. Same Fernet key, derived from JWT_SECRET in the repo-root .env.

Usage:
  python3 infra/scripts/rxsecret.py <value> [<value> ...]   # prints each decrypted value, one per line
  echo "<value>" | python3 infra/scripts/rxsecret.py         # decrypts stdin lines
A plaintext (non-`enc:v1:`) value passes through unchanged.
"""
import base64
import hashlib
import os
import sys

from cryptography.fernet import Fernet, InvalidToken

_PREFIX = "enc:v1:"        # legacy: κλειδί παραγόμενο από JWT_SECRET
_PREFIX_V2 = "enc:v2:"     # νέο: ανεξάρτητο SECRETS_ENCRYPTION_KEY


def _env(name: str) -> str:
    """Διάβασε μεταβλητή από το repo-root .env (ή το περιβάλλον, αν υπάρχει)."""
    if os.environ.get(name):
        return os.environ[name]
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
    try:
        with open(env_path) as f:
            for line in f:
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _key_v1() -> bytes:
    return base64.urlsafe_b64encode(
        hashlib.sha256(("rxvision-platform-secrets:" + _env("JWT_SECRET")).encode()).digest())


def _key_v2() -> bytes | None:
    raw = _env("SECRETS_ENCRYPTION_KEY").strip()
    if not raw:
        return None
    return base64.urlsafe_b64encode(hashlib.sha256(("rxvision-secrets-kek:" + raw).encode()).digest())


def pdec(value: str) -> str:
    """Δέχεται ΚΑΙ v2 ΚΑΙ v1 — καθρέφτης του backend/app/services/platform_secrets.py."""
    if not isinstance(value, str):
        return value
    if value.startswith(_PREFIX_V2):
        k2 = _key_v2()
        if k2 is None:
            return value
        try:
            return Fernet(k2).decrypt(value[len(_PREFIX_V2):].encode()).decode()
        except InvalidToken:
            return value
    if not value.startswith(_PREFIX):
        return value
    try:
        return Fernet(_key_v1()).decrypt(value[len(_PREFIX):].encode()).decode()
    except InvalidToken:
        return value


if __name__ == "__main__":
    args = sys.argv[1:]
    if args:
        for a in args:
            print(pdec(a))
    else:
        for line in sys.stdin:
            print(pdec(line.rstrip("\n")))
