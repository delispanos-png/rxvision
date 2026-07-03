# RxVision — Infrastructure Hardening Plan

Phased, effort-estimated plan to close the open items in `SECURITY_REPORT.md` **without breaking existing
functionality**. Ordered by risk-reduction per hour. Scope: platform/infra only.

Legend — effort: **S** ≤1h · **M** ≤½day · **L** ≥1day. Risk: what an attacker can do until it's fixed.

---

## Phase 0 — MUST close before Internet exposure (blocks go-live)

### 0.1 — Lock the origin to Cloudflare  · **C-1** · effort **M** · risk: full edge bypass
1. Remove the plaintext preview site from `infra/docker/Caddyfile`:
   delete the `http://localhost, http://157.180.26.98 { import api_and_app }` block.
2. Create a **Hetzner Cloud Firewall** on all three nodes' public NICs:
   - inbound `443/tcp` **from Cloudflare IPv4+IPv6 ranges only** (https://www.cloudflare.com/ips/)
   - inbound `80/tcp` from Cloudflare (ACME/redirect) — then Caddy redirects to 443
   - inbound `22/tcp` from admin IP(s) only
   - default deny inbound; leave the private `10.0.0.0/16` untouched (internal traffic).
3. Enable trusted origin TLS: set `CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}` + `CF_API_TOKEN` in `.env`,
   rebuild Caddy from `infra/docker/Caddy.Dockerfile` (has the cloudflare-dns plugin), `--force-recreate caddy`.
4. Verify: `curl http://157.180.26.98` and `curl https://157.180.26.98` from an off-Cloudflare host both
   **time out**; the domains still serve normally through Cloudflare.

### 0.2 — Stop trusting client-supplied `CF-Connecting-IP`  · **C-2** · effort **S** · risk: brute-force bypass
1. In `Caddyfile`, mark Cloudflare as a trusted proxy and set a verified real-IP header, e.g.:
   `servers { trusted_proxies static <cloudflare-ranges> }` and let Caddy populate `X-Forwarded-For`
   from the CF header only when the peer is trusted.
2. Change `backend/app/core/ratelimit.py::_client_ip` and `middleware/audit.py` to read the
   **Caddy-verified** client IP (right-most trusted `X-Forwarded-For`, or a header Caddy sets), never a raw
   inbound `CF-Connecting-IP`. Fall back to the socket peer.
3. Verify: spoofed `CF-Connecting-IP` no longer rotates the `rl:*` key (lockout trips after 8 tries regardless
   of the header).

> 0.1 + 0.2 are interdependent: 0.1 removes the direct path, 0.2 removes the residual header-spoof even if a
> path is found. Ship together.

### 0.3 — Encrypt offsite backups + pin host key  · **H-2** · effort **M** · risk: full-DB theft off-box
1. In `infra/scripts/mongo-backup.sh`, pipe the dump through `age -r <recipient>` (or `gpg -e`) **before**
   SFTP; keep the key only on the origin / in Vault.
2. Replace `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` with a pinned
   `known_hosts` entry for the storage box.
3. Replace `sshpass -p "$SB_PW"` with `sshpass -f <file>` (0600) or an SSH key.
4. Run a **restore drill**: pull an encrypted archive, decrypt, `mongorestore` into a scratch DB, verify counts.

### 0.4 — Add a Content-Security-Policy  · **H-1** · effort **M** · risk: XSS → token theft
1. Add `frontend/src/middleware.ts` that generates a per-request nonce, sets it on the response, and exposes it
   to the app (Next.js `headers()` / `nonce` on scripts).
2. In `Caddyfile (security_headers)` add CSP **Report-Only** first:
   `default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'; connect-src 'self';
   img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`.
   Add `Permissions-Policy: camera=(self), geolocation=(self), microphone=()`.
3. Watch `report-uri` for a few days, then flip Report-Only → enforced.

---

## Phase 1 — Close within the first hardening sprint (HIGH)

### 1.1 — Vault over HTTPS from app nodes  · **H-3** · effort **M**
Set SRV-node `VAULT_ADDR=https://10.0.0.2:8200` (or `https://vault:…`), ship `vault.crt` + `VAULT_CACERT`, and
make the socat hop TLS (or remove it in favour of direct TLS). No Vault restart. Verify `vault status` over TLS
from an app node.

### 1.2 — Request-size caps + edge rate limiting  · **H-4** · effort **M**
- Caddy: `request_body { max_size 10MB }` globally; a `handle /api/*/upload*` override at the real upload cap.
- Cloudflare: rate-limit rules on `/api/*/auth/*` and anonymous bursts; enable managed challenge for bots.
- FastAPI: optional `ASGI` body-size middleware as belt-and-suspenders.

### 1.3 — Supply-chain pinning + scanning  · **H-5** · effort **L**
- `uv pip compile pyproject.toml -o requirements.lock` (hash-pinned); Dockerfile `pip install --require-hashes
  -r requirements.lock`.
- Pin base images by digest: `python:3.12-slim@sha256:…`, `node:20-alpine@sha256:…`, `mongo:7@sha256:…`,
  `redis:7-alpine@sha256:…`, `caddy:2-alpine@sha256:…`.
- CI: add Trivy (image + fs), `pip-audit`, `npm audit --production`, Syft SBOM, and a `gitleaks` gate; fail on
  HIGH/CRITICAL CVEs.

---

## Phase 2 — Defense-in-depth & hygiene (MEDIUM/LOW)

- **2.1 Refresh rotation** (M-1): TTL 7–14d, one-time-use refresh with reuse-detection bound to `sid`.
- **2.2 Boot asserts** (M-2): distinct JWT secrets + `VAULT_ADDR` https in `assert_production_secrets`. **S**
- **2.3 `/health` slimming** (M-3): drop version/uptime from the public probe. **S**
- **2.4 VAPID → Vault** (M-4). **S**
- **2.5 `.dockerignore`** (M-5) + container hardening: `read_only: true`, `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`, tmpfs for `/tmp` on `api`/`web`/`worker`/`caddy`. **M**
- **2.6 Portainer** (M-6): docker-socket-proxy or remove from prod. **M**
- **2.7 Upload hardening**: magic-number sniff + optional ClamAV hook. **M**
- **2.8 Encrypt `cloud`/`idika` secrets**: give the bash tooling (`mongo-backup.sh`, `provision-app-node.sh`,
  `ops-agent.sh`) a decrypt helper (age/gpg with the origin key) so these can move off plaintext too. **M**
- **2.9 Misc**: `poweredByHeader:false` (L-3), `python-jose>=3.4` (L-1), SRV worker `--max-tasks-per-child` (L-5),
  Vault `mlock` review (L-2).

---

## Monitoring (M-7) — design to build alongside Phase 1

- **Auth-abuse watcher** (`workers/security_monitor.py`, Celery-beat every 1–5 min): scan `audit_logs` for
  failed-login velocity per account/IP, refresh-anomaly patterns, and 401/403 bursts → webhook alert
  (Slack/email) + optional auto-extend lockout.
- **Edge**: Cloudflare WAF + Security Analytics as the first line (bot scores, rate rules, country/ASN); review
  weekly. Ship Caddy access logs (JSON) off-box for scan/DoS pattern detection.
- **Infra health**: alert on container restarts, worker crash loops, Redis/Mongo down, backup `ok:false`,
  cert expiry, disk > 85% (fields already in `backup_status`/node metrics).
- **What must never be logged** (enforced): passwords, tokens, API keys, Vault token, secrets — keep audit
  records to method+path+actor+ip+status only (already the case).

---

## Sequencing summary

```
Go-live blockers : 0.1 → 0.2 (together) → 0.3 → 0.4
Sprint 1 (HIGH)  : 1.1 · 1.2 · 1.3     + Monitoring bootstrap (M-7)
Sprint 2 (M/L)   : 2.1 … 2.9
```
Each change is config- or additive-code-level; none alters business logic or data, so functionality is
preserved. Deploy backend via the standard prod flow (MGMT `--force-recreate --no-deps <svc>` + SRV rsync +
rebuild); Caddy changes require `--force-recreate caddy` (single-file bind-mount inode gotcha).
