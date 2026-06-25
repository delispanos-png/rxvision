# Κέντρο Ωραρίου & Διαθεσιμότητας Φαρμακείου — Functional & Technical Spec

Module key: `pharmacy_availability` · Route group: `/api/v1/pharmacy-availability` · UI: `Ρυθμίσεις → Ωράριο & Διαθεσιμότητα`.
Multi-tenant (tenant = ένα φαρμακείο). Όλες οι ώρες είναι **τοπική ώρα Ελλάδας** (`Europe/Athens`, EET/EEST).

## 1. Functional specification
1. **Βασικό εβδομαδιαίο ωράριο** — ανά ημέρα (Δευ…Κυρ): `Κλειστό | Συνεχές | Σπαστό | Προσαρμοσμένο`, με **πολλαπλά διαστήματα** (`08:00–14:00`, `17:00–21:00`).
2. **Εφημερίες/διανυκτερεύσεις** — ετήσιο ημερολόγιο: ημερομηνία, έναρξη, λήξη, «περνά στην επόμενη μέρα», τύπος (`απλή εφημερία | διανυκτέρευση`), παρατηρήσεις.
3. **Μαζική καταχώρηση** — paste κειμένου / CSV / Excel (auto-parse ημερομηνιών+ωρών+τύπου) με **preview** πριν την αποθήκευση. (PDF/φωτο: επόμενη φάση, OCR.)
4. **Εξαιρέσεις/ειδικές ημέρες** — αργίες, τοπικές αργίες, διακοπές, απογραφή, ανακαίνιση, έκτακτο κλείσιμο, έκτακτη αλλαγή ωραρίου. **Υπερισχύουν** του εβδομαδιαίου.
5. **Κατάσταση σε πραγματικό χρόνο** — `isOpen / isOnDuty / isOvernightDuty / statusText / nextOpening / nextClosing / closingSoon`.
6. **Validation** — φιλικά μηνύματα + πρόταση διόρθωσης.
7. **UX** — εβδομαδιαία προβολή, ετήσιο ημερολόγιο εφημεριών, copy ημέρας→ημέρα, templates, preview, live status banner, mobile-friendly.

## 2. Data model (MongoDB, tenant-scoped)
- **`pharmacy_schedule`** (ένα doc/φαρμακείο, `_id = tenant_id`):
  `{ _id, tenant_id, timezone, week:[ {day:0..6 (0=Δευ), status:"closed|continuous|split|custom", intervals:[{start:"HH:MM", end:"HH:MM"}]} ×7 ], updated_at, updated_by }`
- **`pharmacy_duties`** (εφημερίες):
  `{ _id, tenant_id, date:"YYYY-MM-DD", start:"HH:MM", end:"HH:MM", overnight:bool, kind:"duty|overnight", note, created_at, updated_at, updated_by }`
- **`pharmacy_exceptions`** (ειδικές ημέρες):
  `{ _id, tenant_id, date:"YYYY-MM-DD", type:"closed|holiday|local_holiday|vacation|inventory|renovation|emergency_close|custom", label, intervals:[…] (μόνο για custom), note, created_at, updated_by }`
- Audit: middleware (`audit_logs`) σε κάθε POST/PUT/DELETE + `updated_by` στα docs.
- Indexes: `pharmacy_duties (tenant_id, date)`, `pharmacy_exceptions (tenant_id, date)`.

## 3. API design
| Method | Path | Perm |
|---|---|---|
| GET | `/pharmacy-availability/status` | `settings:read` |
| GET | `/pharmacy-availability/schedule` | `settings:read` |
| PUT | `/pharmacy-availability/schedule` | `settings:write` |
| GET | `/pharmacy-availability/duties?year=` | `settings:read` |
| POST | `/pharmacy-availability/duties` | `settings:write` |
| POST | `/pharmacy-availability/duties/delete` | `settings:write` |
| GET | `/pharmacy-availability/exceptions?year=` | `settings:read` |
| POST | `/pharmacy-availability/exceptions` | `settings:write` |
| POST | `/pharmacy-availability/exceptions/delete` | `settings:write` |
| POST | `/pharmacy-availability/import` (preview ή commit) | `settings:write` |
| GET | `/pharmacy-availability/templates` | `settings:read` |

`GET /status` → `{ isOpen, isOnDuty, isOvernightDuty, closingSoon, statusText, nextOpening, nextClosing }` (ISO με offset Ελλάδας).

## 4. Status engine (core)
Χτίζει **απόλυτα open-segments** για παράθυρο `[χθες … +9 ημέρες]`:
- ανά ημέρα: effective intervals = (exception override) αλλιώς (εβδομαδιαίο). Κάθε interval → segment `[date+start, date+end]` (αν `end ≤ start` → επόμενη μέρα).
- εφημερίες/διανυκτερεύσεις → segments τύπου `duty/overnight` (overnight ⇒ λήξη επόμενη μέρα).
- `current = segment που περιέχει το now`. `isOpen=current≠None`, `isOnDuty=current∈{duty,overnight}`, `isOvernightDuty=current=overnight`.
- `nextClosing = current.end`, `nextOpening = πρώτο segment.start > now`. `closingSoon` αν `nextClosing-now ≤ 30'`.
Χειρίζεται σωστά τα **μετά τα μεσάνυχτα** (segments περνούν στην επόμενη μέρα· ελέγχονται και τα χθεσινά για overnight spillover) και **DST** (zoneinfo `Europe/Athens`).

## 5. Validation rules (φιλικά μηνύματα)
HH:MM μορφή · `έναρξη < λήξη` (εκτός overnight) · **όχι επικαλυπτόμενα** διαστήματα στην ίδια μέρα · εφημερία χωρίς λήξη → σφάλμα · επικαλυπτόμενες εφημερίες ίδιας ημέρας · ημερομηνία έγκυρη/εντός λογικού εύρους · custom exception χωρίς διαστήματα → σφάλμα · κενές εγγραφές. Επιστροφή `{ok, errors:[…], warnings:[…]}`.

## 6. Edge cases
Διανυκτέρευση `08:00→08:00` (24ωρο) · `21:00→08:00` · εφημερία πάνω σε αργία (exception υπερισχύει — αν «κλειστό», η εφημερία επίσης ισχύει ως ξεχωριστό segment; ο χρήστης ειδοποιείται) · αλλαγή DST · κενό ωράριο (όλα κλειστά) · διπλο-καταχώρηση εφημερίας · εξαίρεση + εφημερία ίδιας μέρας.

## 7. Architecture
`PharmacyAvailabilityRepository` (validation + status engine, pure-function core) → router → settings UI. Tenant isolation by construction (BaseRepository). Permissions: edit=`settings:write` (owner/manager), read=`settings:read` (staff). Audit auto + `updated_by`.

## 8. Implementation plan
Φάση 1 (τώρα): εβδομαδιαίο ωράριο + εφημερίες + εξαιρέσεις + status engine + validation + UI (weekly editor/templates/copy, duties, exceptions, live status, paste/CSV/Excel import με preview). Φάση 2: PDF/φωτο OCR import, δημόσιο directory «ανοιχτό φαρμακείο κοντά μου», Google Business sync, webhooks, recall/SMS βάσει ωραρίου, εμφάνιση status στο my.rxvision & site.

## 9. Future extensions
Δημόσιο directory + geo search, AI assistant, recall/SMS βάσει ωραρίου, webhooks, Google Business Profile sync, site integration, mobile push κατάστασης.
