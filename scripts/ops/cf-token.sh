#!/usr/bin/env bash
# Τυπώνει το Cloudflare token από τον ΚΡΥΠΤΟΓΡΑΦΗΜΕΝΟ χώρο μυστικών του adminpanel.
#
# ΓΙΑΤΙ ΥΠΑΡΧΕΙ: το token ζει σε ΕΝΑ σημείο — platform_settings/_id=cloud, κρυπτογραφημένο με
# το «Κλειδί Μυστικών». Αντίγραφο σε .env ή σε script θα ήταν δεύτερη πηγή αλήθειας που
# ξεχνιέται όταν γίνει rotation, και καθαρό κείμενο στον δίσκο.
#
#   CF=$(bash scripts/ops/cf-token.sh)
docker compose -f /opt/rxvision/docker-compose.prod.yml exec -T api python -c "
import asyncio
from app.core.db import shared_db
from app.services.platform_secrets import decrypt_doc
async def m():
    raw = await shared_db()['platform_settings'].find_one({'_id': 'cloud'})
    print((decrypt_doc('cloud', raw) or {}).get('cloudflare_token') or '')
asyncio.run(m())
" 2>/dev/null | tail -1
