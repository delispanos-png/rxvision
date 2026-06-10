# Dependency & Security Audit — RxVision

> **REPORT ONLY** — per the workstream rules, NO upgrades were applied. All fixes below are
> **breaking** (major bumps) or have **no fix**, so they need a planned, tested upgrade cycle
> with human review. Date: 2026-06-10. Branch: `quality-hardening`.

## Frontend — `npm audit` (production deps)
**13 vulnerabilities: 1 critical, 10 high, 2 moderate.** Almost all are transitive via two roots:
**`next-pwa`** (unmaintained; pulls old workbox/terser/serialize-javascript) and **`next`**/**`jspdf`**/**`xlsx`**.

| Pkg | Sev | Advisory | Fix | Recommendation |
|---|---|---|---|---|
| `jspdf` | **critical** | ReDoS (regex DoS) | `jspdf@4` (breaking) | Plan upgrade to jspdf 4.x + retest PDF/export + GDPR PDF. |
| `next` | high | DoS via Image Optimizer `remotePatterns` | `next@16` (breaking) | Major upgrade (14→16) — schedule separately, large. Mitigation now: we don't use remote image patterns. |
| `next-pwa` → `workbox-build`, `workbox-webpack-plugin`, `rollup-plugin-terser`, `serialize-javascript` (RCE), `glob` (cmd injection) | high | unmaintained toolchain | `next-pwa@2` (breaking) | **Migrate to Serwist** (`@serwist/next`) — the maintained successor; biggest single risk-reduction. |
| `@next/eslint-plugin-next`, `eslint-config-next` | high | via `glob` | `eslint-config-next@16` (breaking) | Bump with the Next 16 upgrade (dev-only impact). |
| `dompurify` (via jspdf) | moderate | XSS | `jspdf@4` | Covered by the jspdf upgrade. |
| `postcss` (via next) | moderate | XSS in CSS stringify | `next@16` | Covered by the Next upgrade. Build-time only. |
| `xlsx` (SheetJS) | high | Prototype pollution | **none on npm** | SheetJS ships fixes on their own CDN, not npm. Options: pin to the CDN build, or replace with `exceljs`, or move spreadsheet export server-side. **Review needed.** |

**Notes / mitigations already in place:** most are build-time or dev-time (workbox/terser/glob/
postcss/eslint), not runtime-exploitable in the shipped app. The runtime-relevant ones are
`jspdf` (used for client PDF export) and `xlsx` (client spreadsheet export) — both process
user/tenant data in the browser only.

## Backend — Python
`pip-audit` could **not** be run in this sandbox (no pip; backend runs only in CI/containers).
Manual review of `backend/pyproject.toml`:

| Pkg | Note | Recommendation |
|---|---|---|
| `python-jose[cryptography]` | Has had CVEs (algorithm confusion / DoS); maintenance is slow. | Plan migration to **PyJWT** (the JWT helpers in `core/security.py` are small + well-tested). |
| `python-multipart` | Already pinned `>=0.0.18` (CVE-fixed) ✅ | none |
| `lxml`, `httpx`, `motor`, `redis`, `celery`, `hvac`, `pyotp` | No known critical advisories at pinned floors. | Keep current; run `pip-audit` in CI for ongoing tracking. |

## Recommended actions (priority)
1. **Add `pip-audit` to the backend CI job** so Python advisories are tracked automatically.
2. **Migrate `next-pwa` → Serwist** — clears 6 of the high findings (workbox/terser/glob/
   serialize-javascript) in one move.
3. **Bump `jspdf` → 4.x** (critical ReDoS) + retest all PDF/export paths.
4. **Decide on `xlsx`** (pin CDN build / replace with exceljs / server-side export).
5. **Plan Next 14 → 16** as a dedicated, tested upgrade (covers `next`, `postcss`, eslint-config).
6. **Migrate `python-jose` → PyJWT**.

All of the above are **breaking** and must be done on their own branches with full regression
testing — intentionally NOT applied here.
