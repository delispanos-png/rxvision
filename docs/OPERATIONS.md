# RxVision — Operations (live server)

Live on Hetzner server `157.180.26.98`. Stack: Docker Compose (`docker-compose.prod.yml`).

## Current status
- **Domain:** `rxvision.gr` (Cloudflare). DNS records `app` + `adminpanel` → server (proxied).
- **Zone status:** `pending` until the registrar nameservers point to Cloudflare
  (`eric.ns.cloudflare.com`, `zelda.ns.cloudflare.com`). Until then the domains do not
  resolve publicly; the stack is fully up and reachable on the server.
- **TLS:** `CADDY_TLS=internal` (self-signed origin). Works behind Cloudflare in **Full**
  SSL mode. After NS cutover, switch to Let's Encrypt (see below).

## Demo login
- URL (after NS cutover): https://app.rxvision.gr
- Back-office: https://adminpanel.rxvision.gr
- Credentials are set via env (`SEED_DEMO_EMAIL`/`SEED_DEMO_PASSWORD`,
  `SEED_PADMIN_EMAIL`/`SEED_PADMIN_PASSWORD`) and printed by `seed.py`. **Change immediately.**

## Day-to-day (use the Makefile)
```bash
cd /opt/rxvision
make            # list targets
make ps         # status
make logs svc=api
make deploy     # rebuild + restart api & web after code changes
make seed       # (re)seed demo data
make smoke      # full-stack regression (login + every endpoint + web routes)
make test       # backend invariant tests
make backup     # one-off Mongo backup
make unseal     # unseal Vault after a restart
```

## Resilience (installed)
- **Auto-start on boot:** systemd `rxvision.service` runs `docker compose up -d` and then
  auto-unseals Vault (`infra/scripts/vault-autounseal.sh`). Containers also carry
  `restart: unless-stopped`. Enable/disable: `systemctl enable|disable rxvision`.
- **Vault auto-unseal:** on boot the unit unseals using `secrets/vault-init.json`. This
  trades some security for uptime (key sits on disk) — move to KMS auto-unseal for prod.
- **Nightly Mongo backup:** `/etc/cron.d/rxvision-backup` runs `infra/scripts/mongo-backup.sh`
  at 03:30 → gzip archives in `backups/` (last 14 kept). Restore:
  `docker exec -i rxvision-mongo-1 mongorestore --archive --gzip --drop < backups/<file>`.

## Re-seed demo data
```bash
docker compose -f docker-compose.prod.yml run --rm -e PYTHONPATH=/app api python scripts/seed.py
```

## Vault (IMPORTANT)
Single-node Vault starts **sealed** after any restart/reboot. Unseal:
```bash
bash infra/scripts/vault-unseal.sh
```
- Init keys & root token: `secrets/vault-init.json` (chmod 600, **never commit / back up securely**).
- The API degrades gracefully to env-based secrets while Vault is sealed, but tenant
  ΗΔΙΚΑ/ΓΕΣΥ credentials are only available once unsealed.
- **Production hardening:** move to auto-unseal (cloud KMS / Vault transit) so no on-disk
  unseal key is needed.

## Preview access (before DNS is live)
- App: **http://157.180.26.98/** · Adminpanel: **/admin** · login = the demo credentials printed by `seed.py`
- Self-service signup: **/register** (creates a tenant + 14-day trial; country GR→ΗΔΙΚΑ / CY→ΓΕΣΥ)
- Docker UI (Portainer): **http://157.180.26.98:9000**
- Plain HTTP preview block lives in `infra/docker/Caddyfile` — remove it once domains are live.

## Going fully live with public TLS (after NS cutover)
1. Point the `.gr` registrar nameservers to Cloudflare; wait for zone `active`.
2. In Cloudflare set SSL/TLS mode to **Full**.
3. One step (custom Caddy with caddy-dns/cloudflare is already verified to build):
   ```
   bash infra/scripts/enable-public-tls.sh <CLOUDFLARE_API_TOKEN>
   ```
   This sets `CADDY_TLS`/`CF_API_TOKEN` in `.env` and brings up Caddy with the DNS-01
   overlay (`infra/compose.tls.yml`).

## Security follow-ups (tracked)
- Rotate the Cloudflare API tokens shared in chat.
- Remove `typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` in `frontend/next.config.js`
  once `npm run typecheck` is clean.
- Change the demo owner password; disable the demo tenant before real onboarding.
- Add MFA enforcement, rate-limit middleware wiring, and backups (mongo dump cron).
