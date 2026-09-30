## 🟠 Από 30/09/2026
- [ ] Σημείωση «Τι νέο υπάρχει» + αριθμός έκδοσης για: χάρτη προσοχής κερδοφορίας, διατροφή, εισαγωγή επαφών (ιδιοκτήτης).
- [ ] SoftOne: η γέφυρα τραβά αλλά δεν επιβεβαιώνει → παραστατικά δεν εκδίδονται (Κολέλης από 14/09, Helthea).
- [ ] Reconciliation εκτελέσεων παλαιότερων μηνών μετά το πινγκ-πονγκ (ανά μήνα, feed κατόχου).
- [ ] 11 κόκκινα τεστ: route map (release-notes → release_notes.admin_router) · isolation checker σε services/ · τα παλιά 9.

## 🔴 Άμεσα (μετά την παρουσίαση 11/09/2026)

- [ ] **Τηλέφωνο** σε THE CLINICAL PHARMACY (κλειδωμένος λογαριασμός ΗΔΥΚΑ, 350h) και
      ΦΑΡΜΑΚΕΙΟ ΚΑΙΣΑΣ (401 — μηδέν δεδομένα, 245h). Θέλουν νέο μηνιαίο κωδικό· ο κώδικας δεν
      μπορεί να το λύσει.
- [ ] Email στο `pharm.api.support@idika.gr`: **υπάρχει integrator authentication που δεν λήγει
      μηνιαίως;** Αν ναι, καταργεί όλο τον μηχανισμό ειδοποιήσεων παγωμένου συγχρονισμού.
- [ ] **Πατώμενα KPI στις υπόλοιπες σελίδες adminpanel** (έγιναν μόνο οι Συνδρομητές — `d4f0ed3`).
- [ ] **View εμβολιασμών**: η περίοδος να είναι **εμβολιαστική σεζόν (Σεπ→Αυγ)**, όχι ημερολογιακό
      έτος — αλλιώς το «προηγούμενο έτος» κόβει τη σεζόν στη μέση.
- [ ] Demo tenant: `comms_campaigns=0`, `loyalty_members=3` — γέμισμα αν δείχνονται αυτές οι οθόνες.

# TODO / Backlog — RxVision

> Prioritized backlog for session continuity. Tick items as done with a date.
> Source of truth for "what next". Last updated: **2026-06-07**.

## Status legend
`[ ]` open · `[~]` in progress · `[x]` done (with date) · `[>]` deferred/blocked

---

## P0 — Security hardening (finish what quick-wins started)

### Cloudflare / edge hardening (2026-09-05) — βλ. `docs/cloudflare-hardening-2026-09.md`
- [x] `always_use_https` on · `min_tls_version` 1.2 · 3 custom WAF κανόνες (2026-09-05)
- [ ] **Cloudflare Access στο adminpanel** — δωρεάν, δικαιώματα υπάρχουν· ΘΕΛΕΙ ιδιοκτήτη μπροστά
- [x] **Origin CA cert στον Caddy (3 nodes) → SSL `full (strict)`** — ΕΓΙΝΕ 2026-09-05 (cert λήγει 2041)
- [ ] **Hetzner firewall: `:443` μόνο από IP Cloudflare** (`hetzner_token` υπάρχει)
- [ ] Προαιρετικό: πλάνο Pro (~€20/μ) για πλήρες WAF managed ruleset
- [ ] Περιόρισε το Cloudflare API token σε μία zone + ημερομηνία λήξης (βλέπει 27 domains)
- [ ] (εκτός ασφάλειας) `www.rxvision.gr` → 421, προϋπάρχον θέμα marketing site

- [x] **#1** Fail-fast on default JWT secret / pepper / wildcard CORS — 2026-06-07
- [x] **#2** Escape `$regex` in doctor search (ReDoS) — 2026-06-07
- [x] **#3** Hardened lxml parser for GESY upload (XXE) — 2026-06-07
- [x] **#4** Cap `limit`/`page_size` — 2026-06-07
- [x] **#5** Hash + atomic single-use reset tokens — 2026-06-07
- [x] **#6** Reject `padmin` tokens in tenant context — 2026-06-07
- [x] **#9** `sandbox` on newsletter preview iframe — 2026-06-07
- [x] **T-01** Vault mandatory in prod — 2026-06-07. *(C2)* `vault_service` no longer
      falls back to an in-memory store in prod (`_degrade` seeds only in dev); new
      `assert_ready()` called in `main.lifespan` refuses to boot in prod without a
      reachable/authed Vault. `.env.example` notes it's required. Test added.
- [ ] **T-09** Provision a random per-tenant pepper into Vault at tenant creation
      (`provisioning.open_tenant` / `onboarding.register`), so peppers stop being derived
      from the global one. Touches the anonymization continuity path → needs a test +
      care that existing tenants keep their current (derived) pepper. (refines T-01)
- [x] **T-02** Mongo & Redis authentication — keyfile auto-gen in volume + auth ON;
      requirepass; creds in `.env`; backup script + prod gate updated — 2026-06-07. *(H4)*
- [x] **T-03** Vault TLS — self-signed cert (`gen-vault-tls.sh`), `tls_disable=0`,
      hvac CA verify, unseal scripts on https, systemd ExecStartPre — 2026-06-07. *(H6)*
      ⚠️ **Not yet validated with a live `docker compose up`** (no Docker in the dev
      env where this was written) — see test checklist in project-state.md.
- [x] **T-04** Separate JWT keys/audiences for tenant vs platform tokens — 2026-06-07. *(H1)*
      New `JWT_PLATFORM_SECRET`; platform tokens signed with it + `aud=rxvision/platform`,
      tenant tokens `aud=rxvision/tenant`; `decode_platform_token` verifies both; gate +
      `.env.example` updated; tests updated + new cross-decode test. ⚠️ Deploy note: existing
      tokens (no `aud`) become invalid → users/admins must re-login once.
- [x] **T-05** Rate limiting + MFA verification — 2026-06-07. *(M6)*
      Redis fixed-window limiter (`app/core/ratelimit.py`, fail-open) on tenant login,
      platform login, forgot, reset. Real TOTP via `pyotp`: `auth_service.login` now
      verifies `mfa_code` when `mfa_enabled` (returns `{"mfa_required": True}` → 401
      `mfa_required`). New dep `pyotp`. Test added (importorskip).
- [ ] **T-08** MFA enrollment flow — generate per-user `mfa_secret` (store in Vault),
      QR/provisioning URI, verify-on-enable, disable, recovery codes. T-05 only added
      the *verification* path; no user can self-enable MFA yet (UI still says "σύντομα").
- [~] **M2** SSRF allow-list / private-IP filtering on tenant-supplied ΗΔΥΚΑ `base_url`.
      **PAUSED 2026-06-08** — `backend/app/utils/net.py` guard built (uncommitted, not wired);
      wiring touches `ingestion.py` which the concurrent ΗΔΥΚΑ agent owns. Finish after rebase
      onto the new `main`. *(see project-state §Active concurrency)*
- [ ] Audit logging for PHI reads + failed logins; WORM/append-only audit store. *(M5)*

## P0 — Tooling / quality gate

- [x] **#10** Minimal CI (ruff+pytest blocking; mypy/tsc/lint advisory) — 2026-06-07
- [x] AI Tech Lead persistent working environment (`docs/ai/` + `scripts/ai/`) — 2026-06-07 (D-016)
- [ ] Add lockfiles (`uv.lock`/`poetry.lock`, `package-lock.json`); switch Docker
      to `npm ci` + locked pip install for reproducible builds.
- [x] Push `quick-wins` + CI green — 2026-06-08 (PR #1; ruff·pytest + tsc·lint·build pass).
- [ ] **Validate #7/#8 with a live `docker compose up`** (checklist in project-state.md) —
      CI doesn't spin up the full stack, so DB-auth + Vault-TLS are still un-smoke-tested.

## P1 — Data correctness (analytics must be trustworthy)

- [x] **T-06** Wholesale pricing resolution — DONE 2026-06-08 (py_compile + logic test;
      `pytest` runs in CI). `IngestionEngine._effective_wholesale` resolves cost by priority:
      source feed → real product masterdata → estimate from retail
      (`WHOLESALE_FALLBACK_MARGIN_PCT`, default 25%, flagged `wholesale_source="estimated"`).
      `_resolve_items` no longer clobbers a known masterdata price with 0. Fixes the
      gross_profit==amount_claimed (100%-margin) bug for live ΗΔΥΚΑ. ΓΕΣΥ/synthetic unaffected
      (carry real wholesale). ⚠️ Estimate is approximate — real masterdata/PharmacyOne price
      feed is the proper long-term source (a price-list import remains a good follow-up).
- [ ] Verify ΗΔΥΚΑ `repeat_total`/`repeat_current` mapping against the real spec
      (drives future-prescription generation).
- [ ] End-to-end tests for `IngestionEngine` (dedup, idempotency, future-rx, counters).
- [ ] Integration tests (FastAPI `TestClient`) for auth, RBAC gating, tenant isolation.

## P1 — Complete the stubs (compliance-ordered)

- [ ] Implement data retention/erasure worker (`apply_retention`) — **GDPR**.
- [ ] Implement profitability snapshots worker (`compute_nightly`).
- [ ] Implement tenant data export (GDPR portability).
- [ ] Move blocking HDIKA sync off the event loop (background task, not sync-in-async).

## P2 — Maintainability

- [ ] Split `admin.py` (1.164 LOC, ~12 concerns) into routers + services.
- [ ] Extract shared backend utils (`_now/_oid/_slugify/_month_range`, repeated in ~8 files).
- [ ] Unify `apiClient.ts` + `adminClient.ts` (shared `ApiError`/refresh/redirect);
      single `API_BASE`; adopt the `queryKeys` registry consistently.
- [ ] Make ingestion item replace transactional (Mongo session; `rs0` supports it).
- [ ] Add error states to frontend pages currently failing silently.

## P2 — Dependency hygiene

- [ ] Upgrade Next.js → ≥14.2.25 (or 15.x) for known CVEs incl. CVE-2025-29927.
- [ ] Replace `python-jose` → PyJWT (unmaintained, CVE history).
- [ ] Plan Motor → async PyMongo migration (Motor deprecated upstream).
- [ ] Raise `python-multipart` floor ≥0.0.18; replace/upgrade `next-pwa` (Serwist).

## P3 — Productization / scale

- [ ] Real billing (payment provider), GESY automation, myDATA integration.
- [ ] Observability (logs/metrics/Sentry), healthchecks + restart on all services.
- [ ] Mongo HA / backup-restore drills (PITR, offsite, encryption-at-rest).
- [ ] Remove hardcoded server IP from `infra/docker/Caddyfile` before public go-live.
- [x] **T-07** Public TLS hardening — 2026-06-07. `enable-public-tls.sh` no longer
      takes the token as a CLI arg; it ensures `CADDY_TLS=dns cloudflare {env.CF_API_TOKEN}`,
      and if `CF_API_TOKEN` is missing reads it via a HIDDEN prompt (`read -rs`) and writes
      it to `.env` (chmod 600); never prints the value. Added `CADDY_TLS`/`CF_API_TOKEN`
      to `.env.example`; Caddyfile now `{$CADDY_TLS:internal}`. Token confirmed already
      set in the server `.env` (scenario A). *(D-015)*

## Responsive / UI-UX (from 2026-06-07 audit — see responsive-fixes-plan.md)
> All require approval + a live browser/device validation pass (audit was static).
- [x] **T-10/T-11/T-12 (Responsive Phase A/B/C)** DONE 2026-06-08 (on `quick-wins`,
      tsc 0-errors + `next build` exit 0). QueryState on all 9 analytics pages + ModuleGuard;
      `<Modal>`/`<QueryState>` components; DataTable keyboard+fullWidthOnMobile; max-width;
      DialogHost max-h; KPI `md:` grids; BarChart/Heatmap mobile; touch targets; dead-UI
      removed (/pricing, lang, bell); InstallButton mounted; friendly errors; not-found/error
      pages. **Bonus:** fixed 3 pre-existing type errors → enabled the type gate
      (`ignoreBuildErrors:false`). ⚠️ Still needs a real device/emulator + axe/Lighthouse pass.
- [x] **T-14** Migrate the 6 bespoke modals onto `<Modal>` — DONE 2026-06-08 (tsc 0 +
      build exit 0). EditUserModal, OpenTenantModal, Edit/AddStaffModal, PostModal,
      InvoiceModal → all now get focus trap + Esc + focus-restore + max-h scroll. Bonus:
      admin "new staff" password `type=text`→`password` (U-9); friendly errors in those
      modals. (DialogHost left as-is — already has Esc + max-h.) Needs the device pass.
- [~] **T-15** Responsive Phase D — partially done 2026-06-08 (tsc 0 + build exit 0):
      ✅ color-token unification (teal→brand, 51 occ / 10 files); ✅ chart a11y
      (`role="img"`+aria-label on Line/Bar/Donut/Heatmap); ✅ chart contrast (axis +
      visualMap `#94a3b8`→`#64748b`).
      **T-15b (partly done 2026-06-08, tsc 0 + build exit 0):**
      ✅ Toast system built (`store/toastStore.ts` + `components/ui/ToastHost.tsx`, mounted in
      Providers; `toastSuccess/Error/Info`, auto-dismiss, aria-live) — modeled on dialogStore;
      adopted additively in orders recompute as proof. ✅ Targeted contrast: `.rx-label`
      slate-400→500.
      ⏳ **Still needs a browser/visual + UX review (NOT done unattended):** migrate the ~10
      scattered inline `notice` strings to toasts (behavior change); **react-hook-form
      standardization across ~10 forms** (large refactor, high regression risk tsc can't catch);
      broad `text-slate-400` body-text contrast sweep (visual judgment).
- [x] **T-16** ESLint enabled — DONE 2026-06-08. Added `.eslintrc.json` (next/core-web-vitals)
      + `eslint`/`eslint-config-next` devDeps; lint clean (0/0); flipped
      `eslint.ignoreDuringBuilds:false`. `npm run build` passes with BOTH type+lint gates.
      Side effect: `frontend/package-lock.json` was generated — regenerate cleanly with a
      fresh `npm install` before relying on it (it came from a partial `--no-save` install).
- [ ] **T-13 (Phase D leftovers)** Consistency/a11y not yet done: shared `<StatusBadge>` +
      use `lib/formatters` (dedup), breadcrumbs, password show/hide toggles, ingestion
      test-without-silent-save. (Color tokens / chart a11y / chart contrast already done in T-15.)

- [~] **Responsive QA test** — 2026-06-08: real-browser pass (Playwright+Chromium via the
      playwright Docker image vs `next dev`). **31 routes (19 tenant/auth + 12 admin) × 6
      widths = 186 overflow checks, ALL clean** after 2 fixes: `/orders`@320 (header button
      group → `w-full flex-wrap`) and `/admin/noeton`@320/390 (long URL `<code>` → `break-all`).
      See `responsive-qa-results.md`. ⏳ Remaining QA: data-dense pages (need seeded backend),
      axe/Lighthouse a11y/perf. (2 fixes + report uncommitted, pending the rebase batch.)

### Audit status
- [x] Full audit complete — 2026-06-07. Reports in repo root + `docs/audit-summary.md`
      (scores + top-20) + `docs/execution-roadmap.md`. *(D-020)*

---

### Ανοιχτές αποφάσεις ιδιοκτήτη — 2026-09-21 (add-ons / χρέωση)
> **Ενημέρωση 2026-09-23:** το (1) ΕΓΙΝΕ (αναλογική χρέωση στην ενεργοποίηση + φρουρός κάρτας)
> και το (3) ΕΓΙΝΕ (ανάκληση όσων ήταν ενεργά χωρίς πληρωμή· εξαιρέθηκαν Παπαγιαννόπουλος και
> δοκιμές). Μένει ανοιχτό μόνο το (2).
1. ~~**Αναλογική χρέωση στο `addon_service.activate()`;**~~ ✅ 2026-09-23. Σήμερα η ενεργοποίηση add-on δεν εκδίδει
   τιμολόγιο και δεν χρεώνει κάρτα — μπαίνει μόνο στο `addons_total` της ΑΝΑΝΕΩΣΗΣ. Ετήσιος
   πελάτης που ανοίγει add-on στη μέση της περιόδου το έχει δωρεάν ως τη λήξη (ΜΠΙΝΙΚΟΣ:
   ~10,5 μήνες / ~87 €). Τα seats και η αλλαγή πλάνου χρεώνουν αναλογικά — τα add-ons όχι.
2. **Φύλακας στον πίνακα Modules;** Το `PUT /admin/tenants/{id}/modules` μπορεί να κλειδώσει
   module που ο πελάτης ΠΛΗΡΩΝΕΙ ως add-on, χωρίς καμία προειδοποίηση (συνέβη στον ΜΠΙΝΙΚΟ).
3. ~~**Δωρεάν παραχωρήσεις:**~~ ✅ 2026-09-23 — Παπαγιαννόπουλος & Κολελής έχουν `daily_coach` + `vaccination_programs`
   χωρίς χρέωση (κατάλοιπα δοκιμών). Να καθαριστούν ή να μείνουν;

---

### RxVision Connect — V2 (2026-09-24)
0. **Συνομιλία μέσα στο Connect — ΕΞΕΤΑΣΤΗΚΕ, ΑΝΑΒΛΗΘΗΚΕ (24/09).** Ο ιδιοκτήτης ρώτησε αν
   πρέπει να ενσωματωθεί η συνομιλία στο Connect. Απόφαση: **μένει ως έχει**, επανεξέταση με
   πραγματική χρήση. Τι να θυμάσαι όταν ξανατεθεί:
   · **Πλήρης συγχώνευση δεν γίνεται** — η συνομιλία είναι ΔΩΡΕΑΝ core module, το Connect
     30 €/μ. Ένα module σημαίνει ή να πάρεις πίσω κάτι δωρεάν ή να χαρίσεις το Connect.
   · **Η πρόταση που έμεινε στο ράφι:** νήμα συζήτησης **πάνω στο αίτημα/κίνηση** (ορατό μόνο
     στους εμπλεκόμενους), όχι γενική ομάδα. Κρατά και την κουβέντα και την καταγραφή.
   · **Ο κίνδυνος που το δικαιολογεί:** αν η κουβέντα αντικαταστήσει τα δομημένα αιτήματα,
     χάνεται το υπόλοιπο, η δέσμευση αποθέματος και η αναζησιμότητα — ένα thread είναι
     ψηφιακό χαρτάκι, και το «το χαρτάκι χάνεται» είναι ΟΛΟ το επιχείρημα του Connect.
1. **Ειδοποιήσεις εκτός οθόνης.** Σήμερα υπάρχει μόνο η ένδειξη στο Topbar. Λείπουν email/SMS
   για «νέο αίτημα», «η κράτησή σου λήγει», «ζητήθηκε επιστροφή».
2. **Γέφυρα δικτύων (§23).** Συγκρούεται με το §3 (το Α δεν μαθαίνει για το δίκτυο του Β).
   Προτεινόμενη λύση: **ρητή ανθρώπινη προώθηση** από τον ενδιάμεσο· το Α βλέπει μόνο ότι
   προωθήθηκε και ότι η κάλυψη έρχεται από το Β.
3. **Έξυπνο ταίριασμα:** απόσταση, ώρες λειτουργίας, ταχύτητα απάντησης, ιστορικό επιτυχίας.
4. **Δείκτες αξιοπιστίας συνεργάτη** + προτεινόμενοι συνεργάτες.

---

### Ανοιχτά — 2026-09-23
1. **Μάρκα & κατασκευαστής** για τα 41.119 ενεργά προϊόντα. Η *μάρκα* βγαίνει με AI από τα
   ονόματα. Ο *κατασκευαστής* **δεν έχει έγκυρη πηγή**: η ΗΔΥΚΑ (`medicine_catalog`) δεν τον
   δίνει· σωστή πηγή θα ήταν το δελτίο τιμών ΕΟΦ, που δεν το εισάγουμε. Απόφαση ιδιοκτήτη.
2. **Πρόσκληση συνομιλίας:** να μπλοκάρεται και ο *αποστολέας* όταν είναι σε δοκιμαστική
   συνδρομή; (σήμερα μπλοκάρεται μόνο ο παραλήπτης χωρίς ενεργή συνδρομή)
3. **Τιμές στο site:** το delta της 23/09 στάλθηκε με τιμές (25/15/10 €) — να μπουν και στη
   σελίδα τιμολόγησης ή να μείνουν μόνο στις περιγραφές;

### ΑΥΡΙΟ 26/09/2026

**Από τις Δομές/Οικογένειες (χτες):**
1. **SMS/Viber στη δομή** — το email μπήκε (δωρεάν)· τα μηνύματα χρεώνονται από το πορτοφόλι,
   θέλει απόφαση ιδιοκτήτη.
2. **Lovable delta** — το prompt δόθηκε, ΔΕΝ στάλθηκε ακόμη (τρία άρθρα + κυκλώματα + τιμές).
3. Η «Λίστα προς τη δομή» πατά στο `next_open_date`. Εντελώς **νέα** αγωγή χωρίς ιστορικό δεν
   εμφανίζεται — κανένα σύστημα δεν μπορεί να το ξέρει από τα δεδομένα ΗΔΥΚΑ. Να ειπωθεί στον
   πελάτη ως όριο, όχι να «λυθεί».

### ✅ ΕΓΙΝΕ 25/09 — φύλακας πληρότητας (v1.63.0)
`deep_gap_scan`: συγκρίνει το `exec_count` της ΗΔΥΚΑ με όσες εκτελέσεις κρατάμε, ΑΝΕΞΑΡΤΗΤΑ
ηλικίας, και πυροδοτεί το υπάρχον `hdika_backfill`. Beat Κυριακή 04:10. Πρώτο πέρασμα: 363
συνταγές / 521 εκτελέσεις, 41 παράθυρα στην ουρά.

### ΑΚΟΜΗ ΕΚΚΡΕΜΕΙ — από τον έλεγχο ΗΔΥΚΑ (24/09)
1. **Φύλακας πληρότητας εκτελέσεων** (το κυριότερο). Η ΗΔΥΚΑ μάς δίνει `details.exec_count` +
   `active_executions` σε κάθε συνταγή και **δεν τα χρησιμοποιούμε πουθενά**. Ημερήσιο task:
   όπου `exec_count` > όσες κρατάμε → ξανακατέβασε. Κλείνει **363 συνταγές / 521 εκτελέσεις**
   (10/13 φαρμακεία) και πιάνει κάθε μελλοντική. Είναι ΚΑΤΩ ΟΡΙΟ — το `exec_count` είναι
   στιγμιότυπο, άρα όσες προστέθηκαν μετά δεν φαίνονται. Εκτ. μισή μέρα.
2. **Λεξικό πεδίων ΗΔΥΚΑ** (ενέργεια ιδιοκτήτη): 63 από 132 αναγνωριστικά CDA δεν τα διαβάζουμε
   και **δεν ξέρουμε τι σημαίνουν πολλά** — δουλεύουμε με αντίστροφη μηχανική. Χωρίς επίσημη
   τεκμηρίωση δεν μπορεί να δοθεί εγγύηση ότι δεν αγνοούμε κάτι σημαντικό (σήμερα βρέθηκαν δύο).
3. **Απόθεμα — ΟΧΙ πριν υπάρχουν σωστά δεδομένα** (απόφαση ιδιοκτήτη). 13 είδη με απόθεμα σε όλα
   τα φαρμακεία. Όταν έρθει: το `daily_coach._STOCK_MIN = 20` να γίνει **ποσοστό κάλυψης**, όχι
   απόλυτος αριθμός — 25 είδη από 3.600 ξεκλειδώνουν σήμερα και τα 4 σήματα αποθήκης.

---

### Open questions for the user (carry forward)
1. Go-live market priority — Greece (ΗΔΥΚΑ) first, or GR+CY together? (affects GESY automation priority)
2. Security-first sequencing vs parallel feature work for demos?
3. ~~Public TLS method~~ → RESOLVED 2026-06-07: Let's Encrypt via Cloudflare DNS-01 (D-015).

## Partner API — μετά το v1.66.0 (27/09/2026)

**Προς τον ιδιοκτήτη (απόφαση, δεν το αποφασίζω εγώ):**
- [ ] **Επιβεβαίωση GDPR** για την αντιστοίχιση πελάτη: υλοποιήθηκε **ΑΜΚΑ ή κινητό**, πίσω από
      `patients:read` + ρητή αποδοχή + καταγραφή. Αν θέλεις **μόνο ΑΜΚΑ**, ή χειροκίνητη
      αντιστοίχιση από τον φαρμακοποιό, αλλάζει σε μία συνάρτηση (`partner_customers.resolve`).
- [ ] **Σημείωση έκδοσης v1.66.0** από το `/admin/release-notes` (δεν γράφεται από το shell).
- [ ] Θέλουμε το `pos_earn_pct` **ανοιχτό** στον δοκιμαστικό πελάτη T-C838D2E4; Δεν το άνοιξα —
      είναι χρήμα του φαρμακείου, δική του απόφαση.

**Τεχνικά, σε σειρά αξίας:**
- [ ] **Όριο ρυθμού (rate limit)**: τεκμηριώνεται 600/min αλλά **δεν είναι συνδεδεμένο**. Είναι το
      μόνο σημείο όπου το Swagger υπόσχεται κάτι που δεν ισχύει.
- [ ] **Webhooks** RxVision → συνεργάτη (νέα παραγγελία e-shop, επανάληψη που ώριμασε, χαμηλό
      απόθεμα). Τώρα ο συνεργάτης πρέπει να ρωτά· θα έπρεπε να τον ειδοποιούμε.
- [ ] `POST /v1/purchases` (τιμολόγια προμηθευτή → **πραγματική χονδρική** → αληθινή κερδοφορία).
- [ ] `POST /v1/stock/snapshot` (απογραφή, αντί μόνο κινήσεων).
- [ ] `GET /v1/customers/{ref}/insights` — η εικόνα πελάτη πίσω στο ταμείο τους.
- [ ] `patients:read` υπάρχει και **τώρα χρησιμοποιείται** (σύνδεση + κλινικά με αγωγή). Έμεινε
      ερώτημα: θέλουμε endpoint που επιστρέφει **λίστα** ασθενών; Προς τώρα ΟΧΙ, σκόπιμα.
- [ ] Μέλος πιστότητας **χωρίς αλυσίδα επαναλήψεων** φαίνεται στο API αλλά **όχι** στη λίστα της
      οθόνης (`_build_members` το φιλτράρει). Τα νούμερα συμφωνούν για όποιον εμφανίζεται· ο
      φαρμακοποιός όμως δεν μπορεί να δει/διορθώσει ένα τέτοιο πορτοφόλι. Μικρή ακμή, να λυθεί.

## Κερδοφορία — μετά τον έλεγχο 28/09/2026
- [ ] **Απόφαση ιδιοκτήτη:** εξαιρεμένες εκτελέσεις στην αποζημίωση — το `stats_exclusion` λέει «όχι», ο κώδικας τις φιλτράρει.
- [ ] `snapshots.compute_nightly` / `apply_retention`: stubs στο beat κάθε νύχτα — υλοποίηση ή αφαίρεση (+ ευρετήριο `profitability_snapshots`).
- [ ] KPI περιθωρίου: σύγκριση σε **μονάδες** (26,4% → 25,3% = −1,1 μ.), όχι % μεταβολή ποσοστού.
- [ ] Πραγματική χονδρική από τιμολόγια αγορών (`POST /v1/purchases`) → εκπτώσεις φαρμακαποθήκης στο κέρδος.
- [ ] **Τεμάχια ×N σε όλη την εφαρμογή:** η ΗΔΥΚΑ δίνει μία συνταγή ως πολλές εγγραφές με όλα τα είδη σε καθεμία. Κερδοφορία & συνέπεια διορθώθηκαν (28/09)· χαρτογράφηση κάθε άλλου αθροίσματος `executed_qty`/`quantity` ανά εγγραφή.
- [ ] **Διπλά προϊόντα ΕΟΦ vs EAN** (αιτία: καθημερινός συγχρονισμός χωρίς κατάλογο — διορθώθηκε 28/09, μένει επισκευή 19.943 εκτελέσεων): υπενθυμίσεις/σχήματα θεραπεύονται αυτόματα (`_rekey_forked`)· απομένει χαρτογράφηση απόθεμα / κατάλογος / e-shop / χονδρική ανά προϊόν → ενοποίηση ανά ΕΟΦ.
