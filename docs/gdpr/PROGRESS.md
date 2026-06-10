# GDPR workstream — progress log

Branch: `gdpr-compliance` (off `main`). Self-contained; no infra/ingestion/worker/secret
changes. Static checks only (CI runs pytest). Do not push to main / merge / deploy.

## 2026-06-10

### Backend (DSAR + consent) — DONE (static-checked, CI pending)
- `repositories/consents.py` — `PatientConsentRepository` (append-only ledger; `record`,
  `history`, `current`, `withdrawn_patient_ids`). Tenant-scoped via BaseRepository.
- `services/gdpr_service.py` — `export_subject` (Art.15/20 gather), `erase_subject` (Art.17
  with LEGAL HOLD — strips contact PII + name/AMKA, keeps pseudonymous statutory record),
  `rectify_contact` (Art.16), `set_processing_flags` (Art.18/21), `audit()` (subject-aware
  audit_logs entry, never logs raw PII).
- `services/consent.py` — `withdrawn_patient_ids` helper for the comms gate.
- `schemas/gdpr.py`, `api/v1/routers/gdpr.py` — endpoints: data-map, export, erase, rectify,
  restrict, consents (get/record). Permission-gated only (module=None → never paywalled).
- Wiring: registered router in `api/v1/__init__.py`; added `gdpr:*` permissions in
  `rbac_seed.py` (owner via `*`, manager + pharmacist explicit); **consent gate wired into
  `communications._audience`** — withdrawn subjects are excluded from campaigns.
- `tests/test_gdpr.py` — export gather, erase legal-hold, consent current/withdrawn, rectify,
  tenant isolation (mongomock-motor, round-trip).

Decisions:
- GDPR endpoints are **module=None** (permission-only): data-subject rights are a legal
  obligation and must never be locked by subscription tier.
- Erasure = **anonymise, not hard-delete**: prescription executions/items/future have
  statutory pharmacy-law retention and hold only a pseudonymous link, so we strip direct
  identifiers (contact PII, full_name, amka) and keep the legally-required record.
- Consent **ledger is authoritative** over `patient_contacts.marketing_consent`: the send
  path excludes anyone whose latest ledger event for the channel is a withdrawal.

### Frontend — DONE
- `settings/gdpr/page.tsx` (Greek): data-categories & retention summary (from `/gdpr/data-map`)
  + DSAR tools — search subject → export (JSON + Greek PDF), rectify, consent grant/withdraw per
  channel, restrict/object, erase with confirm. Nav tab added. `lib/gdprExport.ts` (JSON download
  + html2canvas→jsPDF Greek PDF). Backend `GET /gdpr/search` added. tsc 0, lint clean.

### Docs — DONE (docs/gdpr/)
- gap-analysis.md (Art-by-Art → state → gap → fix + P0/P1/P2 checklist), ropa.md (Art.30),
  retention-policy.md (per-category + legal-hold + apply_retention alignment), dpia.md (Art.35,
  8-risk table), privacy-policy.md, dpa-template.md (Art.28), sub-processors.md, breach-response.md
  (Art.33-34, 72h), dsr-runbook.md. Legal/business unknowns marked «[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: …]».
- Corrected the parallel-drafted docs where they assumed "no PDF" (PDF IS implemented client-side).

### CI status
- Branch `gdpr-compliance` pushed; CI **green** (Backend ruff+pytest 47 passed, Frontend
  tsc·lint·build). mypy advisory.

### Remaining
- SUMMARY.md (final). Legal facts in QUESTIONS.md await CloudOn/legal. Stretch C (cookie banner +
  public /privacy /terms) not started.
