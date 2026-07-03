# RxVision — Platform Security Checklist

`[x]` = in place & verified · `[~]` = partial / needs config · `[ ]` = open. IDs map to `SECURITY_REPORT.md`.
Business RBAC / medical workflows are **out of scope**.

## Network & Edge
- [x] Servers firewalled (Hetzner): MGMT 443←Cloudflare-only + 22←admin; DB01/SRV01 22←private-only, public 443 denied — **C-1**
- [x] LB bypass (`65.109.43.125:443`) CLOSED via Cloudflare secret header (Transform Rule `X-Origin-Auth`) + Caddy 403-if-missing; verified both nodes (no-secret→403, correct→200) — **C-1**
- [x] Removed the `http://157.180.26.98` / `http://localhost` plaintext preview block from Caddyfile — **C-1**
- [ ] SSH (`22`) restricted to admin IPs; all other inbound dropped at host firewall — **C-1**
- [ ] Real end-to-end TLS (`CADDY_TLS=dns cloudflare …`), `:80`→`:443` redirect — **C-1**
- [x] Private datastores bound to `10.0.0.x` only (Mongo) / no host port (Redis)
- [x] `api`/`web` use `expose` (no host publish); only Caddy publishes 80/443
- [x] Portainer bound to `127.0.0.1` (SSH-tunnel only) — [~] add socket-proxy / strong pw — **M-6**
- [ ] Cloudflare: WAF managed rules ON, bot-fight/managed-challenge, rate-limit rules, "Under Attack" playbook

## TLS / HTTP Security Headers
- [x] HSTS (`max-age=31536000; includeSubDomains`)
- [x] HSTS `preload` directive added (submit to hstspreload.org to activate)
- [x] `X-Content-Type-Options: nosniff`
- [x] `X-Frame-Options: DENY`
- [x] `Referrer-Policy: strict-origin-when-cross-origin`
- [x] `Server` header stripped
- [x] **Content-Security-Policy** ENFORCED (route α: self+inline scripts, no external scripts, connect/img/frame locked); collector-verified 0 violations — **H-1**
- [x] `Permissions-Policy` (camera/geo self, mic/payment/usb/cohort off) — **H-1**
- [x] Self-host Inter font (next/font/google, build-time) → dropped Google-Fonts CSP exception + Google IP leak; CSP now fully same-origin
- [x] `poweredByHeader: false` in Next — **L-3**

## Authentication & Sessions
- [x] Argon2 password hashing
- [x] 3 JWT identities, distinct secrets **and** audiences; decoders pin key+aud
- [x] Refresh revocation via `refresh_token_version` (+ patient logout `POST /patient/auth/logout` revokes patient tokens)
- [x] IP rate-limit + per-account lockout on tenant / platform / patient login
- [x] Wrong-TOTP counts toward lockout; MFA verified server-side
- [x] Concurrent-session cap + server logout + password-change/reset closes sessions
- [x] Patient-portal registration gated by OTP ownership proof
- [x] Trust client IP only from a verified proxy — Caddy `{client_ip}` + `X-Real-Client-IP`, spoof-proof (verified) — **C-2**
- [ ] Shorten refresh TTL (7–14d) + one-time-use rotation with reuse-detection — **M-1**
- [~] MFA available for tenant users; [ ] require/offer MFA for platform admins

## API Hardening
- [x] Pydantic validation on request bodies (no raw dict→query)
- [x] `$regex` inputs `re.escape`d (ReDoS-safe)
- [x] OpenAPI/docs disabled in prod
- [x] Strict CORS allowlist; boot refuses `*`
- [x] Global request-body size cap (Caddy `request_body`: 30MB api / 8MB web; 413 verified) — **H-4**
- [ ] Coarse edge rate limit for anonymous traffic (Cloudflare rules — dashboard action) — **H-4**
- [ ] Per-route limits on expensive analytics/aggregation endpoints — **H-4**
- [x] Security response headers applied to every site (except CSP, see H-1)
- [x] Revolut webhook replay-dedup (signature-keyed, 24h TTL) → replayed events are no-ops — **A-webhook**

## File Uploads
- [x] Size caps (`read(cap+1)`) on catalog XML, rx-photo, scans
- [x] Content-Type allowlist (415 on mismatch)
- [x] Decompression-bomb guard (`PIL.MAX_IMAGE_PIXELS`)
- [x] XML parsed with `defusedxml` / hardened `lxml` (XXE + billion-laughs safe)
- [ ] Magic-number/content sniff (not just declared MIME) on image/PDF uploads
- [ ] Malware-scan hook (ClamAV) for stored files (defense-in-depth)

## Injection / SSRF / XSS
- [x] No `eval`/`exec`/`pickle`/`yaml.load` on user data
- [x] SSRF guard on tenant-supplied ΗΔΥΚΑ URL (blocks private/loopback, fail-closed)
- [x] No `dangerouslySetInnerHTML`; export/innerHTML paths run through `esc()`
- [ ] CSP as XSS backstop — **H-1**
- [~] Pin outbound integrations to fixed hosts (done); [ ] guard DNS-rebinding TOCTOU on the tenant URL path

## Secrets & Cryptography
- [x] No secrets in Git (`git ls-files` clean; `.gitignore` covers env/keys/backups)
- [x] Platform app-secrets (Anthropic/Revolut/Apifon/ΑΑΔΕ/SMTP) Fernet-encrypted at rest
- [x] Tenant ΗΔΥΚΑ creds + JWT keys + pepper in Vault
- [x] Secrets masked in admin API responses (`*_set` + last-4 only)
- [x] No secrets logged (verified)
- [x] `cloud` (Hetzner/Cloudflare/storage) + `idika` secrets ENCRYPTED at rest (Fernet); bash tooling decrypts via `infra/scripts/rxsecret.py`; verified E2E (backup + ΗΔΥΚΑ creds both nodes)
- [x] Vault reached over HTTPS from app nodes — **H-3** DONE: Vault now TLS end-to-end (cert SAN covers vault/127.0.0.1/10.0.0.2); all 7 backend services verified reading secrets over TLS; plaintext dead; auto-unseal reboot-safe
- [ ] VAPID private key moved to Vault — **M-4**
- [x] `assert_production_secrets`: 3 JWT secrets distinct + `VAULT_ADDR` https (verified passing in prod) — **M-2**
- [ ] Secret-rotation runbook (JWT keys, Anthropic/Revolut/Apifon, Vault unseal shares)

## Containers / DevOps / Supply Chain
- [x] Backend non-root (`appuser`), frontend non-root (`nextjs`)
- [x] Next.js standalone output; no secrets in build args
- [x] `python-jose` 3.5.0 at runtime (CVEs patched)
- [x] Pin Python deps (`backend/requirements.lock` + `-c` constraint); [ ] add `--require-hashes` — **H-5**
- [x] Pin backend+frontend base images by `@sha256` digest; [ ] pin compose images — **H-5**
- [x] Trivy + `pip-audit` + SBOM (Syft) in CI (advisory) — **H-5**
- [x] `gitleaks` secret-scan CI job — **H-5**
- [x] `.dockerignore` (backend + frontend) — **M-5**
- [x] `cap_drop:[ALL]` + `no-new-privileges` on all app containers (caddy keeps NET_BIND_SERVICE); [ ] `read_only` FS (needs per-container tmpfs)
- [x] Raise `python-jose` floor to `>=3.4` (runtime already 3.5.0) — **L-1**

## Backups & DR
- [x] Offsite-first backup with integrity check + retention
- [x] Encrypt archive before offsite upload (GPG, asymmetric) — **H-2**
- [x] Pin storage-box SSH host key (`StrictHostKeyChecking=yes` + pinned known_hosts) — **H-2**
- [x] `sshpass -f` (password via 0600 file, not cmdline) — **H-2 / L-4**
- [x] Documented + tested **restore** drill from an encrypted archive (`restore-backup.sh latest`, verified)
- [ ] Save the backup PRIVATE key offline (`/root/rxvision-backup-private.asc`) + optionally remove from host
- [ ] Backup of Vault unseal shares / recovery keys (secure, split)

## Monitoring & Logging
- [x] Mutations + login attempts (incl. failures) + admin actions audited with request-id
- [x] Per-node CPU/RAM/load reporting
- [x] Alert on failed-login velocity (total + per-IP) → admin email via ops_health watchdog — **M-7**
- [x] Alert on 5xx bursts → admin email (ops_health); [~] token-refresh anomalies/worker-crash alerts — **M-7**
- [ ] Ship Caddy access logs; Cloudflare WAF/security analytics reviewed — **M-7**
- [x] Never log passwords/tokens/secrets (verified)

## AI Surface
- [x] Claude key server-side only; tools tenant-scoped; ΑΜΚΑ scrubbed before egress; actions re-check perms
- [x] System-prompt guardrail: tool/document content is data, never instructions; never reveal prompt/keys — **A-1**
- [x] Per-tenant daily LLM cap: Copilot+PharmaCat (50) + Prescriptor (300, added) — **A-2**

## Production Readiness gates
- [x] All CRITICAL closed (C-1 firewalls+secret-header, C-2 spoof-proof IP)
- [x] All HIGH closed (H-1 CSP, H-2 backups, H-3 Vault TLS, H-4 body caps, H-5 pinning+scan)
- [ ] Secret-rotation + restore drills executed once
- [ ] Full go/no-go signed off (`PRODUCTION_READINESS.md`)
