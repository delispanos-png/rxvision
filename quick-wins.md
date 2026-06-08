# RxVision — Quick Wins

> Read-only ανάλυση. Γρήγορες βελτιώσεις: υψηλό όφελος, μικρό-μέτριο κόστος, χαμηλό ρίσκο. **Καμία δεν εφαρμόστηκε** — απαιτείται έγκριση πριν από κάθε αλλαγή κώδικα.
> Ημερομηνία: 2026-06-07.

| # | Quick win | Αρχείο(α) | Όφελος | Κόπος |
|---|---|---|---|---|
| 1 | **Fail-fast σε prod αν `JWT_SECRET`/pepper = default** | `core/config.py:20,26` + startup check σε `main.py` | Κλείνει την πιο σοβαρή τρύπα (C1) | ~10 γρ. |
| 2 | **Escape του `search` πριν το `$regex`** (ή anchored prefix) | `repositories/doctors.py:17` | Εξαλείφει ReDoS DoS (H3) | ~3 γρ. |
| 3 | **Hardened lxml parser** (`resolve_entities=False, no_network=True`) | `services/ingestion/gesy.py:52` | Κλείνει XXE (M1) | ~3 γρ. |
| 4 | **Άνω-φραγή σε `limit`/`page_size`** (π.χ. `min(limit, 200)`) | `prescriptions.py:23`, `patients.py:38`, `users.py:60`, `base.py` | Αποτρέπει memory/DoS από τεράστια σελίδα | ~1 γρ. ανά endpoint |
| 5 | **Reset token: hash + atomic single-use + έλεγχος status** | `services/account_service.py:81-104` | Κλείνει H2 | ~15 γρ. |
| 6 | **Απόρριψη `padmin` tokens στο tenant context** | `core/deps.py:46-65` | Διαχωρισμός ταυτοτήτων (H1, μερικώς) | ~3 γρ. |
| 7 | **Auth/password σε Mongo & Redis + αφαίρεση published ports σε dev** | `docker-compose.yml` | Κλείνει H4 | config-only |
| 8 | **Vault TLS + firewall Portainer `:9000`** | `infra/docker/vault/vault.hcl`, `docker-compose.prod.yml:107` | Κλείνει H5/H6 | config-only |
| 9 | **`sandbox` attribute στο newsletter preview iframe** | `admin/newsletter/page.tsx:361` | Κλείνει XSS surface (M4) | 1 attr |
| 10 | **Ελάχιστη CI** (lint + mypy + ruff + pytest σε push) | νέο `.github/workflows/ci.yml` | Σταματά να μπαίνει νέο debt· τρέχει τα 3 υπάρχοντα tests | ~40 γρ. yaml |

## Bonus (πολύ φθηνά, καθαριότητα)

- **A.** Αφαίρεση hardcoded server IP `157.180.26.98` από `infra/docker/Caddyfile:48-50` πριν το go-live.
- **B.** Συμπλήρωση `.env.example` με `CADDY_TLS`, `CF_API_TOKEN`, Noeton/SMTP/Stripe keys (έστω placeholders + σχόλια).
- **C.** Ενοποίηση `apiClient.ts` + `adminClient.ts` (κοινό `ApiError`/refresh/redirect) και μοναδικό `API_BASE`.
- **D.** Healthcheck στο `api`/`web` (`/health`) στο compose + `condition: service_healthy` στα `depends_on`.
- **E.** `npm install` → `npm ci` και `pip install -e` → pinned/locked install· πρόσθεσε lockfiles.
- **F.** Κοινό `utils` module για `_now/_oid/_slugify/_month_range` (αφαιρεί διπλασιασμό σε ~8 αρχεία).
- **G.** Διόρθωση dead link `/pricing` (`login/page.tsx:137`).
- **H.** Ξεκλείδωμα build gates **σταδιακά**: άρση `ignoreBuildErrors` αφού περάσει `tsc` (πιθανώς λίγα errors λόγω `strict`).

## Σημείωση προτεραιότητας

Τα **#1–#3 και #5–#8** είναι ασφάλεια υψηλής αξίας με ελάχιστο κώδικα — ιδανικά για άμεση εφαρμογή. Το **#10 (CI)** πολλαπλασιάζει την αξία όλων των υπολοίπων γιατί τα κρατά «κλειστά». Όλα προτείνονται· **δεν θα γίνει καμία αλλαγή χωρίς τη ρητή έγκρισή σου.**
