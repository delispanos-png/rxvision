#!/usr/bin/env python3
"""Μετάβαση αποθηκευμένων μυστικών από v1 (κλειδί παραγόμενο από JWT_SECRET) → v2 (ανεξάρτητο KEK).

ΓΙΑΤΙ (έλεγχος ασφαλείας 2026-09, εύρημα M6): το κλειδί που κρυπτογραφεί ΟΛΑ τα credentials
(Anthropic/Revolut/Viva/Apifon/ΑΑΔΕ/SMTP/Hetzner/Cloudflare/Profarm/ΗΔΥΚΑ-integrator) παραγόταν από το
JWT_SECRET. Διαρροή του κλειδιού ΥΠΟΓΡΑΦΗΣ token σήμαινε ταυτόχρονα αποκρυπτογράφηση όλων των μυστικών.

ΠΡΟΫΠΟΘΕΣΗ: όρισε `SECRETS_ENCRYPTION_KEY` (τυχαίο, ≥32 χαρακτήρες) στο .env ΚΑΙ κράτησέ το ΚΑΙ στο
Vault/password manager. ΜΗΝ το χάσεις — χωρίς αυτό τα «enc:v2:» δεν αποκρυπτογραφούνται.
  python3 -c "import secrets; print(secrets.token_urlsafe(48))"

ΧΡΗΣΗ (μέσα στο api container):
  python3 scripts/ops/migrate_secrets_kek.py --dry-run    # τι θα άλλαζε
  python3 scripts/ops/migrate_secrets_kek.py              # εκτέλεση

ΑΣΦΑΛΕΙΑ: ιδεμποτεντικό (ό,τι είναι ήδη v2 παραλείπεται) & μη-καταστροφικό (γράφει μόνο αν η
αποκρυπτογράφηση v1 πέτυχε — αν αποτύχει, η τιμή μένει ΑΚΡΙΒΩΣ ως έχει).
ΜΕΤΑ: κράτα το JWT_SECRET ως έχει μέχρι να επιβεβαιώσεις ότι όλα δουλεύουν (τα v1 δεν διαβάζονται πια
μετά τη μετάβαση, αλλά το rollback χρειάζεται το παλιό κλειδί).
"""
from __future__ import annotations

import asyncio
import sys


async def main() -> int:
    dry = "--dry-run" in sys.argv
    from app.core.config import settings
    from app.core.db import shared_db
    from app.services.platform_secrets import (
        _IDIKA_ENVS, _IDIKA_SUBFIELDS, _PREFIX, _PREFIX_V2, SECRET_FIELDS, pdec, penc,
    )

    if not (settings.SECRETS_ENCRYPTION_KEY or "").strip():
        print("❌ Δεν έχει οριστεί SECRETS_ENCRYPTION_KEY — όρισέ το πρώτα στο .env (και κράτα αντίγραφο!).")
        return 1

    db = shared_db()
    changed = skipped = failed = 0

    def convert(val):
        """v1 → v2. Επιστρέφει (νέα_τιμή, κατάσταση)."""
        nonlocal changed, skipped, failed
        if not isinstance(val, str) or not val.startswith(_PREFIX):
            if isinstance(val, str) and val.startswith(_PREFIX_V2):
                skipped += 1
            return val, "skip"
        plain = pdec(val)
        if plain == val:                      # αποκρυπτογράφηση απέτυχε → ΜΗΝ αγγίξεις
            failed += 1
            return val, "fail"
        new = penc(plain)
        if not new.startswith(_PREFIX_V2):    # δικλείδα: πρέπει να βγήκε v2
            failed += 1
            return val, "fail"
        changed += 1
        return new, "ok"

    # ── platform_settings (γνωστά πεδία ανά doc) ───────────────────────────────
    for doc_id, fields in SECRET_FIELDS.items():
        doc = await db["platform_settings"].find_one({"_id": doc_id})   # tenant-ok: platform-global
        if not doc:
            continue
        upd = {}
        for f in fields:
            if f in doc:
                new, st = convert(doc[f])
                if st == "ok":
                    upd[f] = new
                    print(f"  platform_settings/{doc_id}.{f}: v1 → v2")
        if upd and not dry:
            await db["platform_settings"].update_one({"_id": doc_id}, {"$set": upd})

    # ── idika (εμφωλευμένα test/production) ───────────────────────────────────
    doc = await db["platform_settings"].find_one({"_id": "idika"})      # tenant-ok: platform-global
    if doc:
        upd = {}
        for env in _IDIKA_ENVS:
            sub = doc.get(env)
            if isinstance(sub, dict):
                for f in _IDIKA_SUBFIELDS:
                    if f in sub:
                        new, st = convert(sub[f])
                        if st == "ok":
                            upd[f"{env}.{f}"] = new
                            print(f"  platform_settings/idika.{env}.{f}: v1 → v2")
        if upd and not dry:
            await db["platform_settings"].update_one({"_id": "idika"}, {"$set": upd})

    # ── supplier_settings (κωδικοί προμηθευτών ανά φαρμακείο) ─────────────────
    async for s in db["supplier_settings"].find({"password": {"$nin": [None, ""]}}):  # tenant-ok: όλοι
        new, st = convert(s.get("password"))
        if st == "ok":
            print(f"  supplier_settings[{s.get('tenant_id')}/{s.get('key')}].password: v1 → v2")
            if not dry:
                await db["supplier_settings"].update_one({"_id": s["_id"]}, {"$set": {"password": new}})

    print(f"\n{'[DRY-RUN] ' if dry else ''}μετατράπηκαν: {changed} · ήδη v2: {skipped} · αποτυχίες: {failed}")
    if failed:
        print("⚠️ Κάποιες τιμές ΔΕΝ αποκρυπτογραφήθηκαν με το v1 κλειδί — έμειναν ανέπαφες. Έλεγξε το JWT_SECRET.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
