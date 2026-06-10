# GDPR workstream — SUMMARY

Branch **`gdpr-compliance`** (off `main`). Self-contained; no infra/ingestion/worker/secret
changes; not pushed to main, not merged, not deployed. CI **green** (Backend ruff + pytest 47
passed; Frontend tsc·lint·build). Left for human review.

## ✅ Implemented (code)

**Backend (FastAPI) — `/api/v1/gdpr`, tenant-scoped via BaseRepository, every op audited:**
- `GET /data-map` — data categories, purpose, legal basis, retention (drives the UI).
- `GET /search?q=` — find a subject by name / phone / email.
- `GET /export/{id}` — **Art.15 + 20**: full structured JSON bundle (identity, contact,
  executions, items, future, consents, request history).
- `POST /erase/{id}` — **Art.17 with LEGAL HOLD**: deletes `patient_contacts`, strips
  `full_name`+`amka` from `patients_anonymized`, withdraws all consent, keeps the pseudonymous
  prescription record (statutory retention). Idempotent; confirmation required.
- `PUT /rectify/{id}` — **Art.16** contact correction.
- `POST /restrict/{id}` — **Art.18 / 21** restriction & objection (objection withdraws marketing).
- `GET/POST /consents/{id}` — **consent ledger** (`patient_consents`, append-only;
  current/history/withdrawn). **Wired into `communications._audience`** so withdrawn subjects are
  excluded from email/SMS campaigns (ledger authoritative over the stale contact flag).
- RBAC: `gdpr:read/export/rectify/erase` (owner via `*`, manager + pharmacist explicit);
  endpoints are permission-only (`module=None`) — rights are never paywalled.
- Audit: `gdpr_service.audit()` writes `audit_logs` with `subject_id`, never raw PII.
- Files: `repositories/consents.py`, `services/gdpr_service.py`, `services/consent.py`,
  `schemas/gdpr.py`, `api/v1/routers/gdpr.py`; wired in `api/v1/__init__.py`, `communications.py`,
  `rbac_seed.py`. Tests: `tests/test_gdpr.py` (export, erase-legal-hold, consent, rectify, search,
  tenant isolation — mongomock, round-trip).

**Frontend (Next.js) — `/settings/gdpr` (Greek):**
- Data-categories & retention summary + DSAR tools (search → export JSON / **Greek PDF**,
  rectify, consent grant/withdraw, restrict/object, erase with confirm dialog).
- `lib/gdprExport.ts` — JSON download + html2canvas→jsPDF Greek PDF. Nav tab added.

## ✅ Delivered (docs/gdpr/)
`gap-analysis.md` · `ropa.md` (Art.30) · `dpia.md` (Art.35) · `privacy-policy.md` ·
`dpa-template.md` (Art.28) · `sub-processors.md` · `breach-response.md` (Art.33-34) ·
`retention-policy.md` · `dsr-runbook.md` · `PROGRESS.md` · `QUESTIONS.md`.

## ⏳ Left for humans (cannot be invented — see QUESTIONS.md)
- **Legal facts** (placeholders «[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]»): CloudOn legal entity/ΑΦΜ/address, DPO,
  official privacy email, **statutory retention years**, the **Art.9(2) condition + Ν.4624/2019**
  hook, sub-processor regions/SCCs, ΑΠΔΠΧ breach channel.
- **Sign-offs**: DPIA approval, DPA execution per pharmacy, RoPA finalisation, DPO appointment.
- **Code follow-ups** (P1/P2): replace the 500-event consent read cap with a per-(patient,channel)
  "latest" index; confirm `processing_restricted` is honoured on all analytics read paths; verify
  Greek-PDF pagination on large exports.
- **Stretch C** (not started): cookie-consent banner + public `/privacy` `/terms` on the marketing
  site.

## Guardrails honoured
No `docker compose`/service restarts; no edits to `.env`/Vault/`infra/`/`docker-compose*`/
`services/ingestion/*`/`workers/*`/`core/db.py`; live DB treated read-only (erase/export are code
+ unit tests, never executed against prod); tenant isolation preserved (BaseRepository);
no raw PII logged; static checks only (CI runs pytest).
