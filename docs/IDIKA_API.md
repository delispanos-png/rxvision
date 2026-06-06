# ΗΔΙΚΑ — API ΦΑΡΜΑΚΟΠΟΙΩΝ v2 (integration notes)

> «ΜΗΧΑΝΙΣΜΟΣ ΔΙΑΛΕΙΤΟΥΡΓΙΚΟΤΗΤΑΣ ΣΗΣ ΜΕ ΤΡΙΤΑ ΣΥΣΤΗΜΑΤΑ ΦΑΡΜΑΚΟΠΟΙΩΝ» — OpenAPI 3.0.1, version v2.0.
> Test docs (ReDoc): `https://testeps.e-prescription.gr/pharmapiv2/documentation/manufacturers/index.html`
> OpenAPI spec: `GET /pharmapiv2/v3/api-docs/manufacturers` (80 paths, 212 schemas).

## Authentication
Δύο σχήματα, **και τα δύο υποχρεωτικά**:
- `basicAuth` — HTTP Basic (username/password του integrator).
- `apiKey` — header **`Api-Key`** (κλειδί integrator).

⚠️ **BLOCKER:** Με μόνο Basic auth κάθε κλήση επιστρέφει `ApiError code 604 "You must provide a valid api key"`. Χρειαζόμαστε το **Api-Key** από την ΗΔΙΚΑ (pharm.api.support@idika.gr) πριν γίνουν live κλήσεις.

Base URL (test): `https://testeps.e-prescription.gr/pharmapiv2/`
**Responses: XML** (`application/xml`) — ο client πρέπει να κάνει XML parsing.

## Endpoints-κλειδιά για το RxVision

| Σκοπός | Endpoint | Παράμετροι |
|---|---|---|
| **Εκτελεσμένες συνταγές** (driver λήψης) | `GET /api/v1/prescription-execution/search` | page, size, executionDate, pharmacyId → λίστα {barcode, socialInsurance} |
| **Αναζήτηση συνταγών** | `GET /api/v1/prescriptions/search` | page,size,**from,to**,amka,socialInsuranceId,pharmacyId,medicineDrug,drugCategoryId |
| Αναζήτηση βάσει ΑΜΚΑ | `GET /api/v1/prescriptions/nopaper` | amka |
| Εκτύπωση/detail συνταγής | `GET /api/v1/prescriptions/print/{barcode}` | barcode |
| **Εκκαθάριση** (monthly closing/cashflow) | `GET /api/v1/me/clearance/headers` · `/clearance/prescriptions` (claimsHeaderId, claimedAmount, approvedAmount) · `/clearance/transactions` | περίοδος εκκαθάρισης |
| Στοιχεία φαρμακείου | `GET /api/v1/user/me` · `/user/me/contracts` (history-from = αρχή σύμβασης) · `/user/me/units` | — |
| Masterdata (enrichment) | `/api/v1/masterdata/{icd10s, medicines, activesubstances, socialinsurances, prices, doctor/specialties, drugCategories, frequencies, …}` | — |

Ροή λήψης: `prescription-execution/search` (ποιες εκτελέσαμε, ανά executionDate, paged) → detail πλήρους συνταγής → ανωνυμοποίηση → ingest. Παράλληλα `clearance/*` για αιτούμενα/εγκεκριμένα (εκκαθάριση).

## Πλήρης συνταγή — `PharmPrescriptionDTO` (102 πεδία) → mapping σε concept doc

| Concept doc | ΗΔΙΚΑ πεδία |
|---|---|
| **Ασφαλισμένος** (§2) | `patient`: sex, birthDate (→ηλικιακό group), city/postalCode (→τόπος), **amka** → *pseudonymize, ποτέ raw* |
| **Ιατρός** (§3) | `doctor`: firstName/lastName, specialtyName, amka, unit |
| **Διαγνώσεις ICD-10** (§4) | `diagnoses[]`: icd10Code + title |
| **Σκευάσματα/Είδη** (§7) | `treatments[]`: medicineCommercialName, medicineBarcode, quantityPrescribed, totalPrice, `medicine` (δραστική), galenical |
| **Κερδοφορία/αιτούμενο** (§6) | totalValue, payableAmt, participationValue, patParticipation0/10/25, socialInsuranceSurcharge, supplementalInsuranceAmt, totalDifference |
| **Μελλοντικές** (§5) | prescriptionRepeatId, executions, prescriptionIntervalId, startDate, expiryDate, monthlyTreatment, twoMonthPrescription |
| **Χαρακτηριστικά ειδών** (§8) | medicineDrug (ναρκωτικό), medicineAntibiotic, medicineDesensitization (εμβόλια απευαισθ.), medicineHighcost, chronicDisease, galenicalTreatment, drugCategoryId (ΦΥΚ/ναρκωτικά) |
| **Ανεκτέλεστες δραστικές** (§9) | `treatments[].quantityOutstanding` |

➡️ Η πραγματική ΗΔΙΚΑ δίνει δεδομένα για **ΟΛΕΣ** τις ενότητες του concept doc.

## GDPR
AMKA + ονόματα ασθενών έρχονται — **ανωνυμοποιούμε τον ασθενή** (pseudo_id, 0 raw AMKA), κρατάμε επώνυμο ιατρό (επιτρεπτό). PII (τηλέφωνο/email/διεύθυνση) δεν αποθηκεύεται.

## Action items
1. **Αίτημα Api-Key** integrator από ΗΔΙΚΑ (pharm.api.support@idika.gr) — χωρίς αυτό δεν τρέχει τίποτα live.
2. Υλοποίηση `HdikaClient` (υπάρχει scaffold): Basic+Api-Key auth, **XML parser**, paging, execution-search → detail → ανωνυμοποίηση → ingest, + clearance.
3. Connection settings (ήδη στο tenant Settings): προσθήκη πεδίου `api_key` (→ Vault).
