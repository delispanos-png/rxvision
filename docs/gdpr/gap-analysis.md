# RxVision — GDPR Gap Analysis (Internal Compliance Note)

> **Status:** working draft, 2026-06-10. **Owner:** CloudOn (Processor) compliance lead.
> **Scope:** RxVision multi-tenant SaaS PWA processing Greek (ΗΔΙΚΑ) pharmacy prescription
> executions = **health data + PII → GDPR Art.9 special category**.
> **Roles:** each tenant pharmacy = **Controller**; CloudOn = **Processor**; patients = data subjects.
> **Supervisory authority:** Ελληνική Αρχή Προστασίας Δεδομένων (ΑΠΔΠΧ / HDPA).
> **Code baseline:** branch `gdpr-compliance` (CI green) — DSAR + consent module under
> `/api/v1/gdpr`. This note is accurate to the **implemented** module (see "Implementation
> reality check" below), not to aspirational scope.

This note maps each relevant Article → current RxVision state → gap → fix/owner, then a
prioritized P0/P1/P2 checklist. Legal/business facts that cannot be known from the code are
marked **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: …]»** and must be confirmed by CloudOn/legal counsel — never invent.

Sibling docs referenced (some still **TO BE CREATED** — see checklist):
`ropa.md`, `dpia.md`, `retention-policy.md`, `privacy-policy.md`, `dpa-template.md`,
`sub-processors.md`, `breach-response.md`, `dsr-runbook.md`.

---

## Implementation reality check (what the code module actually does)

Grounded in `backend/app/services/gdpr_service.py`, `api/v1/routers/gdpr.py`,
`repositories/consents.py`, `services/consent.py`, `services/rbac_seed.py`,
`api/v1/routers/communications.py`:

- **Endpoints** under `/api/v1/gdpr`: `GET data-map`, `GET search`, `GET export/{id}`,
  `POST erase/{id}`, `PUT rectify/{id}`, `POST restrict/{id}`, `GET/POST consents/{id}`.
- **Export (Art.15/20):** `GET export/{id}` returns a **structured JSON** bundle (identity, contact,
  executions, items, future, consents, gdpr_request_history, counts). The **human-readable Greek PDF**
  is generated **client-side** in `frontend/src/lib/gdprExport.ts` (`downloadGdprPdf`, via
  html2canvas → jsPDF so Greek renders), offered alongside JSON from `/settings/gdpr`.
- **Erase (Art.17 + legal hold):** deletes `patient_contacts`, `$unset` `full_name`+`amka` on
  `patients_anonymized`, sets `erased/processing_restricted/marketing_objected`, withdraws all
  consents; **keeps** `prescription_executions/items/future_prescriptions` (pseudonymous statutory
  record). Idempotent.
- **Rectify (Art.16):** contact fields only (whitelisted in `RectifyIn`).
- **Restrict/Object (Art.18/21):** sets flags; objection withdraws all marketing consent.
- **Consent ledger:** append-only `patient_consents`; `current`/`history`/`withdrawn_patient_ids`.
  Wired into `communications._audience` so withdrawn subjects are excluded from campaigns
  (ledger authoritative over the stale `marketing_consent` flag).
- **Audit:** every mutating op writes `audit_logs` with `subject_id`, never raw PII.
- **RBAC:** `gdpr:read` (via `_READ_ALL`), `gdpr:export`, `gdpr:rectify`, `gdpr:erase`; owner via
  `*`, manager + pharmacist explicit. Endpoints are `module=None` (permission-only, never paywalled).
- **Tenant isolation:** all GDPR DB access goes through `BaseRepository` (tenant_id injected).
- **Pseudonymization:** `pseudo_id = HMAC-SHA256(amka, tenant_pepper)`, per-tenant pepper in Vault.

One known delta vs the proposal: the `withdrawn_patient_ids` / consent reads use a
**500-event cap** — fine for current scale but a correctness risk if a tenant's consent ledger
grows large (note for Art.7/21 robustness). (Export JSON **and** Greek PDF are both implemented.)

---

## Article-by-article mapping

| Art. | Topic | Current state in RxVision | Gap | Fix / Owner |
|---|---|---|---|---|
| **5** | Principles + accountability | Data minimisation strong (analytics store holds pseudonymised data only; PII ephemeral in worker). Purpose/retention surfaced in `DATA_MAP`. Audit trail in `audit_logs`. | Accountability **not documented end-to-end**: RoPA/DPIA/retention policy not finalised. No single owner sign-off. `audit_logs` retention not legally confirmed. | Finalise `ropa.md`, `dpia.md`, `retention-policy.md`; assign accountable owner. **Owner: CloudOn compliance.** |
| **6** | Lawfulness | `DATA_MAP` declares bases: contact = consent (6.1.a); statutory clinical record = legal obligation (6.1.c); pseudonymised analytics = legitimate interest / public health. | Bases are **asserted in code labels, not validated by counsel**. LIA for analytics not written. | Confirm bases; write Legitimate Interest Assessment for the analytics purpose. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: lawful basis hook + LIA]»** **Owner: legal.** |
| **7** | Consent (proof, withdrawal) | **SATISFIED by code (core):** append-only `patient_consents` ledger records grant/withdrawal with source, policy_version, actor, timestamp; withdrawal as easy as grant; ledger gates comms send path. | `policy_version` is **free-text / nullable** — no canonical privacy-policy version to pin to (privacy-policy.md missing). 500-event read cap could miss old withdrawals at scale. | Publish privacy policy + version string; pin `policy_version` on grant. Replace 500-cap reads with a per-patient/channel "latest" query or index. **Owner: CloudOn eng + compliance.** |
| **9** | Special-category health data + condition | Strong by-design controls: pseudonymisation, tenant isolation, RBAC, audit. Clinical record kept under legal-obligation basis. | The **Art.9(2) condition is not formally selected** (e.g. 9.2.h management of health-care systems, or 9.2.i public-health, or explicit consent) with its **Greek national-law hook** (Ν.4624/2019). This is the single most important legal gap for an Art.9 processor. | Select + document the 9(2) condition and national-law basis in RoPA/DPIA; reflect in privacy policy. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: Art.9(2) condition + Ν.4624/2019 hook]»** **Owner: legal (P0).** |
| **12–14** | Transparency / privacy notice | `data-map` endpoint + Greek labels give the pharmacist an internal data inventory; underpins a notice. | **No patient-facing privacy notice** (`privacy-policy.md` not created); no identification of Controller/Processor, DPO, sub-processors, retention, rights, complaint route to ΑΠΔΠΧ. | Write `privacy-policy.md` (Greek, patient-facing) + per-pharmacy notice template. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: CloudOn legal entity, DPO/privacy contact, retention years]»** **Owner: legal + CloudOn.** |
| **15** | Right of access | **SATISFIED by code:** `GET export/{id}` returns a complete structured JSON bundle (audited); the **human-readable Greek PDF** is generated client-side (`frontend/src/lib/gdprExport.ts`, html2canvas→jsPDF) — both downloadable from `/settings/gdpr`. | — (verify PDF pagination on large data volumes). | Optional: a server-side PDF if a non-UI channel is ever needed. **Owner: CloudOn eng.** |
| **16** | Rectification | **SATISFIED:** `PUT rectify/{id}` updates whitelisted contact fields; audited. Clinical/statutory fields correctly **not** user-rectifiable (integrity of legal record). | Process for rectifying an erroneous **clinical** field (source = ΗΔΙΚΑ) undocumented. | Document the clinical-correction path (re-ingest / annotate) in `dsr-runbook.md`. **Owner: CloudOn eng.** |
| **17** | Erasure + legal hold | **SATISFIED (by design):** `POST erase/{id}` strips `full_name`+`amka`, deletes `patient_contacts`, withdraws consents, flags record; **retains** pseudonymous prescription record under statutory pharmacy-law legal hold. Idempotent, confirmation-gated, audited. | Erasure does **not propagate to backups/snapshots**; the **retention years** that justify the legal hold are **not legally confirmed**. | Confirm statutory retention years; document backup-purge window. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: pharmacy-law + tax retention YEARS; backup erasure window]»** **Owner: legal + CloudOn ops.** |
| **18** | Restriction | **SATISFIED:** `POST restrict/{id}` sets `processing_restricted`; audited. | Flag is set but **not yet enforced everywhere** downstream (e.g. confirm analytics/exports honour `processing_restricted`). | Verify all read paths respect the restriction flag; add test. **Owner: CloudOn eng.** |
| **20** | Portability | **SATISFIED (machine-readable):** same JSON export as Art.15; structured, portable. | Only the consent/contact data is truly "provided by the subject"; clinical data originates from ΗΔΙΚΑ (portability arguably out of scope). Clarify scope in notice. | Note portability scope in `privacy-policy.md` / `dsr-runbook.md`. **Owner: legal.** |
| **21** | Objection (marketing) | **SATISFIED:** `restrict/{id}` with `object_marketing` withdraws all marketing consent; comms `_audience` excludes withdrawn subjects. | 500-event cap (same as Art.7) is a scale caveat. | See Art.7 fix (latest-event query/index). **Owner: CloudOn eng.** |
| **25** | Privacy by design / default | **STRONG / largely SATISFIED:** pseudonymisation (HMAC-SHA256 + per-tenant Vault pepper, non-reversible, non-cross-linkable), tenant isolation by construction (`BaseRepository`), age→bucket / address→region quasi-identifier reduction, analytics store never holds raw PII, new DSAR module is permission-gated & audited. | Largely complete; needs to be **evidenced** in the DPIA as the mitigation set. | Reference these controls explicitly in `dpia.md`. **Owner: CloudOn compliance.** |
| **28** | Processor / DPA | Architecture documents the Controller(pharmacy)/Processor(CloudOn) model; onboarding intends DPA acceptance. | **No signed/executed DPA**; `dpa-template.md` not created; Art.28(3) clauses (sub-processors, instructions, assistance, deletion/return, audit) not formalised; sub-processor authorisation flow absent. | Draft `dpa-template.md`; wire DPA acceptance + versioning into onboarding; obtain signatures. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: CloudOn legal entity]»** **Owner: legal (P0).** |
| **30** | Records of Processing (RoPA) | Processing activities are well understood (DATA_MAP, architecture docs). | **`ropa.md` not finalised** (CloudOn's Art.30(2) processor record + a controller-side template for pharmacies). | Finalise `ropa.md` (categories, purposes, recipients/sub-processors, retention, transfers, security). **Owner: CloudOn compliance.** |
| **32** | Security of processing | **STRONG:** Vault secrets + per-tenant pepper; TLS via Caddy (HSTS, secure cookies); pseudonymisation; append-only audit; Argon2id, MFA, rate limiting; encryption at rest (WiredTiger/volume). | Single Hetzner host = limited resilience; no documented restore drill / RPO-RTO evidence; pen-test/SCA/SAST not confirmed for this branch; backup encryption + erasure interplay undocumented. | Document & evidence: backups, restore drill, RPO/RTO, pen-test, dependency scan. **Owner: CloudOn ops.** |
| **33–34** | Breach notification (72h) | Audit trail aids detection; intent documented in SECURITY_GDPR. | **No `breach-response.md` procedure**: detection→assessment→**72h** notification to ΑΠΔΠΧ→data-subject notification→register; no roles, no template, no drill. As **Processor**, CloudOn must notify affected **Controllers without undue delay**. | Write `breach-response.md` (incl. processor→controller notification path + ΑΠΔΠΧ channel); run a tabletop drill. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: ΑΠΔΠΧ notification channel/contact]»** **Owner: CloudOn (P0/P1).** |
| **35** | DPIA | Mitigations exist in design; DPIA intent noted. | **`dpia.md` not signed off.** Large-scale processing of Art.9 health data → **DPIA is mandatory** (and on the HDPA list of operations requiring one). Blocks production launch. | Complete + sign off `dpia.md` (necessity/proportionality, risks, mitigations, residual risk, consult HDPA if high residual). **Owner: CloudOn compliance + DPO (P0).** |
| **37** | DPO | Not appointed (unknown). | Large-scale, regular, systematic processing of **special-category** data → a **DPO is very likely required** (Art.37(1)(b)/(c)). No DPO identity or contact published. | Appoint + publish a DPO (or documented privacy contact + justification if not strictly required). **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: DPO appointment + identity/contact]»** **Owner: CloudOn management (P0).** |
| **44–49** | International transfers | Hetzner (EU), Apifon (SMS), Cloudflare (CDN/DNS), email/SMTP provider. | Cloudflare and the email/SMTP provider may involve **non-EU transfer** → SCCs/adequacy not confirmed; sub-processor DPAs not confirmed. | Confirm regions + execute SCCs where needed; record in `sub-processors.md`. **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: Hetzner region; Cloudflare/SMTP transfer + SCCs; signed sub-processor DPAs]»** **Owner: legal + CloudOn ops.** |

---

## Code module: satisfied vs remaining

**Already satisfied by the `gdpr-compliance` module (technical layer):**
- Art.15 access (JSON), Art.16 rectification, Art.17 erasure with legal hold, Art.18 restriction,
  Art.20 portability (JSON), Art.21 objection, Art.7 consent ledger + comms gate, Art.5(2)/30
  audit trail, Art.25 by-design controls (pseudonymisation, tenant isolation), RBAC perms.

**Remaining (mostly legal/process, plus minor code items):**
- **Code:** consent reads use a **500-event cap** (Art.7/21 scale robustness); confirm
  **`processing_restricted` enforced on all analytics read paths** (Art.18); verify the
  (implemented, client-side) Greek **PDF export** paginates on large data volumes (Art.15).
- **Legal/process:** **DPA signing** (Art.28) · **RoPA finalisation** (Art.30) · **DPIA sign-off**
  (Art.35) · **retention years confirmation** (Art.5/17) · **DPO appointment** (Art.37) ·
  **Art.9(2) condition + Ν.4624/2019 hook** (Art.9) · **patient-facing privacy notice** (Art.12-14) ·
  **breach procedure + drill** (Art.33-34) · **cookie/consent banner on the marketing site** ·
  **sub-processor DPAs + transfer SCCs** (Art.28/44).

---

## Prioritised checklist

### P0 — blocks production launch / highest legal exposure
- [ ] **DPIA sign-off** (`dpia.md`) — mandatory for large-scale Art.9. — *CloudOn compliance + DPO*
- [ ] **Select & document Art.9(2) condition + national-law hook (Ν.4624/2019)**. — *legal* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]»**
- [ ] **Appoint & publish DPO** (or documented justification). — *CloudOn management* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]»**
- [ ] **Execute DPA with each pharmacy** (`dpa-template.md` + onboarding wiring). — *legal* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: CloudOn legal entity]»**
- [ ] **Patient-facing privacy notice** (Art.12-14, Greek). — *legal + CloudOn*
- [ ] **Confirm statutory retention YEARS** (pharmacy law, tax/myDATA, contacts, audit logs) — justifies the legal hold. — *legal* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]»**

### P1 — required, schedule before/just after launch
- [ ] **Finalise RoPA** (`ropa.md`) — processor record + controller template. — *CloudOn compliance*
- [ ] **Breach-response procedure + tabletop drill** (`breach-response.md`, 72h + processor→controller path). — *CloudOn* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: ΑΠΔΠΧ channel]»**
- [ ] **Sub-processor register + signed DPAs + transfer SCCs** (`sub-processors.md`). — *legal + ops* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: regions/transfers]»**
- [ ] **Verify Greek PDF export pagination** on large exports (Art.15 — implemented client-side in `gdprExport.ts`). — *CloudOn eng*
- [ ] **DSR runbook** (`dsr-runbook.md`) — how a pharmacist serves each right + SLAs. — *CloudOn compliance*
- [ ] **Verify `processing_restricted` is enforced on all read/analytics/export paths** + add test. — *CloudOn eng*
- [ ] **Security evidence**: restore drill, RPO/RTO, pen-test, SCA/SAST for this branch. — *CloudOn ops*

### P2 — robustness / hardening
- [ ] **Cookie/consent banner on the marketing site** (only if a tracker/analytics exists). — *CloudOn eng* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: existing marketing-site tracker?]»**
- [ ] **Remove 500-event cap** in consent reads — switch to latest-per-(patient,channel) query/index (Art.7/21 at scale). — *CloudOn eng*
- [ ] **Pin `policy_version`** to the published privacy-policy version on every consent grant. — *CloudOn eng*
- [ ] **Document backup/snapshot erasure window** so Art.17 propagates beyond the primary DB. — *CloudOn ops*
- [ ] **Joint-controllership assessment** for any platform-level cross-tenant analytics. — *legal* — **«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]»**

---

*Cross-references:* `docs/gdpr/QUESTIONS.md` tracks the open legal/business facts;
`docs/gdpr/PROGRESS.md` tracks code progress; `docs/SECURITY_GDPR.md` documents the security model.
Sibling deliverables (`ropa.md`, `dpia.md`, `retention-policy.md`, `privacy-policy.md`,
`dpa-template.md`, `sub-processors.md`, `breach-response.md`, `dsr-runbook.md`) are the artefacts the
P0/P1 items above produce.
