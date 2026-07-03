# RxVision — Production Readiness (Internet Exposure)

Go/no-go assessment of the **platform/infrastructure** posture for public-Internet exposure. Business
RBAC/medical workflows excluded by scope. Verdicts reference `SECURITY_REPORT.md`.

## Overall verdict: 🟢 **All CRITICAL & HIGH closed** — edge, auth, secrets, supply-chain, Vault-TLS done

**Update 2026-07-03 (final):** **C-1 CLOSED** — servers firewalled + the LB bypass closed via a Cloudflare
secret header (Transform Rule + Caddy 403, verified both nodes). **C-2 fixed** (spoof-proof client IP). All
**HIGH** items done: H-1 CSP enforced, H-2 encrypted backups, H-3 Vault TLS end-to-end, H-4 body caps, H-5
dependency+image pinning + CI scanning. Plus: platform/cloud/idika secrets encrypted at rest, Revolut webhook
replay-dedup, patient logout, MFA/lockout hardening, patient-portal OTP.

The application-layer security is **strong** (auth, identity separation, injection/XXE/SSRF, secrets-at-rest,
uploads, AI isolation). Remaining are **LOW/defense-in-depth** follow-ups only (below).

| Milestone | State |
|---|---|
| C-2 (brute-force/IP-spoof) | ✅ **DONE** (deployed both nodes, verified) |
| C-1 plaintext origin block removed | ✅ **DONE** |
| C-1 host firewall on ingress 10.0.0.4 | ⏳ ops action — **last go-live blocker** |
| Ready with acceptable residual risk | ⚠️ after C-1 firewall + H-2 (backups) + H-1 (CSP) |
| Hardened / steady-state | ✅ after Phase 1 + Monitoring |

---

## Readiness by area

| # | Area | Verdict | Blocking gaps | Ref |
|---|---|---|---|---|
| 1 | **Edge / network exposure** | 🟢 Fixed | Servers firewalled + LB bypass CLOSED via Cloudflare secret header (verified both nodes) | C-1 |
| 2 | **Rate-limit / anti-brute-force** | 🟢 Fixed | CF-IP spoof closed: verified `{client_ip}` + `X-Real-Client-IP` (deployed) | C-2 |
| 3 | **TLS & security headers** | 🟢 Fixed | Permissions-Policy ✅ + CSP **enforced** ✅ (collector-verified 0 violations) | H-1 |
| 4 | **Backups / DR** | 🟢 Fixed | GPG-encrypted offsite + pinned host key + tested restore ✅ (save private key offline) | H-2 |
| 5 | **Secret transport (Vault)** | 🟢 Fixed | Vault now TLS end-to-end; all 7 backend services verified reading secrets over TLS; plaintext dead | H-3 |
| 6 | **DoS / request limits** | 🟢 Fixed | Body cap 30MB api/8MB web (413 verified); edge rate-limit = Cloudflare rules | H-4 |
| 7 | **Supply chain / builds** | 🟢 Fixed | Deps + base images digest-pinned; CI pip-audit/gitleaks/Trivy | H-5 |
| 8 | **Authentication & sessions** | 🟢 Ready | (M-1 refresh TTL is defense-in-depth, not blocking) | §0, M-1 |
| 9 | **Identity separation (JWT×3)** | 🟢 Ready | Distinct keys+audiences, pinned decoders | §0 |
| 10 | **Injection / XXE / SSRF / XSS** | 🟢 Ready | defusedxml, re.escape, SSRF guard, no innerHTML; CSP pending (H-1) | §0 |
| 11 | **File uploads** | 🟢 Ready | Caps + type allowlist + bomb guard; magic-number sniff = nice-to-have | §0 |
| 12 | **Secrets at rest / in Git** | 🟢 Ready | App-secrets encrypted, Vault-backed, git-clean; `cloud`/`idika` follow-up | §0 |
| 13 | **Datastore exposure** | 🟢 Ready | Mongo private-IP + auth, Redis no-port + auth | §0 |
| 14 | **Container isolation** | 🟢 Ready | Non-root; harden further (read-only FS, cap_drop) in Phase 2 | §0, 2.5 |
| 15 | **AI attack surface** | 🟢 Ready | Server-side key, tenant-scoped tools, ΑΜΚΑ scrubbed; add prompt guardrail | §5 |
| 16 | **Monitoring / alerting** | 🟠 Partial | Audit logs exist; no security alerting yet | M-7 |
| 17 | **Prod fail-safe defaults** | 🟢 Ready | Boot refuses dev secrets / `CORS=*` / no-Vault; docs off in prod | §0 |

Legend: 🟢 ready · 🟠 partial (non-blocking, fix in sprint) · 🔴 blocking.

---

## Go-live gate (all must be ✅)

- [~] **C-1** plaintext preview block removed ✅ · **firewall ingress 10.0.0.4 → Cloudflare-only** ⏳ · trusted TLS ⏳
- [x] **C-2** client IP taken only from a verified proxy (no header spoof) — deployed + verified
- [ ] **H-2** offsite backups encrypted + host-key pinned + **one successful restore drill**
- [ ] **H-1** CSP deployed (Report-Only acceptable at launch, enforced within a week)
- [ ] Cloudflare WAF managed rules + auth-path rate rules enabled
- [ ] Secret-rotation runbook exists; Vault unseal shares backed up securely
- [ ] Sign-off recorded below

Recommended-before-launch (not hard blockers): **H-3, H-4, H-5, M-7**.

---

## Residual risk after Phase 0 (conditional-go state)

With C-1/C-2/H-1/H-2 closed but Phase 1 pending, residual risk is **MEDIUM-LOW**:
- Vault plaintext hop remains on the private net (H-3) — exploitable only by an already-privileged
  insider/host compromise.
- No global body cap / edge rate limit (H-4) — authenticated-DoS risk, bounded by Cloudflare + per-account
  controls.
- Unpinned supply chain (H-5) — risk realizes only on the *next* rebuild; mitigate by freezing rebuilds until
  Phase 1.3, and by the fact that `python-jose` (the security-critical dep) is already on a patched 3.5.0.

These are acceptable for a **controlled launch** to the 56 known pharmacies with a committed Phase-1 date; they
are **not** acceptable for indefinite steady-state.

---

## What is explicitly strong (do not regress)

Tenant/patient/platform identity separation (distinct keys + audiences), boot-time secret assertions,
Mongo/Redis auth on the private net, disabled prod docs, encrypted app-secrets, defusedxml everywhere, the SSRF
guard, non-root containers, and the newly added account lockouts + concurrent-session control + patient OTP.
These form a solid application core; the remaining work is the network/ops perimeter around it.

---

## Sign-off

| Role | Name | Date | Verdict |
|---|---|---|---|
| Security Architect | | | |
| Platform/DevOps owner | | | |
| Product owner | | | |
