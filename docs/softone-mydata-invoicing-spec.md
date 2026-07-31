# Παραγωγή Παραστατικών → SoftOne → myDATA — Spec (2026-07-30)

> Στόχος: όταν χρεώνουμε φαρμακείο (συνδρομή/ανανέωση/top-up/extras), να **εκδίδεται νόμιμο
> τιμολόγιο** και να **διαβιβάζεται στο SoftOne της CloudOn**, το οποίο (ως πιστοποιημένος πάροχος
> ηλεκτρονικής τιμολόγησης) το **καταχωρεί & διαβιβάζει στο myDATA (ΑΑΔΕ)** και επιστρέφει MARK/υπογραφές.

## 1. Τι υπάρχει ήδη
- `billing_profile` (ανά tenant): ΑΦΜ, επωνυμία, τίτλος, ΔΟΥ, διεύθυνση, ΤΚ, πόλη → **στοιχεία πελάτη** ✓
- `receipts.record()` → collection `payments` (απλή καταγραφή πληρωμής, ΟΧΙ νόμιμο παραστατικό)
- `aade_service.lookup(afm)` (ΑΦΜ→στοιχεία, SOAP gsis) ✓
- Χρεώσεις: subscription (bill_due/materialize/complete_renewal), top-up μηνυμάτων, extras.

## 2. Είδος παραστατικού (myDATA)
- **Τιμολόγιο Παροχής Υπηρεσιών (τύπος 2.1)** — B2B προς φαρμακεία με ΑΦΜ.
- **ΦΠΑ 24%** (υπηρεσίες). Καθαρή αξία + ΦΠΑ + σύνολο.
- Χαρακτηρισμοί myDATA (κατηγορία εσόδου, E3, ΦΠΑ) **τους χειρίζεται το SoftOne** (ανά SERIES/είδος)
  → εμείς στέλνουμε το SALDOC, το SoftOne κάνει classification + διαβίβαση. **Απλοποιεί τη δική μας πλευρά.**

## 3. SoftOne API (REST / Web Services)
Base: `https://<host>/s1services`. Ροή:
1. **login** `{service:"login", username, password, appId}` → `clientID` + `objs` (εταιρείες/υποκαταστήματα).
2. **authenticate** `{service:"authenticate", clientID, COMPANY, BRANCH, MODULE, REFID}` → authenticated `clientID`.
   *(ή `loginAuthenticate` που τα κάνει μαζί / `setAutoLogin` που αποθηκεύει clientID.)*
3. **setData** `{service:"setData", clientID, appId, OBJECT:"SALDOC", FORM:"<series form>", DATA:{SALDOC:[{...κεφαλίδα, TRDR/πελάτης, SERIES...}], ITELINES:[{MTRL/είδος, QTY1, PRICE, VAT...}]}}`
   → δημιουργεί το παραστατικό· το SoftOne **αυτόματα διαβιβάζει στο myDATA** → response με `id` (FINDOC) + **MARK/UID/authcode**.
4. (προαιρετικά) **getData/print** για PDF/εκτύπωση.

## 4. Αρχιτεκτονική στο RxVision (αποσυνδεδεμένη από την πληρωμή)
Η πληρωμή ΔΕΝ πρέπει να σπάει αν πέσει το SoftOne. Άρα **ουρά**:
1. Επιτυχής χρέωση → δημιουργία εγγραφής `invoices` (status `pending`) με ΟΛΑ τα δεδομένα.
2. **Worker** (celery, κάθε λίγα λεπτά + retry): παίρνει pending → `softone_service.issue()` → setData → αποθηκεύει
   `softone_findoc` + `mydata_mark` + status `issued` (ή `failed` + error, με retry/backoff).
3. Admin βλέπει λίστα παραστατικών (status/MARK/PDF) + χειροκίνητο re-try.

## 5. Μοντέλο `invoices`
```
{ _id, tenant_id, kind (subscription|renewal|topup|extra), description,
  net_cents, vat_rate (24), vat_cents, gross_cents,
  customer: {afm, name, doy, address, city, postal_code, country},
  series, aa (number — από SoftOne), issue_date,
  softone_findoc, mydata_mark, mydata_uid, status (pending|issued|failed),
  error, attempts, payment_ref (viva_transaction_id), created_at, issued_at }
```

## 6. Adminpanel — SoftOne credentials (§ αίτημα ιδιοκτήτη)
Νέα ενότητα «SoftOne / myDATA»:
- **Base URL** (`https://<host>/s1services`), **appId**, **username**, **password** (secret, κρυπτογραφημένο)
- **Company**, **Branch**, **Module**, **RefId** (SoftOne login context)
- **SERIES/FORM** του τιμολογίου παροχής υπηρεσιών (η σειρά που εκδίδει το SoftOne)
- **Στοιχεία εκδότη (CloudOn)**: ΑΦΜ, επωνυμία (για επαλήθευση/εμφάνιση)
- Κουμπί **«Δοκιμή σύνδεσης»** (login+authenticate).

## 7. Τι χρεώνουμε → τι τιμολογούμε
| Χρέωση | Παραστατικό | Πότε |
|---|---|---|
| Συνδρομή (signup) | Τιμολόγιο ΠΥ | materialize (μετά πληρωμή) |
| Ανανέωση | Τιμολόγιο ΠΥ | complete_renewal |
| Top-up μηνυμάτων | Τιμολόγιο ΠΥ | complete_topup |
| Extras (AI/retention) | Τιμολόγιο ΠΥ | στη χρέωση |

## 8. Φάσεις υλοποίησης
- **Φ1 (τώρα):** adminpanel SoftOne credentials (κρυπτογραφημένα) + `softone_service` (login/authenticate/
  test-connection) + μοντέλο `invoices` + admin λίστα (κενή).
- **Φ2:** `issue()` (setData SALDOC → myDATA) + worker + trigger σε 1 σημείο (π.χ. ανανέωση) end-to-end σε SoftOne test.
- **Φ3:** triggers σε όλες τις χρεώσεις + PDF/εμφάνιση + retry UI.

## 8b. ΕΠΙΛΟΓΗ: Custom JS Web Service (BlackBook ver.3.5) — ΠΡΟΚΡΙΘΗΚΕ
Αντί για σκέτο `setData(SALDOC)`, η γέφυρα καλεί **custom web service γραμμένο σε Advanced JavaScript**
στο SoftOne (μεγαλύτερη ευελιξία: mapping/myDATA/validation μέσα στο SoftOne). BlackBook αναφορές:
Login σελ.467, Authenticate σελ.468, SetData σελ.483, `X.WSCALL`/`X.WEBREQUEST` σελ.305, external URL
μορφή `https://<host>/s1services/JS/<module>/<function>` (σελ.487, π.χ. `/s1services/JS/myWS/AddHTMLData`).

**Ροή RxVision:** `login → authenticate (clientID)` → `POST <base_url>/JS/<module>/<function>` με body
`{clientID, appId, ...<payload>}` → η JS συνάρτηση δημιουργεί SALDOC + διαβιβάζει myDATA → επιστρέφει result.
Το endpoint (`<module>/<function>`) είναι **πεδίο adminpanel** (js_endpoint) — ΟΧΙ hardcoded. Το authenticate
χρησιμοποιεί **πεζά** κλειδιά `company/branch/module/refid` (σελ.468).

### JS Bridge Contract — τι στέλνει το RxVision (για την ομάδα SoftOne)
```json
{
  "clientID": "<from authenticate>",
  "appId": "3001",
  "ref": "<RxVision internal invoice id>",
  "kind": "subscription|renewal|topup|extra",
  "issue_date": "2026-07-31",
  "series": "<optional — ή το ορίζει η JS>",
  "customer": { "afm": "999888777", "name": "ΦΑΡΜΑΚΕΙΟ Α.Ε.", "doy": "...",
                "address": "...", "city": "...", "zip": "...", "country": "GR",
                "email": "...", "phone": "..." },
  "lines": [ { "description": "Συνδρομή RxVision Essential (ετήσια)", "qty": 1,
               "net": 468.00, "vat_rate": 24 } ],
  "payment": { "method": "card", "provider": "viva", "transaction_id": "..." }
}
```
### Αναμενόμενη απόκριση της JS συνάρτησης
```json
{ "success": true, "findoc": "<SoftOne doc id>", "mark": "<myDATA MARK>",
  "uid": "<myDATA UID>", "aa": "<series/number>" }
```
*(Αν αποτύχει: `{ "success": false, "error": "...", "errorcode": -N }`.)*
→ Η ομάδα SoftOne γράφει τη συνάρτηση `<module>/<function>` που δέχεται αυτό το payload και το χαρτογραφεί
σε SALDOC/ITELINES + myDATA classification (κατά τους κανόνες της, όχι δικούς μας).

## 9. Ανοιχτά (χρειάζομαι από SoftOne/CloudOn)
- **Base URL / host** του SoftOne της CloudOn (`s1services` endpoint ή SoftOne Go).
- **appId** (application id — δίνεται από SoftOne).
- **username/password** (service user).
- **Company/Branch/Module/RefId** + **SERIES/FORM** για το τιμολόγιο ΠΥ.
- ΑΦΜ/επωνυμία εκδότη (CloudOn).
- Ποιο είναι το **είδος (MTRL/service item)** στο SoftOne για «Συνδρομή RxVision» (ή αν το στέλνουμε ως ελεύθερη γραμμή).
