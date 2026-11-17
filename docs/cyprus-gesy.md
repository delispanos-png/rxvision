# RxVision Κύπρος (ΓεΣΥ) — τεχνική εικόνα

> Απόφαση: `docs/decisions.md` → ADR-2026-11-17. Κατάσταση: σε ανάπτυξη, πίσω από διακόπτη.

## Πώς ενεργοποιείται
1. **Adminpanel → Συνδρομητές → «Κύπρος: ενεργό/ανενεργό»** (`platform_settings/cy.enabled`). Κλειστό → κάθε
   κυπριακό endpoint απαντά 404, για όλους. Η Ελλάδα δεν επηρεάζεται σε καμία από τις δύο θέσεις.
2. **Άνοιγμα tenant → «Χώρα φαρμακείου: Κύπρος»** (`tenants.country = "CY"`, ζώνη `Asia/Nicosia`).
3. Το `/auth/me` επιστρέφει `country`· το frontend δείχνει `CY_NAV_GROUPS` και το `CountryGate` κρατά το
   κυπριακό φαρμακείο μέσα στις επιτρεπτές διαδρομές (`CY_ALLOWED`). Το ελληνικό onboarding ΗΔΥΚΑ δεν εμφανίζεται.

## Ροή δεδομένων
`POST /api/v1/cy/import` (XML ή ZIP) → `services/cy/importer.py` → `parser.parse_dispensing()` →
έλεγχος παρόχου (`tenants.settings.cy_provider_id`, δένεται με το 1ο αρχείο) → ψευδώνυμο ταυτότητας →
`cy_dispensings` (μία εγγραφή/εκτέλεση, unique `tenant_id+dispensing_id`) + `cy_patients`.

| XML | Αποθήκευση |
|---|---|
| `Type` 01 / 02 | `kind` drug / consumable |
| `CurrentDispInstance` / `PotentialDispInstances` | ανά γραμμή `instance` / `instances`· `closes_prescription` |
| `QtyPresc` / `QtyDisp` (0 = δεν δόθηκε) | `qty_presc` / `qty_disp` |
| Ποσά (ευρώ) | λεπτά: `hio`, `copay`, `pc2`, `beneficiary`, `total` — το Footer ΠΡΕΠΕΙ να ισούται με το άθροισμα, αλλιώς απόρριψη |
| Δοσολογία (ελληνικά ή αγγλικά) | `dosage.amount/unit/per_day/timing/duration_days` + raw· `pack_size`, `days_covered` |
| `EMVOCode` (GS1) | `emvs[]`: `gtin`, `expiry`, `lot` — **όχι** σειριακό |
| `BeneficiaryId` | **ΔΕΝ αποθηκεύεται** — μόνο `patient_ref` = HMAC(ταυτότητα, pepper φαρμακείου) |

## Αλυσίδες συνταγών — ΕΝΑΣ ορισμός (`services/cy/chains.py`)
Μία εγγραφή ανά συνταγή: φάση = η μεγαλύτερη που εκτελέστηκε εδώ· `closed` όταν φάση ≥ σύνολο φάσεων.
Επόμενη επίσκεψη = τελευταία εκτέλεση + μεγαλύτερη `DosageDurationDays` (αλλιώς 28 φάρμακα / 30 αναλώσιμα).
Κατάσταση: `soon` (≤7 ημ.) · `upcoming` · `late` (πέρασε) · `lost` (>14 ημ. μετά) · `closed`.
Χαμένος πελάτης: έχει `lost` συνταγή ΚΑΙ δεν ξαναήρθε μετά την ημέρα που τον περιμέναμε· αλλιώς «διαρροή».
Επισκόπηση, Ανοιχτές συνταγές και Χαμένοι πελάτες διαβάζουν ΟΛΕΣ από εδώ (τεστ: ίδιοι αριθμοί).
⚠ Τα όρια (7/14 ημ.) και το «σταθερό διάστημα» είναι υποθέσεις μέχρι το Discovery στην πύλη.

## Εκδόσεις της ίδιας εκτέλεσης
Η πύλη μπορεί να ξαναβγάλει την ΙΔΙΑ εκτέλεση (ίδιο DispensingId) αλλαγμένη — διόρθωση ή ακύρωση γραμμής.
Κάθε εκτέλεση κρατά `content_hash`: ίδιο → «υπάρχει ήδη»· διαφορετικό → η νέα έκδοση αντικαθιστά, η παλιά
μπαίνει στο `history` (τελευταίες 10), `versions` +1· παλαιότερη χρονικά έκδοση → αγνοείται (`stale`).

## Κλειδί πελάτη
Όπως το PharmacyOne Κύπρου: πρώτα `BeneficiaryHIOcode` (χωρίς αρχικά μηδενικά), αλλιώς `DocType:Id`
(NID ≠ ARC). Ψευδώνυμο = HMAC(κλειδί, pepper φαρμακείου). Η ταυτότητα δεν αποθηκεύεται.

## GDPR
`gdpr_service` δρομολογεί κάθε υποκείμενο `cy:<ψευδώνυμο>` στο `services/cy/gdpr.py`: αναζήτηση/εξαγωγή/
διαγραφή (αφαιρεί ονοματεπώνυμο, ημ. γέννησης, κωδικό ΟΑΥ· οι εκτελέσεις μένουν — νόμιμη διατήρηση).

## Κείμενα: η Κύπρος δεν βλέπει ΠΟΤΕ ελληνικά συστήματα
- **Εγχειρίδιο:** χωριστό `docs/USER_MANUAL_CY.md` → `frontend/public/user-manual-cy.md` (deploy.sh)· το `/manual`
  διαλέγει ανά χώρα.
- **Βοήθεια «?»:** `frontend/src/lib/helpCy.ts` (`HELP_CY` + `CY_SHARED_HELP` = ελληνικές εξηγήσεις ελεγμένες
  καθαρές)· `helpFor(path, country)`. Tooltips μενού ανά χώρα (Sidebar `TIPS_BY_COUNTRY`).
- **Κοινές σελίδες με κείμενο ανά χώρα:** Όροι, GDPR (σελίδα + ρυθμίσεις), Χρήστες, Συνομιλία φαρμακείων,
  Connect (τιμή από κατάλογο, όχι Δελτίο Τιμών — και στον backend `price_hint`).
- **Κρυμμένα για Κύπρο:** Διασύνδεση ΗΔΥΚΑ, Κλείσιμο Μήνα, Ενημέρωση καταλόγου, Οδηγός δεικτών, κάρτα Profarm.
- **Φραγμός:** `tests/test_cy_texts.py` — απαγορευμένοι όροι (ΗΔΥΚΑ, ΕΟΠΥΥ, ΑΜΚΑ, ΑΑΔΕ, Δελτίο Τιμών, 6/13/24%…)
  στο εγχειρίδιο/βοήθεια Κύπρου + κάθε σύνδεσμος βοήθειας → υπαρκτή ενότητα.
- **Νέα κοινή σελίδα για Κύπρο:** πρόσθεσε στο `CY_PICK`/`CY_ALLOWED` ΜΟΝΟ αφού ψάξεις τη σελίδα για ελληνικούς
  όρους· αν η εξήγησή της είναι καθαρή → `CY_SHARED_HELP`, αλλιώς δική της στο `HELP_CY`.
- ⚠ Οι **Όροι Χρήσης** για την Κύπρο θέλουν νομικό έλεγχο (σήμερα: ίδιο κείμενο με αλλαγμένες αναφορές).

## Πύλη πελατών (Κύπρος)
- **Μόνο πρόσκληση** από την Καρτέλα (`POST /cy/patients/{ref}/portal-invite`, δικαίωμα `portal:manage`, module
  `patient_portal`). Ο φαρμακοποιός γράφει ταυτότητα/ARC → HMAC(`DOCTYPE:αριθμός`) πρέπει να ισούται με το
  `cy_patients.id_ref` (το XML δίνει ταυτότητα· η ταυτότητα δεν αποθηκεύεται).
- Λογαριασμός `patient_accounts{country:"CY", amka:""}` + «καρτέλα χωρίς κίνηση» στο `patients_anonymized`
  (`source:"cy_portal"`, `pseudo_id:"cy:<ψευδώνυμο>"`, `cy_pseudo_id`) ώστε όλη η υπάρχουσα πύλη (παραγγελίες,
  ραντεβού, διαθεσιμότητα, πιστότητα) να δουλεύει με ObjectId `patient_ref`.
- Πελάτης: `/patient/me` → `country`· καρτέλες μόνο `cyrx/shop/wallet/availability/appointments`·
  `GET /patient/cy/prescriptions` (chains + ιστορικό). Αιτήματα ΜΟΝΟ στο δικό του φαρμακείο (`_target`),
  κατάλογος/κοντινά = μόνο τα δικά του.
- **Η ελληνική πύλη δεν βλέπει ποτέ κυπριακό φαρμακείο:** `GREEK_PORTAL` σε κατάλογο/κοντινά/προτεινόμενα/
  επαφές εγγραφής + `pharmacy_has_portal`/`link_or_create` αρνούνται CY (διορθώθηκε 17/11: το demo φαινόταν).
- Γνωστά κενά: ειδοποιήσεις push/υπενθυμίσεις/γενέθλια πιστότητας κλειδώνουν σε ΑΜΚΑ → δεν φτάνουν σε
  κυπριακούς λογαριασμούς· αλλαγές προφίλ δεν συγχρονίζονται στην καρτέλα του φαρμακείου.

## Endpoints (φαρμακείο, όλα με `require_cy`)
- Dashboard: `GET /cy/dashboard/summary|timeseries|heatmap|top` (`date_from`, `date_to` χωρίς το «έως»).
- Λίστες: `GET /cy/dispensings` (αναζήτηση/φίλτρα/σελίδες) · `GET /cy/dispensings/{id}` ·
  `GET /cy/patients` · `GET /cy/patients/{ref}` · `GET /cy/doctors` · `GET /cy/doctors/{id}`.
- Συνέχεια: `GET /cy/overview` · `/open-prescriptions?status=` · `/lost-customers` · `/not-dispensed` ·
  `/pc2` · `/staff` · `/consumables` · `/recall?lot=&gtin=`.
- Πελάτης: `PUT /cy/patients/{ref}/contact` · `POST /cy/patients/{ref}/portal-invite` ·
  `POST /cy/patients/{ref}/loyalty`.
- Καμπάνιες: `GET /cy/campaigns/segments|audience` · `POST /cy/campaigns` · `GET /cy/campaigns`.
- Εισαγωγή: `POST /cy/import` (ανέβασμα από την οθόνη).
- Adminpanel: `GET/PUT /admin/cy` (διακόπτης, `system:read` / `system:write`).

## Αυτόματη λήψη XML (Partner API 1.2.0)
Για την υπηρεσία των Windows (`Gesy_XML_Service`) ή όποιο πρόγραμμα βλέπει τον φάκελο εξαγωγής:

1. Ο φαρμακοποιός εκδίδει κλειδί στο **Ρυθμίσεις → Κλειδιά API** με το δικαίωμα
   **«Αποστολή XML εκτελέσεων ΓεΣΥ»** (`gesy_xml:write`). Το κλειδί βλέπει ΜΟΝΟ αυτό το φαρμακείο.
2. Για κάθε νέο αρχείο: `POST https://api.rxvision.gr/v1/cy/dispensings` με
   `X-API-Key: rxv_live_…`, `Content-Type: application/xml` και σώμα το XML ακριβώς όπως είναι
   (ή `application/zip` για πολλά μαζί).
3. Απάντηση: `{files, imported, updated, duplicates, failed, errors[]}`. Σε σφάλμα δικτύου ή 5xx
   **ξαναστέλνεις το ίδιο αρχείο**: είναι ασφαλές (ίδιο περιεχόμενο → `duplicates`, διορθωμένη
   εκτέλεση → `updated`, παλαιότερη εκδοχή → αγνοείται).

Λογική: ΙΔΙΑ με το ανέβασμα από την οθόνη (`services/cy/importer.import_files`): δέσιμο με τον
πάροχο ΓεΣΥ στο πρώτο αρχείο, απόρριψη αρχείων άλλου φαρμακείου, ταυτότητα ποτέ αποθηκευμένη.
Ελληνικό φαρμακείο → 404 `not_a_cyprus_pharmacy`. Τα δικαιώματα κλειδιών είναι ανά χώρα
(`api_keys.COUNTRY_SCOPES`): η Κύπρος δεν βλέπει ελληνικά (π.χ. `patients:read`, που θέλει ΑΜΚΑ).

## Επικοινωνία, καμπάνιες, ειδοποιήσεις, πιστότητα
- **Στοιχεία:** `cy_patients.contact` (κινητό/email/συγκατάθεση). Το XML δεν τα έχει· τα γράφει ο
  φαρμακοποιός ή ο πελάτης από την πύλη (`services/cy/contacts.sync_from_account`, μέσω του
  συνδέσμου πύλης, όχι ΑΜΚΑ). ΠΟΤΕ στα ελληνικά `patient_contacts`.
- **Καμπάνιες:** ΚΟΙΝΗ μηχανή (`campaign_engine` + `comms.send_*`)· η Κύπρος δίνει μόνο το κοινό
  (`contacts.audience`). Παραλήπτης = `patient_ref "cy:<pseudo>"`, που αναγνωρίζουν
  `notify_prefs.allows_patient` και `unsubscribe`. Κοινά από συνταγές = δεδομένα υγείας → μόνο `care`.
- **Ειδοποίηση φάσης:** `services/cy/reminders.next_step_pushes` (beat `cy-next-step`, 07:05 UTC),
  0–2 ημέρες πριν, μία φορά ανά συνταγή+φάση (`reminder_sent`).
- **Πιστότητα:** ίδιο `LoyaltyRepository`· για CY η πηγή είναι οι εκτελέσεις ΓεΣΥ και η συνέπεια
  `chains.adherence`. Μέλος = η καρτέλα πύλης (`cy_shell`), που ΔΕΝ σβήνεται στην αποσύνδεση όσο
  κρατά πόντους.

## Demo φαρμακείο
`services/cy/synthetic.py` παράγει συνθετικά XML (ίδια δομή, φανταστικά πρόσωπα, πάροχος `C9999`).
`seed_demo(tenant_id)` αρνείται να γράψει σε ελληνικό φαρμακείο.

## Επόμενα
Πραγματικά παράθυρα επαναλήψεων (`prescription_info`, περιμένει URL) · κατάλογος HIOcode→ATC (ΟΑΥ) ·
Προχορηγήσεις · παραγγελίες από τα «Είδη που δεν δόθηκαν».

**Ανοιχτά για την πύλη:** σταθερό `Id` γραμμής ανά εκτέλεση; σταθερά παράθυρα; `QtyDisp=0` χάνεται ή
μεταφέρεται; τι είναι το `Barcode2`; πώς φαίνεται μια ακύρωση;
