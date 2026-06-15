# Phase 1 — Horizontal app nodes behind the Hetzner LB

**Done 2026-06-10.** RxVision now runs **2 app nodes** behind a Hetzner Load Balancer,
sharing one state node. Adding more app nodes is now repeatable (steps below).

## Topology
```
Cloudflare (app.rxvision.gr, proxied)
      │
Hetzner LB  rxvision-lb  65.109.43.125   (TCP 443 passthrough, health-check tcp/443)
      ├── RxVisionSRV01  priv 10.0.0.2   app + Vault + Caddy + (idle local mongo/redis rollback) + beat
      └── RxVisionSRV02  priv 10.0.0.5   app only (api/worker/web/caddy)
                                   │
              RxVisionDB01  priv 10.0.0.3   MongoDB(rs0) + Redis   ← shared state
              Vault → on SRV01, exposed to the private net at 10.0.0.2:8200 via socat proxy
```

## The Vault problem & the fix
Vault is **shamir-sealed** (file storage) and listens HTTP on `vault:8200` inside SRV01's
docker network only. Restarting it to publish a port would **seal** it (needs manual unseal
keys). Instead a **socat proxy** exposes it on the private IP **without touching vault**:
```bash
# on RxVisionSRV01 — zero-touch to the vault container:
docker run -d --name rxvision-vault-proxy --restart unless-stopped \
  --network rxvision_default -p 10.0.0.2:8200:8200 \
  alpine/socat tcp-listen:8200,fork,reuseaddr tcp-connect:vault:8200
```
App nodes set `VAULT_ADDR=http://10.0.0.2:8200`.
*Future:* move Vault onto RxVisionDB01 (true state node) with unseal keys in hand, then drop the proxy.

## Add another app node (RxVisionSRV0N)
1. **Provision** (Hetzner API, token in Admin→Υποδομή/Cloud): ccx13, hel1, image ubuntu-22.04,
   `ssh_keys=[rxvision-data]`, `networks=[12315100]` (auto private IP, no reboot),
   firewall `rxvision-app-fw` (SSH from SRV01 only), cloud-init installs docker. Rename to `RxVisionSRV0N`.
2. **Sync code:** `rsync -az --delete --exclude={.git,node_modules,.next,__pycache__,backups,*.archive.gz,infra/scaling/keys,.env} /opt/rxvision/ root@<node>:/opt/rxvision/`
3. **.env:** copy SRV01's `.env`, set `VAULT_ADDR=http://10.0.0.2:8200` (Mongo/Redis already → 10.0.0.3).
   Identical JWT/pepper secrets are REQUIRED (tokens must validate on any node).
4. **Deploy:** copy `infra/scaling/docker-compose.app.yml` → node `:/opt/rxvision/docker-compose.app.yml`;
   `docker compose -f docker-compose.app.yml build && up -d`.
5. **Verify:** api `/health`, DB read, `vault.get_secret(...)`, and `curl -k --resolve app.rxvision.gr:443:127.0.0.1 https://app.rxvision.gr/health` → 200.
6. **Attach to LB:** `POST /load_balancers/6614941/actions/add_target {type:server, server:{id:<id>}, use_private_ip:true}`; confirm target health → `healthy`.

## Gotchas
- **beat runs ONLY on SRV01** (singleton scheduler) — never add it to an app node.
- App-node `api` runs `reap_orphan_jobs` on boot (deletes 'running' sync_jobs with heartbeat
  >15min). A live backfill has a fresh heartbeat → safe. Don't boot a node while a sync is mid-stall.
- LB uses round-robin; app is stateless (shared DB + same secrets) so no sticky sessions needed.

---

## ⛔ Frontend deploys: build ONCE, distribute (incident 2026-06-13)

NEVER run `docker compose -f docker-compose.app.yml build web` on the app node (SRV02).
Two independent Next.js builds have different chunk hashes; Cloudflare round-robins across
SRV01 + SRV02 origins → a browser gets index.html from one build and a 404 chunk from the
other → app-wide blank "client-side exception".

**Always deploy the web tier with:** `bash infra/scaling/deploy-web.sh`
(builds on SRV01, ships the byte-identical image to SRV02, verifies BUILD_IDs match).
Backend (`api`/`worker`) can still be built per-node — only the frontend has hashed chunks.
