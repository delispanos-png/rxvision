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
