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

_PREFIX = "enc:v1:"


def _jwt_secret() -> str:
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")
    try:
        with open(env_path) as f:
            for line in f:
                if line.startswith("JWT_SECRET="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def pdec(value: str) -> str:
    if not isinstance(value, str) or not value.startswith(_PREFIX):
        return value
    key = base64.urlsafe_b64encode(
        hashlib.sha256(("rxvision-platform-secrets:" + _jwt_secret()).encode()).digest())
    try:
        return Fernet(key).decrypt(value[len(_PREFIX):].encode()).decode()
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
