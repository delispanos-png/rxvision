# Prompt: Διασύνδεση έκδοσης παραστατικών «δικό μας σύστημα → SoftOne → myDATA»

> Οδηγίες προς τον developer / το AI assistant που θα το υλοποιήσει.
> Αυτή η αρχιτεκτονική δουλεύει σε παραγωγή στο RxVision (SaaS). Θέλω την **ίδια ακριβώς δομή** στο
> νέο σύστημα. Όπου γράφει ⚙ είναι τιμή της εγκατάστασης SoftOne που συμπληρώνουμε εμείς —
> **μην τη μαντέψεις**.

---

## 1. Τι θέλουμε να πετύχουμε

Κάθε φορά που το σύστημά μας **εισπράττει** χρήματα (συνδρομή, ανανέωση, αναβάθμιση, πρόσθετο, αγορά
πακέτου), πρέπει να εκδίδεται **αυτόματα** παραστατικό στο **SoftOne** (CloudOn, Advanced JavaScript).
Το SoftOne είναι πιστοποιημένος πάροχος και διαβιβάζει στο **myDATA (ΑΑΔΕ)**.

Κανόνες που δεν συζητιούνται:
- **Το SoftOne εκδίδει, όχι εμείς.** Εμείς στέλνουμε πελάτη + γραμμές (είδος, ποσότητα, καθαρή τιμή).
  Αρίθμηση, ημερομηνία έκδοσης, ΦΠΑ, σύνολα και διαβίβαση myDATA τα κάνει το SoftOne στο `DBPOST`.
  ⚠ **Μην στέλνεις αριθμό ούτε ημερομηνία παραστατικού.** Ένα παραστατικό που έμεινε πίσω απορριπτόταν
  για πάντα: «Έχει καταχωρηθεί παραστατικό σε μεταγενέστερη ημερομηνία με μικρότερο αριθμό σειράς».
- **Το email του παραστατικού στον πελάτη το στέλνει το SoftOne**, όχι το σύστημά μας.
- **Η πληρωμή δεν μπλοκάρει ποτέ από την τιμολόγηση.** Η δημιουργία παραστατικού γίνεται «best-effort»
  μέσα στη ροή πληρωμής (try/except, ποτέ raise). Η αποστολή γίνεται **ασύγχρονα** από worker.
- **Ποσά πάντα σε ακέραια λεπτά** (cents) μέσα στο σύστημα. Μετατροπή σε ευρώ (float, 2 δεκαδικά·
  4 για τιμή μονάδας) **μόνο** στο payload προς SoftOne.
- **Κανένα διπλό παραστατικό, ποτέ** — ούτε σε timeout, ούτε σε retry, ούτε σε δύο workers ταυτόχρονα.

---

## 2. Αρχιτεκτονική (3 κομμάτια)

```
[Πληρωμή OK] ──► create_for_payment()  ──► συλλογή `invoices` (status: pending)
                                                │
                     worker κάθε 5′ ────────────┤ process_pending(): ατομικό claim pending→sending
                                                ▼
              softone_service: login → authenticate → POST <gateway>/JS/<module>/<function>
                                                ▼
              SoftOne Advanced JS «createInvoice(obj)»  (η γέφυρα — §6)
                 mode "find"   → υπάρχει ήδη doc με POSGUID=ref;  (idempotency)
                 (κανονικό)    → πελάτης (ΑΦΜ) → SALDOC + ITELINES → DBPOST → POSGUID
                 mode "status" → μετασχηματίστηκε το προτιμολόγιο σε τελικό; MARK;
                                                ▼
                     worker κάθε 15′: check_transformations() → MARK / UID / QR / τελικός αριθμός
```

### 2α. Ρυθμίσεις (στο admin panel, ΚΡΥΠΤΟΓΡΑΦΗΜΕΝΑ στη βάση — ποτέ σε κώδικα/.env/chat)
`base_url` (π.χ. `https://<εγκατάσταση>.oncloud.gr/s1services`), `username`, `password`, `app_id`,
`company`, `branch`, `module`, `refid`, `js_endpoint` (π.χ. `<module>/<object>.createInvoice`),
`series` (⚙ **internal SERIES id**, βλ. §7), `auto_invoicing` (διακόπτης), `mtrl_map` (§4).
Κουμπί «Δοκιμή σύνδεσης» (login + authenticate, δείχνει εταιρείες/υποκαταστήματα).

---

## 3. Σύνδεση με το SoftOne (S1 Web Services)

Όλα είναι `POST` JSON (`Content-Type: application/json; charset=utf-8`).

1. **login** → `POST {gateway}` με `{"service":"login","username","password","appId"}` → `clientID`.
2. **authenticate** → `POST {gateway}` με **πεζά κλειδιά** `{"service":"authenticate","clientID",
   "company","branch","module","refid"}` → authenticated `clientID`.
3. **Κλήση της γέφυρας** → `POST {gateway}/JS/{js_endpoint}` με `{"clientID","appId", ...payload}`.

Παγίδες (όλες συνέβησαν):
- Το JSON gateway είναι το **`/s1services`**, όχι `/s1services/JS`. Αν το base_url τελειώνει σε `/JS`,
  **κόψ' το** αυτόματα (αλλιώς το SoftOne απαντά «No data»). Το `js_endpoint` επίσης κανονικοποιείται
  (αφαίρεσε prefixes `s1services/JS/`, `JS/`, `/`).
- Το SoftOne απαντά συχνά σε **windows-1253**. Αν το `.json()` αποτύχει, δοκίμασε decode με το δηλωμένο
  charset → `windows-1253` → `utf-8` → `latin-1`.
- Serialize το payload με `default=str` (ημερομηνίες/ObjectId) — ένα πεδίο ημερομηνίας στο payload
  έριχνε **κάθε** αποστολή με `TypeError`. Στείλε **μόνο** τα πεδία που χρειάζεται το SoftOne.
- **404 στο login** = ο host δεν εξυπηρετεί web services (π.χ. κοινό domain live/R&D που δείχνει
  στην R&D). Δείξε καθαρό μήνυμα, όχι «HTTPStatusError».

---

## 4. Το παραστατικό στη δική μας βάση (`invoices`)

`create_for_payment(tenant_id, kind, gross_cents, description, payment, item_key)`:
- **Idempotent στην πληρωμή:** `source_ref = "<kind>:<transaction_id>"` — αν υπάρχει, επέστρεψέ το
  (τα webhooks ξαναστέλνονται).
- **ΦΠΑ:** οι τιμές καταλόγου είναι **καθαρές**· ο ΦΠΑ προστίθεται στη χρέωση. Το παραστατικό
  παίρνει το **μικτό που χρεώθηκε** και το σπάει: `net = round(gross / (1 + rate/100))`,
  `vat = gross − net` → το σύνολο του παραστατικού = ακριβώς το ποσό που χρεώθηκε.
  ΦΠΑ ανά χώρα (GR 24%, CY 19%).
- **Χωρίς ΑΦΜ → `status: "blocked"`** (`blocked_reason: missing_afm`), δεν στέλνεται.
- **Δωρεάν πελάτης → κανένα παραστατικό.**
- **Είδος SoftOne (MTRL) ανά γραμμή — ΥΠΟΧΡΕΩΤΙΚΟ.** Κεντρική αντιστοίχιση στο admin panel
  `mtrl_map: { "<item_key>": <MTRL>, ..., "default": <MTRL> }`. Κλειδιά: `pkg:<πακέτο>:<monthly|yearly>`,
  `addon:<code>:<monthly|yearly>`, `credit:<id>`, και σταθερά (`ai`, `retention`, `seats`, ...).
  Μηνιαίο και ετήσιο είναι **χωριστά είδη**· ετήσιο χωρίς δικό του είδος → `default`, **ποτέ** το μηνιαίο.
  Η λίστα στο admin είναι **δυναμική** (διαβάζει πακέτα/πρόσθετα από τη βάση) → κάθε νέο χρεώσιμο
  εμφανίζεται μόνο του. Κάθε νέος **τύπος** χρέωσης μπαίνει υποχρεωτικά στη λίστα.
- **Αιτιολογία** (`comments`): π.χ. «Πώληση από το site — Περίοδος: 01/11/2026 έως 30/11/2026».
- Πεδία κατάστασης: `status` (pending/sending/issued/failed/blocked), `attempts`, `last_error`,
  `next_attempt_at`, `softone_findoc`, `softone_number`, `aade_mark`, `aade_status`, `mydata_uid`,
  `aade_sign`, `aade_qr`, `transformed*`.

### Payload προς τη γέφυρα (`_build_payload`)
```json
{
  "ref": "<_id του παραστατικού μας>",          // → POSGUID στο SoftOne (idempotency key)
  "kind": "subscription",
  "series": "...", "doc_type": "ΤΠΥ",
  "comments": "Πώληση ... Περίοδος: ...",
  "customer": { "afm": "...", "name": "...", "doy": "...", "address": "...", "city": "...",
                "zip": "...", "phone": "...", "email": "...", "country": "GR" },
  "lines": [ { "description": "...", "mtrl": 1234, "qty": 1,
               "unit_net": 82.45, "net": 82.45, "gross": 82.45, "discount": 0.0, "vat_rate": 24 } ],
  "totals": { "net": 82.45, "vat": 19.79, "total": 102.24, "discount": 0 },
  "payment": { "method": "card", "provider": "...", "transaction_id": "..." }
}
```
Το `softone_series` (από ρυθμίσεις), `clientID` και `appId` τα προσθέτει ο client πριν το POST.
Πολυγραμμικό: έκπτωση συνόλου **κατανέμεται αναλογικά** στις γραμμές (η τελευταία παίρνει το
υπόλοιπο, ώστε το άθροισμα να βγαίνει ακριβώς).

---

## 4β. Ο πίνακας αντιστοίχισης «είδος συστήματος → είδος SoftOne (MTRL)»

**Γιατί υπάρχει:** η SoftOne δεν δέχεται γραμμή παραστατικού χωρίς **είδος** (`MTRL` = το εσωτερικό
id του είδους στο SoftOne, πίνακας `MTRL`). Κάθε πράγμα που χρεώνουμε πρέπει να αντιστοιχεί σε ένα
είδος του SoftOne — αλλιώς «Δεν υπάρχει το πεδίο Υλικό» και το παραστατικό δεν εκδίδεται. Επίσης το
είδος καθορίζει τη **λογιστική κατηγοριοποίηση** (έσοδο συνδρομών vs προσθέτων vs προμηθειών).

### Αποθήκευση
Ένα έγγραφο ρυθμίσεων (μαζί με τα υπόλοιπα του SoftOne), πεδίο `mtrl_map` — απλό λεξικό:
```json
{
  "pkg:basic:monthly":      "10001",
  "pkg:basic:yearly":       "10002",
  "pkg:advanced:monthly":   "10003",
  "pkg:advanced:yearly":    "10004",
  "addon:connect:monthly":  "10005",
  "addon:connect:yearly":   "10006",
  "credit:sms_1000":        "10007",
  "ai_credit:pack_s":       "10008",
  "ai":                     "10009",
  "retention":              "10010",
  "seats":                  "10011",
  "eshop_fees":             "10012",
  "default":                "10013"
}
```
(οι αριθμοί είναι **παραδείγματα** — τα πραγματικά MTRL τα δίνει το λογιστήριο από το SoftOne.)

### Κλειδιά (`item_key`) — μία γραμμή για ΚΑΘΕ χρεώσιμο
| Ομάδα | Κλειδί | Από πού προκύπτει |
|---|---|---|
| Συνδρομές | `pkg:<id πακέτου>:monthly` / `:yearly` | συλλογή πακέτων — **δύο γραμμές ανά πακέτο** |
| Πρόσθετα | `addon:<code>:monthly` / `:yearly` | συλλογή προσθέτων — δύο γραμμές ανά πρόσθετο |
| Πακέτα μηνυμάτων | `credit:<id>` | συλλογή credit packages |
| Πακέτα AI | `ai_credit:<id>` | συλλογή πακέτων AI |
| Σταθερά extras | `ai`, `retention`, `seats`, `eshop_fees` | λίστα στον κώδικα |
| Δίχτυ ασφαλείας | `default` | «Γενικό είδος» — χρησιμοποιείται όταν λείπει ειδικό |

### API (admin, μόνο για platform admin)
- `GET /admin/softone/items` → **χτίζει τη λίστα ΔΥΝΑΜΙΚΑ** από τη βάση (πακέτα, πρόσθετα, credits,
  πακέτα AI + σταθερά extras) και δίπλα σε καθένα το τρέχον MTRL:
  `{ items: [{key, group, name, mtrl, price, price_includes_vat}], default_mtrl }`.
  Έτσι **κάθε νέο πακέτο/πρόσθετο εμφανίζεται μόνο του** στον πίνακα — κανείς δεν χρειάζεται να
  θυμηθεί να το προσθέσει. (Κανόνας: αν προστεθεί νέος **τύπος** χρέωσης, μπαίνει υποχρεωτικά εδώ.)
- `PUT /admin/softone/items` με `{ map: {key: mtrl}, default_mtrl }` → αποθηκεύει (κενές τιμές πετιούνται,
  τιμές γίνονται `trim`).

### Οθόνη (admin → SoftOne → «Αντιστοίχιση ειδών → MTRL»)
Πίνακας ομαδοποιημένος ανά ομάδα: **Όνομα είδους | Κύκλος | Τιμή | Κωδικός SoftOne (MTRL)** — ένα πεδίο
κειμένου ανά γραμμή, ένα πεδίο «Γενικό είδος (default)» πάνω-πάνω, ένα κουμπί «Αποθήκευση».
Γραμμές **χωρίς** MTRL επισημαίνονται (π.χ. κόκκινο «λείπει»), ώστε να φαίνεται αμέσως τι εκκρεμεί.
Χρήσιμο: δίπλα στο πεδίο, έλεγχος ότι το MTRL υπάρχει (`getData OBJECT:"ITEM" KEY:<mtrl>` → CODE/NAME).

### Πώς επιλύεται το MTRL κατά την έκδοση (σειρά προτεραιότητας)
```
item_key = (αυτό που περνά το σημείο χρέωσης)
           ή, για συνδρομή/ανανέωση/αναβάθμιση, αυτόματα "pkg:<πακέτο>"
αν item_key είναι pkg:/addon:  → πρόσθεσε τον κύκλο: "<key>:<monthly|yearly>"
     mtrl = map["<key>:<κύκλος>"]
            ή (ΜΟΝΟ για μηνιαίο) map["<key>"]          # παλιά κλειδιά χωρίς κύκλο = μηνιαία
     ⚠ ετήσιο χωρίς δικό του είδος → ΠΟΤΕ το μηνιαίο, πάει στο default
αλλιώς mtrl = map[item_key]
mtrl = mtrl ή map["default"]
χωρίς τίποτα → το παραστατικό ΠΕΡΙΜΕΝΕΙ (pending, χωρίς να καίει προσπάθεια, μήνυμα «Λείπει είδος…»)
```
- Το MTRL **αποθηκεύεται πάνω στο παραστατικό** (`invoice.mtrl`, `invoice.item_key`) τη στιγμή της
  δημιουργίας — αλλά **ξαναδιαβάζεται πριν την αποστολή** αν λείπει. Έτσι, όταν ο admin συμπληρώσει
  την αντιστοίχιση, τα ήδη εκκρεμή παραστατικά φεύγουν **μόνα τους** στον επόμενο κύκλο του worker.
- Το MTRL πάει στη γραμμή του payload (`lines[].mtrl`) και η γέφυρα το γράφει ως `d.MTRL = parseInt(...)`
  (fallback στη γέφυρα: `CFG.SERVICE_MTRL`).
- **Νυχτερινός έλεγχος:** λίστα χρεώσιμων ειδών χωρίς MTRL **και** χωρίς default → email στον admin.

## 5. Worker αποστολής (κάθε 5′) — εδώ κρίνεται το «κανένα διπλό»

```
process_pending():
  αν δεν υπάρχουν ρυθμίσεις ή js_endpoint → skip
  για έως 25 φορές:
     inv = find_one_and_update(                      # ΑΤΟΜΙΚΟ claim
        { $or: [ {status:"pending", next_attempt_at <= now},
                 {status:"sending", sending_at <= now−10′} ] }   # κολλημένα από crash
        (+ auto != true, αν ο διακόπτης auto_invoicing είναι OFF — τα χειροκίνητα φεύγουν πάντα),
        $set {status:"sending", sending_at: now}, sort created_at ↑)
     _issue_one(inv)

_issue_one(inv):
  1. ξαναδιάβασε το MTRL από την ΤΡΕΧΟΥΣΑ αντιστοίχιση (αν μπήκε αργότερα)
  2. ΧΩΡΙΣ MTRL → μένει pending, ΔΕΝ μετράει προσπάθεια, μήνυμα «Λείπει είδος SoftOne για …»,
     ξαναδοκιμή σε 10′ (στέλνεται μόνο του μόλις μπει αντιστοίχιση)
  3. ΚΛΗΣΗ "find" (ΞΕΧΩΡΙΣΤΗ!): υπάρχει ήδη doc με POSGUID = ref;  → ναι: issued, τέλος
  4. ΚΛΗΣΗ έκδοσης → ok: issued (findoc, mark, uid, aa)
  5. αποτυχία: attempts+1, retry σε 5′, μετά από 6 → "failed" (χειροκίνητη επανάληψη από admin)
```
Γιατί και τα δύο επίπεδα: σε timeout το SoftOne **είχε ήδη** φτιάξει το παραστατικό αλλά εμείς
νομίζαμε ότι απέτυχε → retry → **διπλό** (ΠΡΤΙΜ00004 + ΠΡΤΙΜ00005). Το POSGUID + το "find" το
λύνουν· το ατομικό claim λύνει τους επικαλυπτόμενους workers.

Χειροκίνητη επανέκδοση από admin: επιτρέπεται **όσο δεν υπάρχει MARK**. Το **MARK είναι η μόνη πηγή
αλήθειας για «οριστικό»** — κλείδωμα επεξεργασίας/διαγραφής μόνο με `aade_mark`.

---

## 6. Μετασχηματισμός & απόδειξη διαβίβασης (worker κάθε 15′)

Εκδίδουμε **Προτιμολόγιο**. Ο λογιστής το **μετασχηματίζει** στο SoftOne σε τελικό Τ.Π.Υ., και
τότε πάει στο myDATA. Για κάθε `issued` χωρίς MARK:
1. `getData` (standard, όχι γέφυρα) `OBJECT:"SALDOC", KEY:<findoc>` → `CMPFINCODE` = ο αριθμός που
   έδωσε το SoftOne (π.χ. ΠΡΤΙΜ00008) — **αυτόν** δείχνουμε στον πελάτη.
2. Γέφυρα `mode:"status"` → `target_findoc` (μέσω `MTRLINES.FINDOCS = <πηγαίο findoc>`), `FULLYTRANSF`.
3. Αν υπάρχει target → `getData` στο target. ⚠ Ο πάροχος e-invoicing (s1ecos) **δεν** γράφει
   αριθμητικό MARK στο `FINDOC.MARK`. Η νόμιμη απόδειξη είναι: `FINDOC.EINVOICESIGN` (υπογραφή),
   `MTRDOC.SOSIGNE` (UID), `MTRDOC.SOSIGNQR` (QR URL), `FINDOC.CMPFINCODE` (τελικός αριθμός).
4. Συνέχισε να ρωτάς **μέχρι να υπάρξει MARK/απόδειξη** — μην σταματάς στο «μετασχηματίστηκε».

---

## 7. Παγίδες SoftOne που κόστισαν ΩΡΕΣ (διάβασέ τες πριν γράψεις κώδικα)

1. **ΣΕΙΡΑ = internal SERIES id, ΟΧΙ φόρμα (FPRMS).** Άκυρη σειρά **δεν** πέφτει σε default — σπάει
   το object και το `DBPOST` βγάζει το παραπλανητικό «**Δεν έχετε συμπληρώσει το πεδίο 'Υλικό'**».
   Αν δεις «Υλικό κενό», έλεγξε **πρώτα τη σειρά**. Η σειρά ορίζει τύπο, αρίθμηση, ΦΠΑ, myDATA.
   Βρίσκεις τα σωστά ids με `getBrowserInfo(SALDOC)` → `getBrowserData` → `getData` σε υπάρχον doc.
   (Προτιμολόγιο = δεν παίρνει ποτέ MARK· για φορολογικό Τ.Π.Υ. χρειάζεται η σειρά του Τ.Π.Υ.)
2. **Λείπει MTRL στη γραμμή** → επίσης «Δεν υπάρχει το πεδίο Υλικό». Γι' αυτό το §5 βήμα 2.
3. **Νέος πελάτης χωρίς ΚΩΔΙΚΟ** → «Δεν έχετε συμπληρώσει το πεδίο 'Κωδικός'» όταν η εγκατάσταση
   δεν έχει αυτόματη αρίθμηση. Λύση: `CODE = ΑΦΜ`.
4. **Πελάτης = πίνακας `TRDR`** (όχι `CUSTOMER`, που είναι object), πολυεταιρικός → φίλτρο
   `COMPANY=:X.SYS.COMPANY AND SODTYPE=13 AND AFM=:1`.
5. **Ένα μόνο `X.SQL` πριν το `CreateObj`.** Δεύτερο `X.SQL` στο ίδιο context χαλάει το ενεργό
   dataset και χάνεται το MTRL στο `DBPOST`. Γι' αυτό ο έλεγχος idempotency είναι **ξεχωριστή κλήση**
   (`mode:"find"`).
6. **Γραμμές = `ITELINES`** (όχι `MTRLINES`, που είναι ο υποκείμενος πίνακας). Κεφαλίδα = `FINDOC`.
   `CreateObj("SALDOC")` **χωρίς** φόρμα και **χωρίς** `LINENUM`.
7. **MTRL και SERIES ως αριθμοί** (`parseInt`), όχι strings.
8. **ΦΠΑ ρητά** στη γραμμή (`d.VAT = <id κατηγορίας>`): μέσω web service δεν «τραβιέται» από το είδος.
9. **COMMENTS και POSGUID σε δύο ΞΕΧΩΡΙΣΤΑ `setData` μετά το `DBPOST`** — μαζί, κρατιέται μόνο το ένα.
10. `X.GETSQLDATASET`: παράμετροι αμέσως μετά το SQL, και **πάντα `ds.FIRST`** πριν την ανάγνωση.
11. `X.WSCALL` **δεν** κάνει εξωτερικές κλήσεις· για εξωτερικό HTTP: `X.HTTPCALL(url, post, headers, method)`
    (headers χωρισμένα με `\r\n`). Ελεύθερο SQL **από έξω** δεν υπάρχει (`SqlData` = μόνο ονομασμένα scripts).
12. **Δείκτης έκδοσης στη γέφυρα** (`resp.v`) + γραμμή «★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ» στο header: η γέφυρα
    επικολλάται **χειροκίνητα** στο SoftOne — έτσι βλέπεις αμέσως αν τρέχει η σωστή. (Το είχαμε
    επικολλήσει σε λάθος script και φαινόταν από το `v`.)

---

## 8. Παρακολούθηση (για να μη μένει τίποτα «σιωπηλά» πίσω)

- Σελίδα admin «Παραστατικά»: κατάσταση, τελευταίο σφάλμα **σε ανθρώπινη γλώσσα**, «Επαναποστολή».
- Νυχτερινός έλεγχος: χρεώσιμα είδη **χωρίς** αντιστοίχιση MTRL (και χωρίς default) → email.
- Μετρητής παραστατικών σε `failed` / `blocked` / pending > 24 ώρες.

---

## 9. Η γέφυρα (SoftOne Advanced JavaScript) — όπως τρέχει σε παραγωγή

Εγκατάσταση: Advanced JavaScript module → επικόλληση → εξωτερική κλήση στο
`POST https://<εγκατάσταση>.oncloud.gr/s1services/JS/<module>/<function>`. Συμπλήρωσε τα ⚙ στο `CFG`.

```javascript
/* ============================================================================
 * RxVision → SoftOne — Custom Web Service (Advanced JavaScript)  [SoftOne BlackBook ver.3.5]
 * ★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ: 2026-11-10 (EET)  ← νέος πελάτης με ΚΩΔΙΚΟ = ΑΦΜ (πριν: «Δεν έχετε συμπληρώσει το πεδίο 'Κωδικός'»)
 * Προηγούμενη: 2026-08-04 23:10 (EEST)  ← + mode "status" (παρακολούθηση ΜΕΤΑΣΧΗΜΑΤΙΣΜΟΥ: FULLYTRANSF + τελικό findoc/MARK μέσω MTRLINES.FINDOCS). Σειρά 7002 (έγκυρη) = δουλεύει.
 *
 * ΣΕΙΡΑ (SERIES): το adminpanel param πρέπει να είναι το internal SERIES id (ΟΧΙ FPRMS/φόρμα!).
 *   π.χ. Τ.Π.Υ.=7767 (φόρμα 7067), Τ.Π.Υ. Ε.Ε.=7069. Κενό/άκυρο → default 7002 (Προτιμολόγιο).
 * ----------------------------------------------------------------------------
 * Δημιουργεί ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ (SALDOC) από το payload του RxVision και το
 * διαβιβάζει στο myDATA (η CloudOn/SoftOne είναι πιστοποιημένος πάροχος). Επιστρέφει findoc/MARK.
 *
 * ΕΓΚΑΤΑΣΤΑΣΗ (ομάδα SoftOne):
 *   1) Advanced JavaScript module (π.χ. RXVISION) → επικόλληση αυτού του κώδικα.
 *   2) Register: AddCode('...', 'RXVISION');  (κατά τα πρότυπα του BlackBook, Chapter K)
 *   3) Κλήση εξωτερικά:  POST https://<name>.oncloud.gr/s1services/JS/RXVISION/createInvoice
 *   4) Στο RxVision adminpanel → SoftOne: js_endpoint = "RXVISION/createInvoice".
 *
 * ΠΡΟΣΟΧΗ — τα CFG.* εξαρτώνται από την ΕΓΚΑΤΑΣΤΑΣΗ CloudOn (σειρές/ΦΠΑ/είδος/πεδίο MARK).
 * Συμπληρώστε/επιβεβαιώστε τα — ΔΕΝ είναι μαντεμένα, είναι placeholders της εγκατάστασης.
 * ============================================================================ */

var CFG = {
  APPID: 0,           // ⚙ appId του SoftOne Web Account της ΔΙΚΗΣ ΣΑΣ εγκατάστασης
  // ⚠ ΤΟ ΠΙΟ ΣΗΜΑΝΤΙΚΟ: η ΣΕΙΡΑ ΟΡΙΖΕΙ τον ΤΥΠΟ (Τιμολόγιο Παροχής Υπηρεσιών) και μαζί ΦΠΑ,
  //   ΑΡΙΘΜΗΣΗ & χαρτογράφηση myDATA. Βάλτε τη σειρά «τιμ. παροχής υπηρεσιών». Όλα τα υπόλοιπα
  //   (ΦΠΑ, σύνολα, αριθμός, myDATA) τα υπολογίζει ΜΟΝΟ του το SoftOne στο DBPOST.
  SERIES: 0,        // ΣΕΙΡΑ Τιμολογίου Παροχής Υπηρεσιών (ΟΧΙ 7001 = προσφορά) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  SODTYPE_CUSTOMER: 13,          // 13 = Πελάτες (SoftOne standard)
  COUNTRY_CODE: 1000,        // κωδικός ΧΩΡΑΣ SoftOne για δημιουργία πελάτη (Ελλάδα) — ΕΠΙΒΕΒΑΙΩΣΤΕ (ΟΧΙ "GR")
  TRDCATEGORY: 0,           // (προαιρετικό) κατηγορία πελάτη· βάλτε αν το SoftOne την απαιτεί στη δημιουργία
  SERVICE_MTRL: 0,           // MTRL υπηρεσίας (fallback αν η γραμμή δεν έχει MTRL) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  // id κατηγορίας ΦΠΑ 24% (το web-service ΔΕΝ «τραβάει» αυτόματα το ΦΠΑ του είδους → το βάζουμε ρητά).
  VAT: 0,             // ⚙ id κατηγορίας ΦΠΑ 24% της εγκατάστασης
  MARK_SQL: "SELECT MARK, UID, AA FROM FINDOC WHERE FINDOC="   // ανάγνωση myDATA MARK/UID — ΕΠΙΒΕΒΑΙΩΣΤΕ
};

/* Locate-or-create πελάτη με ΑΦΜ → επιστρέφει TRDR (primary key). */
function _hasNum(v) { return v !== null && v !== undefined && ("" + v).replace(/[^0-9]/g, "") !== ""; }

function _findOrCreateCustomer(c) {
  var afm = (c && c.afm) ? ("" + c.afm) : "";
  if (!afm) return { error: "missing_afm" };
  var diag = [];
  // A) ΕΝΤΟΠΙΣΜΟΣ με ΑΦΜ στην εταιρεία σύνδεσης (BlackBook σ.303 — πίνακας TRDR + COMPANY).
  try {
    var tA = X.SQL("SELECT TRDR FROM TRDR WHERE COMPANY=:X.SYS.COMPANY AND SODTYPE=" + CFG.SODTYPE_CUSTOMER + " AND AFM=:1", afm);
    diag.push("A='" + tA + "'");
    if (_hasNum(tA)) return { trdr: ("" + tA).split(",")[0] };
  } catch (e) { diag.push("Aex=" + e.message); }
  // B) fallback ΧΩΡΙΣ φίλτρο εταιρείας (μήπως ο πελάτης είναι σε άλλη εταιρεία· το TRDR είναι global).
  try {
    var tB = X.SQL("SELECT TRDR FROM TRDR WHERE SODTYPE=" + CFG.SODTYPE_CUSTOMER + " AND AFM=:1", afm);
    diag.push("B='" + tB + "'");
    if (_hasNum(tB)) return { trdr: ("" + tB).split(",")[0] };
  } catch (e) { diag.push("Bex=" + e.message); }
  // Διάγνωση: ποια εταιρεία «βλέπει» το session.
  try { diag.push("comp=" + X.SQL("SELECT :X.SYS.COMPANY", null)); } catch (e) { diag.push("compEx=" + e.message); }
  // Γ) ΔΗΜΙΟΥΡΓΙΑ νέου πελάτη (αν χρειάζεται «Κωδικός», ενεργοποιήστε ΑΥΤΟΜΑΤΗ ΑΡΙΘΜΗΣΗ στον πελάτη).
  // ΚΩΔΙΚΟΣ πελάτη = ΑΦΜ: η εγκατάσταση δεν έχει αυτόματη αρίθμηση πελατών, οπότε χωρίς CODE η
  // δημιουργία απορριπτόταν και το παραστατικό έμενε «Απέτυχε» (περιστατικό παραγωγής).
  var cust = {
    SODTYPE: CFG.SODTYPE_CUSTOMER, CODE: afm, NAME: c.name || "", AFM: afm, IRSDATA: c.doy || "",
    ADDRESS: c.address || "", CITY: c.city || "", ZIP: c.zip || "",
    PHONE01: c.phone || "", EMAIL: c.email || "", COUNTRY: CFG.COUNTRY_CODE
  };
  if (CFG.TRDCATEGORY) cust.TRDCATEGORY = CFG.TRDCATEGORY;
  var res = JSON.parse(X.WEBREQUEST(JSON.stringify(
    { SERVICE: "setData", OBJECT: "CUSTOMER", appid: CFG.APPID, DATA: { CUSTOMER: [cust] } })));
  if (res && res.success && res.id) return { trdr: res.id };
  // Επιστροφή ΑΝΑΛΥΤΙΚΗΣ διάγνωσης (τι επέστρεψε κάθε αναζήτηση + εταιρεία session) + σφάλμα δημιουργίας.
  var ce = (res && res.error) ? res.error : "create_failed";
  return { error: "find[" + diag.join(" ") + "] create[" + ce + "]" };
}

/* Ανάγνωση myDATA MARK/UID/AA μετά την έκδοση. */
function _getMyData(findoc) {
  try {
    var rows = X.GETSQLDATASET(CFG.MARK_SQL + findoc, null);   // BlackBook: εκτέλεση SQL & λήψη dataset
    if (rows && rows.length > 0) {
      return { mark: rows[0].MARK, uid: rows[0].UID, aa: rows[0].AA };
    }
  } catch (e) { /* το πεδίο εξαρτάται από το myDATA module — γύρνα κενό αν δεν βρεθεί */ }
  return { mark: "", uid: "", aa: "" };
}

/* ── Το custom web service (κλήση: /s1services/JS/RXVISION/createInvoice) ── */
function createInvoice(obj) {
  var resp = { success: false, v: "261110" };   // δείκτης έκδοσης γέφυρας (επιβεβαιώνει ΟΤΙ τρέχει η σωστή)
  if (!obj || !obj.clientID || obj.clientID === "") { resp.error = "Authenticate failed: missing clientID"; return resp; }

  // ⛔ IDEMPOTENCY — mode "find": ΜΟΝΟ X.SQL lookup (POSGUID), ΚΑΜΙΑ δημιουργία. Το backend το καλεί
  //    ΞΕΧΩΡΙΣΤΑ πριν την έκδοση. Κρίσιμο: το X.SQL ΔΕΝ πρέπει να τρέχει στο ΙΔΙΟ context με το CreateObj
  //    (δεύτερο X.SQL πριν το CreateObj χαλάει το ενεργό dataset → «Δεν συμπληρώσατε το πεδίο Υλικό»).
  if (obj.mode === "find") {
    var fr = { success: true, findoc: 0 };
    if (obj.ref) {
      try {
        var ex = X.SQL("SELECT FINDOC FROM FINDOC WHERE COMPANY=:X.SYS.COMPANY AND POSGUID=:1", "" + obj.ref);
        if (ex !== null && ("" + ex) !== "" && parseInt("" + ex, 10) > 0) {
          fr.findoc = parseInt("" + ex, 10);
          var fmd = _getMyData(fr.findoc);
          fr.mark = fmd.mark; fr.uid = fmd.uid; fr.aa = fmd.aa;
        }
      } catch (e) { fr.error = e.message; }
    }
    return fr;
  }

  // 🔄 ΜΕΤΑΣΧΗΜΑΤΙΣΜΟΣ — mode "status": δίνει το ref (POSGUID) → επιστρέφει την κατάσταση του
  //    προτιμολογίου μας ΚΑΙ, αν μετασχηματίστηκε σε τελικό Τ.Π.Υ., το findoc + MARK του τελικού.
  //    Σύνδεση πηγής→στόχου: MTRLINES.FINDOCS = <findoc πηγής> (BlackBook: DelConvertedDocs). ΜΟΝΟ X.SQL.
  if (obj.mode === "status") {
    var st = { success: true, findoc: 0, fullytransf: null, target_findoc: 0, target_series: "", mark: "", uid: "", aa: "" };
    if (obj.ref) {
      try {
        var src = X.SQL("SELECT FINDOC FROM FINDOC WHERE COMPANY=:X.SYS.COMPANY AND POSGUID=:1", "" + obj.ref);
        if (src !== null && ("" + src) !== "" && parseInt("" + src, 10) > 0) {
          st.findoc = parseInt("" + src, 10);
          try { st.fullytransf = "" + X.SQL("SELECT FULLYTRANSF FROM FINDOC WHERE FINDOC=:1", "" + st.findoc); } catch (e1) { }
          // βρες το μετασχηματισμένο (target) doc — οι γραμμές του δείχνουν στο πηγαίο findoc
          var tgt = X.SQL("SELECT MIN(FINDOC) FROM MTRLINES WHERE COMPANY=:X.SYS.COMPANY AND FINDOCS=:1", "" + st.findoc);
          if (tgt !== null && ("" + tgt) !== "" && parseInt("" + tgt, 10) > 0) {
            st.target_findoc = parseInt("" + tgt, 10);
            try { st.target_series = "" + X.SQL("SELECT SERIES FROM FINDOC WHERE FINDOC=:1", "" + st.target_findoc); } catch (e2) { }
            var tmd = _getMyData(st.target_findoc);
            st.mark = tmd.mark; st.uid = tmd.uid; st.aa = tmd.aa;
          }
        }
      } catch (e) { st.error = e.message; }
    }
    return st;
  }

  if (!obj.customer || !obj.customer.afm) { resp.error = "missing customer AFM"; return resp; }
  if (!obj.lines || obj.lines.length === 0) { resp.error = "missing lines"; return resp; }
  var myObj = null;
  try {
    // ⚠ ΚΑΘΑΡΗ διαδρομή δημιουργίας: το ΜΟΝΟ X.SQL πριν το CreateObj είναι το customer lookup (όπως στην
    //   έκδοση ★17 που ήταν αξιόπιστη). Ο έλεγχος idempotency γίνεται ΞΕΧΩΡΙΣΤΑ (mode "find"), ΠΟΤΕ εδώ —
    //   δεύτερο X.SQL εδώ χαλάει το dataset και χάνεται το MTRL στο DBPOST.
    var cust = _findOrCreateCustomer(obj.customer);   // ΤΕΛΕΥΤΑΙΟ (& μόνο) X.SQL πριν το CreateObj
    if (!cust.trdr) { resp.error = "customer: " + (cust.error || "locate_or_create_failed"); return resp; }
    var seriesVal = (obj.softone_series !== undefined && obj.softone_series !== null && ("" + obj.softone_series) !== "") ? obj.softone_series : CFG.SERIES;

    // ΔΗΜΙΟΥΡΓΙΑ ΠΑΡΑΣΤΑΤΙΚΟΥ ως OBJECT (BlackBook σ.284): σειρά+πελάτης+γραμμές (είδος/ποσ/τιμή/ΦΠΑ).
    // Το SoftOne κάνει σύνολα/αρίθμηση/myDATA στο DBPOST. ΣΕΙΡΑ & MTRL ως ΑΡΙΘΜΟΙ· ΦΠΑ ρητά (d.VAT).
    // ★ ΕΠΑΝΑΦΟΡΑ ΣΤΗΝ ΕΚΔΟΣΗ ★17:36 ΠΟΥ ΔΟΥΛΕΥΕ (τα παραστατικά έπεφταν κανονικά). ΧΩΡΙΣ φόρμα,
    //   ΧΩΡΙΣ d.LINENUM (αυτά τα πρόσθεσα εγώ μετά και τα χάλασαν)· ΜΕ h.COMMENTS στην κεφαλίδα.
    myObj = X.CreateObj("SALDOC");
    myObj.DBINSERT;
    var h = myObj.FindTable("FINDOC");     // κεφαλίδα παραστατικού
    var d = myObj.FindTable("ITELINES");   // γραμμές ειδών

    h.Edit;
    h.SERIES = parseInt("" + seriesVal, 10);   // ΣΕΙΡΑ ως ΑΡΙΘΜΟΣ (ορίζει τύπο + αρίθμηση + myDATA)· από adminpanel
    h.TRDR = cust.trdr;
    if (obj.issue_date) h.TRNDATE = obj.issue_date;   // YYYY-MM-DD
    h.COMMENTS = obj.comments || "";                  // ΑΙΤΙΟΛΟΓΙΑ στην κεφαλίδα (όπως στην ★17:36 που δούλευε)

    for (var i = 0; i < obj.lines.length; i++) {
      var ln = obj.lines[i];
      var unit = (ln.unit_net !== undefined && ln.unit_net !== null) ? ln.unit_net : ln.net;  // καθαρή τιμή μονάδας
      // ⚠ MTRL ως ΑΡΙΘΜΟΣ (όχι string) → το SoftOne «τραβάει» ΦΠΑ/τιμή από το ΕΙΔΟΣ (cascade).
      var mtrlNum = parseInt("" + ((ln.mtrl !== undefined && ln.mtrl !== null && ln.mtrl !== "") ? ln.mtrl : CFG.SERVICE_MTRL), 10);
      d.Append;
      d.MTRL = mtrlNum;
      d.QTY1 = (typeof ln.qty === "number") ? ln.qty : (parseFloat(ln.qty) || 1);
      d.PRICE = (typeof unit === "number") ? unit : (parseFloat(unit) || 0);
      if (CFG.VAT) d.VAT = CFG.VAT;   // ΦΠΑ ΡΗΤΑ (σταθερή τιμή, ΧΩΡΙΣ X.SQL) — το web-service δεν το τραβάει μόνο του
      d.Post;
    }

    var findoc = myObj.DBPOST;             // αποθήκευση → SoftOne αριθμεί + διαβιβάζει myDATA
    if (!(findoc > 0)) {
      resp.error = "saldoc_post_failed" + (myObj.GETLASTERROR ? ": " + myObj.GETLASTERROR : "");
      return resp;
    }

    // 3) ΜΕΤΑ την έκδοση, με setData (αξιόπιστο). ⚠ ΞΕΧΩΡΙΣΤΑ setData: όταν COMMENTS & POSGUID μπουν
    //    ΜΑΖΙ στο ίδιο patch, το SoftOne κρατά μόνο το ένα (το COMMENTS χάνεται). Δύο κλήσεις → κολλάνε και τα δύο.
    if (obj.comments) {
      try {
        X.WEBREQUEST(JSON.stringify({ SERVICE: "setData", OBJECT: "SALDOC", appid: CFG.APPID,
          KEY: "" + findoc, DATA: { SALDOC: [{ FINDOC: findoc, COMMENTS: obj.comments }] } }));
      } catch (e) { /* μη κρίσιμο */ }
    }
    if (obj.ref) {   // POSGUID = idempotency key (ώστε το επόμενο retry να βρει το doc, όχι διπλό)
      try {
        X.WEBREQUEST(JSON.stringify({ SERVICE: "setData", OBJECT: "SALDOC", appid: CFG.APPID,
          KEY: "" + findoc, DATA: { SALDOC: [{ FINDOC: findoc, POSGUID: "" + obj.ref }] } }));
      } catch (e) { /* μη κρίσιμο */ }
    }

    // 4) myDATA MARK/UID/AA
    var md = _getMyData(findoc);
    resp.success = true;
    resp.findoc = findoc;
    resp.mark = md.mark;
    resp.uid = md.uid;
    resp.aa = md.aa;
    resp.ref = obj.ref || "";
  } catch (e) {
    resp.error = e.message + (myObj && myObj.GETLASTERROR ? " | GETLASTERROR: " + myObj.GETLASTERROR : "");
  }
  return resp;
}
```

---

## 10. Παραδοτέα για το νέο σύστημα

1. Ρυθμίσεις SoftOne (κρυπτογραφημένες) + «Δοκιμή σύνδεσης» + αντιστοίχιση ειδών → MTRL με default.
2. `invoices` + `create_for_payment` σε **κάθε** σημείο επιτυχημένης χρέωσης.
3. Worker αποστολής (5′) με ατομικό claim, «find» πριν την έκδοση, retry/backoff.
4. Worker μετασχηματισμού/απόδειξης (15′).
5. Η γέφυρα JS (§9), προσαρμοσμένη στα ⚙ της εγκατάστασης.
6. Τεστ: διπλό webhook → 1 παραστατικό· timeout μετά την έκδοση → 1 παραστατικό· χωρίς MTRL → pending
   χωρίς κάψιμο προσπάθειας· χωρίς ΑΦΜ → blocked· ποσό παραστατικού = ποσό χρέωσης.

---

## 11. Εφεδρική λύση: «αντεστραμμένη» ροή (όταν η SoftOne δεν δέχεται εισερχόμενες κλήσεις)

Δοκίμασέ το **πριν** γράψεις κώδικα: `POST {base_url}` χωρίς login πρέπει να απαντά 200 «Please login
first». Αν απαντά **404**, το domain της εγκατάστασης (`*.oncloud.gr`) μπορεί να δείχνει σε άλλο
περιβάλλον (π.χ. R&D αντί για live, ίδιος σειριακός). Τότε καμία εισερχόμενη κλήση δεν φτάνει στη live
και η §2–§5 δεν δουλεύουν όπως είναι. Λύση χωρίς αλλαγή DNS ή άνοιγμα της βάσης τους:

1. Στο **δικό μας** σύστημα δύο endpoints, προστατευμένα με κοινό μυστικό σε header `X-S1-Token`
   (σύγκριση σταθερού χρόνου, κρυπτογραφημένο στη βάση, ορατό μόνο στο admin):
   - `GET /softone/pull` → δίνει τα εκκρεμή παραστατικά (ίδιο payload με §4) και τα «κρατά» 15′
     (ατομικό claim), ώστε να μη δοθούν δύο φορές·
   - `POST /softone/ack` → η SoftOne γράφει πίσω `findoc` / ΜΑΡΚ ή το σφάλμα.
2. Στη **SoftOne**, προγραμματισμένη εργασία (κάθε 10′) που: καλεί `pull` με `X.HTTPCALL(url, post,
   headers, method)` — **όχι** `X.WSCALL`, που δεν κάνει εξωτερικές κλήσεις — εκδίδει **εσωτερικά**
   με `X.WEBREQUEST({SERVICE:"setData", OBJECT:"SALDOC", ...})`, και καλεί `ack`.
3. Ίδιοι κανόνες: POSGUID = ref για idempotency (§5), `X.GETSQLDATASET` πάντα με `ds.FIRST`,
   έγκυρο internal SERIES id (§7). Ο Scheduler της SoftOne τρέχει Batch jobs, όχι JavaScript
   απευθείας: χρειάζεται σημείο εισόδου (μενού/SBSL wrapper) που το στήνει ο συνεργάτης SoftOne,
   μαζί με εξερχόμενη πρόσβαση 443 προς το σύστημά μας.

Κράτα και τις δύο ροές πίσω από τον ίδιο πίνακα `invoices`: η αλλαγή από τη μία στην άλλη δεν
πρέπει να αγγίζει τίποτα άλλο.
