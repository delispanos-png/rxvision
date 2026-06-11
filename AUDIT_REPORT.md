# RxVision — Security & Quality Audit (2026-06-11)

Branch **`audit-fixes`** (off `main`). Read-only sweeps across backend + frontend, then **only
clear & safe fixes applied**; risky/contested findings are documented with recommendations (not
touched). No prod data/migrations/deploy/Vault/ΗΔΙΚΑ-API actions. Verify: `py_compile` (local) +
`tsc --noEmit` 0 (frontend) + backend `ruff`/`pytest` run in CI on push.

Method: 5 parallel read-only audit agents (tenant-isolation, security, backend logic, perf/
error-handling, frontend), findings triaged against the actual code (several agent "criticals"
were false alarms or by-design — noted below).

---

## ✅ FIXED in this branch (clear & safe)

| Sev | File:line | Issue | Fix |
|---|---|---|---|
| **HIGH (security)** | `backend/app/api/v1/routers/communications.py:95` | **Mongo `$regex` injection / ReDoS** — the `substance` campaign segment built `{$regex: "^"+val}` / `{$regex: val}` from the raw user `value` query param (unescaped). A crafted value (e.g. `(a+)+`) enables ReDoS / regex logic injection. | `import re` + `val = re.escape((value or "").upper())` — literal search preserved, injection removed. |
| **LOW (hygiene)** | `backend/app/services/billing_service.py:89` | Platform billing scans `subscriptions` across all tenants with no `tenant_id` — **by design**, but undocumented (would re-trip tenant-isolation audits). | Added `# tenant-ok` marker documenting the deliberate platform-wide scan (per the CLAUDE.md convention). No logic change. |

---

## ⚠️ DEFERRED — real but NOT safe to auto-fix (need review/business sign-off)

| Sev | File:line | Issue | Recommendation |
|---|---|---|---|
| **HIGH** | `backend/app/repositories/profitability.py:15` (`_month_range`) and `closing.py` (period bounds) | Month boundaries are built in **UTC** (`tzinfo=timezone.utc`) while the convention is that `executed_at` is **Athens-local** for analytics. Executions in the ~2–3h around a month edge can be misclassified into the adjacent month → **financial period totals slightly wrong**. | Build bounds in `ZoneInfo("Europe/Athens")`. **Not auto-fixed**: it shifts reported monthly revenue/closing numbers — confirm intended calendar semantics + re-baseline before changing. |
| **HIGH (GDPR)** | `backend/app/services/ingestion/engine.py:~173` | Raw **AMKA** is written to `patients_anonymized.amka` (alongside the HMAC `pseudo_id`). | This is a **deliberate decision by the ingestion/GDPR stream** ("pharmacy is the data controller; show identity to authorised staff"). Left untouched (owned by another stream + behaviour-changing). Flagged for the GDPR owner to confirm it's intended + access-gated. |
| **HIGH (security)** | `frontend` token handling: `lib/apiClient.ts`, admin impersonation hash in `login/page.tsx` | JWTs in `localStorage` (XSS-exfiltration risk) + admin→tenant impersonation tokens passed via URL hash (`#imp=…`) → browser history / Referer leakage. | Migrate to `HttpOnly; Secure; SameSite` cookies + a short-lived single-use code exchange for impersonation. **Architectural — needs design + backend changes; not in scope of safe auto-fix.** |
| **MED** | `backend` N+1 hot paths: `prescriptions.py:44–54` (per-item `products`/`medicine_catalog` `find_one` in a loop), `advisor.py`, `patient_intelligence.py`, `reimbursement.py` unbounded `to_list(length=None)` | 50–100 queries per prescription-detail view; unbounded in-memory loads for large tenants. | Batch with a single `{$in:[…]}` fetch / server-side `$group`; add `.limit()` on unbounded reads. **Behaviour-affecting refactors — verify with tests before applying.** |
| **MED** | `backend/app/services/aade_service.py:~68` | `ET.fromstring()` on the ΑΑΔΕ SOAP response (stdlib ElementTree, no entity hardening) — XXE if the response is tampered. Low practical risk (own backend's call), but defense-in-depth. | Use `defusedxml` (add dep) or a hardened parser. Deferred: adding a dependency + parser swap needs verification. |
| **MED** | `backend` public/unrate-limited endpoints: `onboarding.py` `GET /aade/{afm}` (public ΑΑΔΕ lookup), `infra_cloud.py` `/verify` (live cloud token checks) | AFM enumeration / quota exhaustion / provider lockout. | Add `rate_limit(...)` dependency + caching. Deferred (needs limit-tuning + product call). |
| **MED** | `backend/app/core/config.py` `assert_production_secrets()` | Checks for dev-default secrets but not **minimum length/entropy** of `JWT_SECRET`/peppers. | Add `len >= 32` (and entropy) assertion for prod. Safe-ish but touches prod boot gate — recommend, don't auto-apply mid-audit. |
| **MED** | `frontend` `as any` on `error.problem` across ~5 files; dual money formatters (`eur`/`eur2`) + scattered inline `value/100` instead of `lib/formatters.fmtEur` | Type-safety erosion + UI money inconsistency (€10 vs €10.00). | Add an `ApiErrorProblem` type + `getErrorCode()` helper; consolidate on `fmtEur()`. Low-risk but broad refactor — batch separately. |

---

## ✅ VERIFIED OK (audit false-alarms / by-design)

- **Tenant isolation overall**: enforced by construction via `BaseRepository._scope()` + `aggregate()` prepending `{$match:{tenant_id}}`; covered by `tests/test_invariants.py` + `test_tenant_isolation.py`. `admin.py`/`platform.py` are intentionally cross-tenant (platform admin). `core/db.py` reap is platform startup maintenance (already in the isolation-test `PLATFORM_FILES` allowlist).
- **JWT identity separation**: tenant (`tid`, `aud=rxvision/tenant`, `JWT_SECRET`) vs platform (`padmin`, `aud=rxvision/platform`, `JWT_PLATFORM_SECRET`) — separate keys + audiences; `decode_platform_token` rejects tenant tokens and vice-versa. ✅
- **ΓΕΣΥ XML** parser is hardened (`resolve_entities=False, no_network=True, load_dtd=False`). **SSRF guard** (`utils/net.py`) on tenant ΗΔΙΚΑ `base_url`. **Revolut webhook** HMAC-verified. Auth/RBAC: routers gated by `require(...)`/`get_platform_admin`. Money is integer cents in the engine. `advisor.py` `or 1` div-guards are benign (empty rows → first=None handled by caller). `InfraDashboard.tsx:142` non-null was a self-corrected false alarm.

---

## Test-coverage gap (recommended)
`test_tenant_isolation.py` checks for the *string* `tenant_id` in a call; it does **not** verify that an **aggregation's first stage** is `{$match:{tenant_id}}`. Harden it to specifically assert the `$match` first-stage for `.aggregate(...)` calls (catches output-only `$tenant_id` references like the platform `fund_groups` group).

## Summary of what ran
- `py_compile` on edited backend files: **OK**. Frontend `tsc --noEmit`: **0 errors** (baseline + post-edit; no frontend code changed).
- Backend `ruff`/`mypy`/`pytest` (incl. the two isolation test files) run in **CI on push** of this branch.
- 2 fixes committed; everything else documented above. No prod/Vault/ΗΔΙΚΑ/deploy actions taken.
