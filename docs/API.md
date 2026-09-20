# RxVision — REST API (v1)

Base: `/api/v1` · Auth: `Authorization: Bearer <access_jwt>` · Format: JSON ·
Errors: RFC-7807 `application/problem+json`.

Κάθε endpoint είναι **tenant-scoped** (tenant από JWT) και προστατευμένο με
`require(permission, module)`. Λίστες υποστηρίζουν `?page&page_size&sort` + cursor σε
βαριά endpoints. Φίλτρα χρόνου: `?date_from&date_to` (ISO) ή `?period=2026-05`.

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
| GET | `/profitability/summary?period=2026-05` | `profitability:read` |
| GET | `/profitability/by?dim=fund|doctor|icd10|product|category` |
| GET | `/profitability/low-margin?threshold_pct=10` | είδη χαμηλής κερδοφορίας |
| GET | `/profitability/unprofitable-categories` |

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
