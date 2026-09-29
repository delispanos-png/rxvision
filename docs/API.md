# RxVision — REST API (v1)

Base: `/api/v1` · Auth: `Authorization: Bearer <access_jwt>` · Format: JSON ·
Errors: RFC-7807 `application/problem+json`.

Κάθε endpoint είναι **tenant-scoped** (tenant από JWT) και προστατευμένο με
`require(permission, module)`. Λίστες υποστηρίζουν `?page&page_size&sort` + cursor σε
βαριά endpoints. Φίλτρα χρόνου: `?date_from&date_to` (ISO) ή `?period=2026-05`.

## ⚠ Δύο διαφορετικά API — μην τα μπερδέψεις

| | Εσωτερικό API | Partner API |
|---|---|---|
| Ποιον εξυπηρετεί | την εφαρμογή μας (web/PWA) | προγράμματα τρίτων |
| Διαδρομή | `/api/v1/*` | `/api/partner/v1/*` |
| Ταυτοποίηση | JWT (15΄) — **άνθρωπος** | `X-API-Key` (μήνες) — **πρόγραμμα** |
| OpenAPI | **κλειστό** στην παραγωγή | **ανοιχτό** στο `developers.rxvision.gr` |
| Τεκμηρίωση | αυτό το αρχείο | το ίδιο το Swagger + `ARCHITECTURE.md` §10δ |

**Το Partner API καλύπτει (27/09/2026):** κατάλογο · απόθεμα (ανάγνωση + κινήσεις) · εκτελέσεις
(χωρίς ταυτότητα ασθενή) · **πωλήσεις ταμείου** (ΜΗ.ΣΥ.ΦΑ./παραφάρμακα/υπηρεσίες) · παραγγελίες
e-shop · **γέφυρα πελάτη** · **πρόγραμμα επιβράβευσης στο ταμείο** · **PharmaCat** (αλληλεπιδράσεις
+ συμβουλές). 16 endpoints. Πλήρης ανάλυση: `ARCHITECTURE.md` §10δ και το Swagger στο
`developers.rxvision.gr`.

**Έκδοση Partner API: 1.1.0.** Κάθε αλλαγή ανεβάζει το `API_VERSION` (`app/api/partner/app.py`) και
γράφει γραμμή στο changelog του Swagger — είναι η μόνη ανακοίνωση που φτάνει στον συνεργάτη. Το
`GET /v1/ping` επιστρέφει την ίδια τιμή. **Ξεχωριστό** από την έκδοση προϊόντος (1.66.0).

Ό,τι ακολουθεί σε **αυτό** το αρχείο αφορά το **εσωτερικό** API.

## Auth
| Method | Path | Permission | Σημείωση |
|---|---|---|---|
| POST | `/auth/login` | public | email+password (+MFA) → access+refresh |
| POST | `/auth/refresh` | public | rotating refresh token |
| POST | `/auth/logout` | auth | invalidates refresh (version bump) |
| GET | `/auth/me` | auth | user, tenant, roles, modules |
| POST | `/auth/mfa/enroll` `/auth/mfa/verify` | auth | TOTP |

**Login response:**
```json
{"access_token":"jwt","refresh_token":"jwt","expires_in":900,
 "user":{"id":"...","tenant_id":"...","roles":["manager"],
         "modules":{"profitability":"enabled","pharmacyone":"trial"}}}
```
JWT claims: `sub, tid, roles[], modules{}, scope, exp, iat, jti`.

## Tenants & admin
| Method | Path | Permission |
|---|---|---|
| GET/PATCH | `/tenant` | `settings:read` / `settings:write` |
| GET/PATCH | `/tenant/modules` | `settings:write` |
| POST | `/tenant/export` | `settings:write` (async job → download URL) |
| POST | `/tenant/deletion-request` | `owner` (GDPR right-to-be-forgotten) |
| CRUD | `/users` `/users/{id}` | `users:manage` |
| CRUD | `/roles` `/roles/{id}` | `users:manage` |
| GET | `/permissions` | `users:manage` |
| CRUD | `/pharmacies` | `settings:write` |

## Back-office (CloudOn staff) — ομάδες & δικαιώματα

Ξεχωριστή ταυτότητα από τους χρήστες φαρμακείων: `padmin` token από
`POST /platform/auth/login` (ΟΧΙ `/auth/login`). Δύο διαφορετικά συστήματα σύνδεσης.

**Το μοντέλο:** τα δικαιώματα ζουν **μόνο σε ομάδες** (`platform_groups`). Ο χρήστης
παίρνει ομάδες (`platform_admins.group_ids`) και τα δικαιώματά του είναι η **ένωση**
τους. Ένα δικαίωμα ανά **ενέργεια** (`tenants:read` ≠ `tenants:delete`), σε μορφή
`resource:action`. Ο `super_admin` κουβαλά wildcard `*`.

**Εξουσιοδότηση:** κεντρικός χάρτης `(method, route template) → permission` στο
`app/services/platform_rbac.py`, που επιβάλλεται από το router-level
`require_padmin(scope)` (δηλώνεται στο `app/api/v1/__init__.py`). Καλύπτει και τους
τέσσερις back-office routers: `admin`, `admin_leads`, `platform/cloud`,
`platform/fund-groups`.

⚠️ **Deny by default**: διαδρομή εκτός χάρτη → `403 route_not_mapped`. Κάθε νέο
endpoint ΠΡΕΠΕΙ να δηλωθεί στον χάρτη, αλλιώς δεν δουλεύει για κανέναν πλην super
admin. Το `tests/test_platform_rbac.py` αποτυγχάνει στο CI αν ξεχαστεί.

Τα δικαιώματα **δεν** μπαίνουν στο token — διαβάζονται ανά request, οπότε αλλαγή
ομάδας ισχύει άμεσα, χωρίς επανασύνδεση.

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/permissions` | κάθε συνδεδεμένος admin (κατάλογος για το UI) |
| GET | `/admin/sections` | κάθε συνδεδεμένος admin (ετικέτες ενοτήτων) |
| GET | `/admin/groups` | `staff:read` |
| POST | `/admin/groups` | `staff:manage` |
| PATCH/DELETE | `/admin/groups/{id}` | `staff:manage` |
| GET | `/admin/staff` | `staff:read` |
| POST/PATCH/DELETE | `/admin/staff[/{id}]` | `staff:manage` |
| POST | `/admin/staff/{id}/reset-password` · `/send-credentials` | `staff:password` |

**Επικίνδυνα δικαιώματα** (`sensitive`): δεν μπαίνουν ποτέ σε προεπιλεγμένη ομάδα και
κάθε χρήση τους καταγράφεται στο `audit_logs` —
`tenants:impersonate` (δεδομένα ασθενών), `tenants:credentials`,
`tenants:send_credentials`, `tenants:delete`, `tenants:items_delete`,
`subscriptions:trials_purge`, `integrations:write`, `integrations:rotate`,
`monitoring:audit`, `staff:manage`, `staff:password`, `system:purge`,
`cloud:write`, `cloud:ops`.

Προεπιλεγμένες ομάδες: Μόνο ανάγνωση · Υποστήριξη πελατών · Πωλήσεις · Λογιστήριο ·
Marketing · Τεχνική υποστήριξη.

## Ingestion
| Method | Path | Permission | Σημείωση |
|---|---|---|---|
| PUT | `/ingestion/credentials/hdika` | `settings:write` | creds → Vault (write-only) |
| POST | `/ingestion/hdika/sync` | `ingestion:run` | trigger manual sync |
| POST | `/ingestion/gesy/upload` | `ingestion:run` | multipart XML upload |
| GET | `/ingestion/jobs` | `ingestion:read` | list sync_jobs + stats |
| GET | `/ingestion/jobs/{id}` | `ingestion:read` | job detail + errors |

## Dashboard
| GET | `/dashboard/summary` | `dashboard:read` | KPIs περιόδου (precomputed) |
| GET | `/dashboard/timeseries?metric=executions|value|claimed&grain=day|month` |
| GET | `/dashboard/top?dim=doctors|icd10|products&limit=10` |

## Prescription Analytics
| GET | `/prescriptions` | `prescriptions:read` | filtered list + paging |
| GET | `/prescriptions/{id}` | with items drill-down |
| GET | `/prescriptions/aggregate?group_by=fund|doctor|icd10|product&date_from&date_to` |
| GET | `/prescriptions/compare?period_a=2026-04&period_b=2026-05` | συγκρίσεις |
| GET | `/prescriptions/trends?metric=value&grain=month&months=12` |

Όλα τα analytics endpoints δέχονται κοινά φίλτρα:
`fund_id, doctor_id, icd10, product_id, category, pharmacy_id`.

## Doctor / Patient / ICD-10 Analytics
| GET | `/doctors` · `/doctors/{id}/stats` | `doctors:read` | συνταγές/αξία/κερδοφορία/νέοι πελάτες |
| GET | `/doctors/{id}/new-patients?date_from&date_to` |
| GET | `/patients/aggregate?by=age_group|sex|area|lifecycle` | `patients:read` (ανώνυμα) |
| GET | `/patients/retention?cohort=2026-01` |
| GET | `/icd10/aggregate?metric=count|value|profit` | `icd10:read` |

## Profitability Engine
Όλα με `profitability:read` και `date_from`/`date_to` (εκτός από το `aging`).

| GET | `/profitability/summary` | κεφαλίδα: κέρδος, περιθώριο, % εκτιμώμενου κόστους, περικοπές, καθαρό |
| GET | `/profitability/attention` | χάρτης προσοχής: KPIs (απόδοση κεφαλαίου, κέρδος/συνταγή/πελάτη, συγκέντρωση, βάρος ΦΥΚ) + ενότητες σε 4 διαστάσεις (`category`, `kind`, `price_band`, `fund`) με `impact`, `verdict` (pressure/helps/neutral), `reason`, σύγκριση με πέρσι + `focus` |
| GET | `/profitability/by?dim=fund|doctor|icd10|product|type` | (`category` = παλιό συνώνυμο του `type`) |
| GET | `/profitability/by-category` | θεραπευτική κατηγορία (ATC) |
| GET | `/profitability/low-margin?threshold_pct=10` | είδη χαμηλής κερδοφορίας (χωρίς περίοδο → 90 ημέρες) |
| GET | `/profitability/aging` | ανοιχτά υπόλοιπα ταμείων ανά ηλικία |

## Future Prescriptions & Orders
| GET | `/future/upcoming?days=14` | `future:read` | συνταγές που ανοίγουν |
| GET | `/future/forecast?product_id&horizon_days=30` | πρόβλεψη ζήτησης |
| GET | `/orders/suggestions` | `orders:read` | πρόταση παραγγελίας |
| POST | `/orders/suggestions/recompute` | `orders:run` |

## Monthly Closing
| GET | `/closing/{period}/control` | `closing:read` | έλεγχος προ-κλεισίματος |
| GET | `/closing/{period}/discrepancies` | ασυμφωνίες/ελλείψεις |
| GET | `/closing/{period}/fund-totals` | συγκεντρωτικά ανά ταμείο |
| POST | `/closing/{period}/lock` | `closing:run` | κλείδωμα περιόδου |

## PharmacyOne add-on
| GET | `/pharmacyone/sales?date_from&date_to` | `pharmacyone:read` |
| GET | `/pharmacyone/by-seller` · `/by-user` |
| GET | `/pharmacyone/unexecuted` | ανεκτέλεστα συνταγών |

## Subscriptions / Billing
| GET | `/subscription` | `auth` | τρέχον plan, limits, modules |
| POST | `/subscription/checkout` | `billing:manage` | upgrade/downgrade |
| GET | `/subscription/usage` | usage vs limits |

## Copilot (AI βοηθός)

`POST /copilot/chat` — gate: `patients:read` + module `ai_assistant`.

Ο βοηθός απαντά καλώντας **εργαλεία** (ορίζονται στο `app/services/copilot_service.py`).
Τα συγκεντρωτικά (`get_kpis`, `get_top`, `get_profitability`, …) συνυπάρχουν με το
**`list_prescriptions`**, που επιστρέφει **μεμονωμένες συνταγές** — όχι αθροίσματα.

| Παράμετρος | Τιμή |
|---|---|
| `year` | «2025» → ολόκληρο ημερολογιακό έτος |
| `month` | «YYYY-MM» |
| `date_from` / `date_to` | «YYYY-MM-DD» (το `date_to` συμπεριλαμβάνεται) |
| `days_back` / `months_back` | κυλιόμενο εύρος |
| `min_amount` / `max_amount` | σε **ΕΥΡΩ** (μετατρέπονται σε cents εσωτερικά) |
| `sort` | `amount_total` (default, φθίνουσα) ή `executed_at` |
| `limit` | έως 50 |
| `patient_name` · `icd10` · `status` · `unexecuted_only` | προαιρετικά φίλτρα |

Το `year` / `date_from` / `date_to` προστέθηκαν στο κοινό `_range()`, άρα ισχύουν για **όλα**
τα εργαλεία. Πριν, ερωτήσεις τύπου «το 2025» έπεφταν σιωπηλά στο κυλιόμενο 1μηνο.

**Δικαιώματα:** το `list_prescriptions` απαιτεί **`prescriptions:read`** — αυστηρότερο από τον
υπόλοιπο Copilot, επειδή επιστρέφει γραμμές με ονόματα ασθενών αντί για σύνολα. Χωρίς αυτό δεν
διαφημίζεται καν στο μοντέλο, και η εκτέλεσή του απορρίπτεται (έλεγχος σε δύο σημεία).
Το ΑΜΚΑ αφαιρείται πάντα πριν φύγει οτιδήποτε προς το LLM (`_scrub_amka`), και σε tenant
«παρουσίασης» τα ονόματα ψευδωνυμοποιούνται.

## Κυκλώματα εβδομάδας 20–27/09/2026

Όλα **tenant-scoped** (φρουρός `require(...)` + module gate)· τα πρόσθετα επιστρέφουν **402**
όταν το module είναι κλειδωμένο. Η ταυτότητα έρχεται **πάντα από το token** — κανένα endpoint
δεν δέχεται «για ποιον» στο σώμα του αιτήματος.

### Προχορηγήσεις — «δανεικά» *(add-on `advance_dispensings`, 25 €/μήνα)*
| GET | `/advance-dispensings` | λίστα δανεικών |
| GET | `/advance-dispensings/patients` · `/advance-dispensings/for-patient` | ανά πελάτη |
| GET | `/advance-dispensings/due-today` · `/advance-dispensings/overdue` | λίστα ημέρας / εκπρόθεσμα |
| GET | `/advance-dispensings/matches` | **Β φάση**: προτάσεις ταύτισης με εκτελεσμένη συνταγή |
| POST | `/advance-dispensings` | νέο — **μία φόρμα → πολλά σκευάσματα** |
| POST | `/advance-dispensings/{loan_id}/status` | ξεχρέωση / αλλαγή κατάστασης |
| POST | `/advance-dispensings/{loan_id}/expected` | πότε θα φέρει τη συνταγή |

Ο πελάτης επιλέγεται **από τη λίστα**, ποτέ ελεύθερο κείμενο. Ο κωδικός είναι **ΟΛΟΚΛΗΡΟ το
GS1**. **Δεν αναρτούμε τίποτα σε ΗΔΥΚΑ/HMVO** — το κάνει το εμπορικό πρόγραμμα· το κύκλωμα
είναι καθαρά ενημερωτικό.

### Οικογένειες *(add-on `patient_groups`, 15 €/μήνα)*
| GET | `/patient-groups` · `/patient-groups/{gid}` · `/patient-groups/patients` | λίστα, μία ομάδα, υποψήφιοι |
| GET | `/patient-groups/for-patient/{patient_id}` | σε ποιες ομάδες ανήκει |
| GET | `/patient-groups/family-alerts/{patient_id}` | **ειδοποιήσεις μελών** στην Εικόνα Πελάτη |
| GET | `/patient-groups/{gid}/lists` | φύλλα εργασίας |
| POST | `/patient-groups` · PATCH `/patient-groups/{gid}` · DELETE `/patient-groups/{gid}` | δημιουργία / μετονομασία / διαγραφή |
| POST | `/patient-groups/{gid}/members` | προσθήκη μέλους |
| PATCH | `/patient-groups/{gid}/members/{pseudo_id}` | αλλαγή ρόλου (π.χ. «Γονέας») |
| DELETE | `/patient-groups/{gid}/members/{pseudo_id}` | **αφαίρεση — κλείνει ΚΑΙ τις δύο πόρτες** |

Μέλος = **`pseudo_id`**, ποτέ ΑΜΚΑ. Μέλος «σε αναμονή» (μπήκε με σκέτο ΑΜΚΑ) συνδέεται μόνο
του με την πρώτη συνταγή του.

### Δομές Φροντίδας *(add-on `care_structures`, 20 €/μήνα — ΞΕΧΩΡΙΣΤΟ από τις Οικογένειες)*
| GET | `/care-structures` · `/care-structures/{gid}` · `/care-structures/portfolio` | λίστα / μία δομή / χαρτοφυλάκιο |
| GET | `/care-structures/{gid}/cycle` | κύκλος ετοιμασίας |
| GET | `/care-structures/{gid}/owed` | **τι χρωστά** η δομή |
| GET | `/care-structures/{gid}/statement` | λογαριασμός περιόδου |
| GET | `/care-structures/{gid}/instructions` | οδηγίες λήψης |
| POST | `/care-structures/{gid}/owed/send` | αποστολή λογαριασμού στη δομή |
| POST | `/care-structures/{gid}/instructions/send` | αποστολή οδηγιών λήψης |
| POST | `/care-structures/{gid}/entries` | χειροκίνητη εγγραφή |
| DELETE | `/care-structures/{gid}/entries/{eid}` | διαγραφή εγγραφής |
| PATCH | `/care-structures/{gid}/settings` | `charges_from`, `care_type` κ.λπ. |

⚠ Μοιράζονται τη συλλογή `patient_groups` με τις Οικογένειες, αλλά είναι **χωριστό πρόσθετο**:
όποιος αγόρασε μόνο τις Δομές δεν πρέπει να πάρει 403 πουθενά. «Δομή» **δεν σημαίνει κτίριο** —
το `care_type` καλύπτει και κατ' οίκον φροντίδα, ακόμη και ιδιώτη φροντιστή.

### Εξουσιοδοτήσεις φροντίδας — «Ποιος βλέπει ποιον» *(module ΠΥΛΗ ΠΕΛΑΤΩΝ)*
| GET | `/patient-access` | **όλες** οι ενεργές εξουσιοδοτήσεις (landing list, χωρίς αναζήτηση) |
| GET | `/patient-access/patients` · `/patient-access/for-patient/{patient_id}` · `/patient-access/viewable/{patient_id}` | υποψήφιοι / ανά ασθενή |
| POST | `/patient-access/grant` | νέα εξουσιοδότηση |
| DELETE | `/patient-access/{auth_id}` | ανάκληση |

⚠ **Χωριστός router, σκόπιμα:** η βασική χρήση είναι ο ηλικιωμένος **χωρίς παιδιά**. Αν
κλειδωνόταν πίσω από τις «Οικογένειες», αυτή η περίπτωση δεν θα καλυπτόταν ποτέ.
Η **γονική μέριμνα ΔΕΝ περνά από εδώ** — προκύπτει αυτόματα από τον ρόλο «Γονέας» + την ηλικία
(`services/portal_access.py`) και παύει στα 18.

### RxVision Connect *(add-on `connect`, 30 €/μήνα)*
Δίκτυα συνεργασίας: αίτημα → προσφορά → **διακίνηση** → επιστροφή/εξόφληση.
| GET | `/connect/dashboard` · `/connect/groups` · `/connect/inbox` | επισκόπηση, δίκτυα, εισερχόμενα |
| POST | `/connect/groups` | νέο δίκτυο |
| DELETE | `/connect/groups/{group_id}` · POST `/connect/groups/{group_id}/leave` | διάλυση / αποχώρηση |
| POST | `/connect/invites` | πρόσκληση **με ΑΦΜ** |
| POST | `/connect/invites/{invite_id}` | απάντηση σε πρόσκληση |
| GET/POST | `/connect/requests` | αιτήματα |
| POST | `/connect/requests/{request_id}/offer` | προσφορά σε αίτημα |
| POST | `/connect/requests/{request_id}/decline` | απόρριψη αιτήματος |
| POST | `/connect/offers/{offer_id}/accept` · `/connect/offers/{offer_id}/reject` · `/connect/offers/{offer_id}/withdraw` | απόφαση στην προσφορά |
| GET | `/connect/movements` | διακινήσεις |
| POST | `/connect/movements/{movement_id}/deliver` · `/connect/movements/{movement_id}/return` · `/connect/movements/{movement_id}/cancel` · `/connect/movements/{movement_id}/settle` | παράδοση / επιστροφή / ακύρωση / εξόφληση |
| POST | `/connect/movements/{movement_id}/dispute` | δήλωση διαφωνίας |
| POST | `/connect/disputes/{dispute_id}/resolve` | επίλυση |
| POST | `/connect/returns/{return_id}/respond` · `/connect/returns/{return_id}/complete` | επιστροφές |
| GET | `/connect/balances` | ποιος χρωστά σε ποιον |
| GET/PUT | `/connect/policy` | κανόνες συμμετοχής |

**Δικαίωμα: `portal:manage`** — σκόπιμα ΟΧΙ νέο `connect:manage`. Τα δικαιώματα των ρόλων ζουν
στη βάση κάθε φαρμακείου και **δεν ενημερώνονται αναδρομικά**· ένα νέο κλειδί θα άφηνε όλους
πλην του ιδιοκτήτη έξω από πληρωμένο κύκλωμα (όπως έγινε με τη δοκιμή δυνατότητας: 14 στα 15).
⚠ Το απόθεμα **δεν υπάρχει** για τα περισσότερα είδη (13 από 41.127) → **`None` ≠ `0`**.

### Συνομιλία φαρμακείων *(δωρεάν module `pharmacy_chat`, ίδιο δικαίωμα `portal:manage`)*
| GET/POST | `/pharmacy-chat/groups` · DELETE `/pharmacy-chat/groups/{group_id}` · POST `/pharmacy-chat/groups/{group_id}/leave` |
| POST | `/pharmacy-chat/invite` · `/pharmacy-chat/invites/{invite_id}` | πρόσκληση με ΑΦΜ — **μόνο σε ενεργή συνδρομή** (όχι trial) |
| GET/POST | `/pharmacy-chat/messages` |

### «Τι νέο υπάρχει» — σημειώσεις έκδοσης
| GET | `/release-notes` | `auth` | οι δημοσιευμένες, για ΑΥΤΟΝ τον πελάτη |
| POST | `/release-notes/seen` | `auth` | σβήνει το σήμα |
| GET/PUT | `/admin/release-notes` | `padmin:admin` | σύνταξη — **από το προϊόν, ποτέ από το shell** |
| POST | `/admin/release-notes/{version}/publish` · DELETE `/admin/release-notes/{version}` |

⚠ Σειρά εκδόσεων με **`vsort`**: η MongoDB συγκρίνει πίνακες με το **μέγιστο στοιχείο**, οπότε
`[major,minor,patch]` δεν ταξινομείται όπως περιμένεις.

### Πρόσθετα & δοκιμές δυνατοτήτων
| GET | `/addons` | `auth` | κατάλογος με `status`, `tried`, `can_trial`, **`trial_started_at` / `trial_expires_at` / `trial_days`** |
| GET | `/addons/{id}/quote` | `billing:manage` | **αναλογικό ποσό πριν τη χρέωση** |
| POST | `/addons/{id}/trial` | έναρξη δοκιμής — **μία φορά ανά πελάτη** (`error: trial_used`) |
| GET | `/admin/module-trials` | `padmin:admin` | ποιος δοκιμάζει τι & πότε λήγει |

Η **λήξη** δοκιμής μπαίνει στο JWT (claim `mtrl`) και ελέγχεται **σε κάθε αίτημα** — όχι μόνο
στην έκδοση token. Δες `ARCHITECTURE.md` §10β.

### Ο Σύμβουλος — «Τι άλλο μπορείς» *(module `daily_coach`)*
| GET | `/coach/opportunities` | `patients:read` | προτάσεις αξιοποίησης, μετρημένες |

Επιστρέφει `{items, total, patients, money_cents}`. Κάθε πρόταση:
`headline` («Ξέρεις ότι…»), `situation`, `promise`, **`serve_n`/`serve_pct`** (πόσους πελάτες
και τι ποσοστό αφορά), **`money_cents`** (τζίρος που ήδη περνά από αυτή την ομάδα),
`offer` («Θες να σε βοηθήσω να το στήσουμε;»), **`setup[]`** (τα βήματα στησίματος),
`feature`, `module`, `locked`, `cta`, `cta_secondary`.

**Καμία πρόταση δεν παράγεται «γενικά»**: κάθε `_prop_*` επιστρέφει `None` όταν τα δεδομένα δεν
περνούν το κατώφλι. Τα **κλειδωμένα** modules παίρνουν +100 βάρος, όσα έχει και δεν δουλεύει +40.

⚠ Ο έλεγχος «έχει τη δυνατότητα;» γίνεται με **`resolve_tenant_modules()`**, ΟΧΙ με
`tenants.modules` — εκείνο κρατά μόνο υπερισχύσεις· τα modules του πακέτου ζουν στο
`subscriptions.modules_included`. Χωρίς τον resolver, προτείνεις στον πελάτη να αγοράσει ό,τι
ήδη πληρώνει.

## Export (cross-cutting)
Πολλά list/aggregate endpoints δέχονται `?format=csv|xlsx|pdf` → async export job
(audited) → `202 Accepted` + `GET /exports/{id}` για το αρχείο (signed URL).

## Σύμβαση σφαλμάτων
```json
{"type":"https://rxvision.gr/errors/module-locked","title":"Module not available",
 "status":403,"detail":"Το module 'profitability' δεν είναι ενεργό στο plan σας.",
 "module":"profitability","request_id":"uuid"}
```
Κωδικοί: `401 unauthenticated`, `403 forbidden|module_locked`, `404`, `409 conflict`,
`422 validation`, `429 rate_limited`, `5xx`.
