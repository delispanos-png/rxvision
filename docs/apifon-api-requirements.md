# Τεχνική Προδιαγραφή Ολοκλήρωσης — Apifon × RxVision

**Έκδοση εγγράφου:** 2.0 · **Ημερομηνία:** 2026-07-08
**Λογαριασμός:** Κεντρικός λογαριασμός RxVision (πλατφόρμα) — OAuth2 `client_credentials`
**Τεχνική επικοινωνία:** delis.panos@gmail.com
**Παραγωγικό domain:** `app.rxvision.gr`

> **Σκοπός του εγγράφου.** Είναι μια **πλήρης τεχνική προδιαγραφή** ώστε η ομάδα της
> Apifon να μπορέσει να **ενεργοποιήσει / υλοποιήσει** τα σημεία που χρειαζόμαστε, χωρίς
> πρόσθετες διευκρινίσεις. Για κάθε αίτημα δίνουμε: (α) τι κάνουμε **σήμερα**, (β) τι
> **ζητάμε** ακριβώς, (γ) **παραδείγματα JSON** που ήδη παράγουμε ή που μπορούμε να
> καταναλώσουμε, και (δ) **κριτήρια αποδοχής**. Στο **Παράρτημα Α** περιγράφουμε ακριβώς
> ποιες μορφές δέχεται ήδη ο webhook μας — αν η υλοποίησή σας ταιριάξει με μία από αυτές,
> **δεν χρειάζεται καμία αλλαγή** από την πλευρά μας.

---

## 0. Περίληψη — τι λειτουργεί & τι λείπει

### ✅ Ήδη σε παραγωγική λειτουργία (επιβεβαιωμένο)

| Λειτουργία | Endpoint | Κατάσταση |
|---|---|---|
| Αυθεντικοποίηση | `POST https://ids.apifon.com/oauth2/token` (OAuth2 `client_credentials`, **χωρίς `scope`**) | ✅ Bearer token λαμβάνεται |
| Αποστολή SMS | `POST https://ars.apifon.com/services/api/v1/sms/send` | ✅ Παραδίδεται |
| Αποστολή Viber | `POST https://ars.apifon.com/services/api/v1/im/send` | ✅ Παραδίδεται |
| Υπόλοιπο λογαριασμού | `POST https://ars.apifon.com/services/api/v1/balance` | ✅ Επιστρέφει `{balance, reserved, plafon, subscriptions}` |

### ⭕ Τι χρειαζόμαστε από εσάς (αντικείμενο αυτού του εγγράφου)

1. **Delivery Receipts (DLR)** — callbacks παράδοσης προς webhook μας (§1) — **ΚΡΙΣΙΜΟ**
2. **Message ID** στην απόκριση αποστολής, που να ταιριάζει με το DLR (§2) — **ΚΡΙΣΙΜΟ**
3. **Native Viber → SMS fallback** (§3)
4. **Endpoint polling κατάστασης** ως εφεδρεία (§4)
5. **Balance + τιμοκατάλογος ανά κανάλι** (§5)
6. **Sender IDs** (§6)
7. **Μη-λειτουργικές απαιτήσεις**: ασφάλεια, retries, throughput, sandbox (§7)

---

## 1. Delivery Receipts (DLR) — Callbacks παράδοσης ⭐ ΚΡΙΣΙΜΟ

### 1.1 Τι θέλουμε να πετύχουμε (business)

Για **κάθε** μήνυμα (SMS & Viber) θέλουμε να μάθουμε **αν παραδόθηκε ή όχι**, ώστε:
- να το δείχνουμε στον πελάτη-φαρμακείο («Παραδόθηκε / Δεν παραδόθηκε»), και
- να **επιστρέφουμε αυτόματα credits** για ό,τι **δεν** παραδόθηκε.

Αυτό απαιτεί **asynchronous callback (DLR)** από εσάς προς εμάς, μετά την τελική
κατάσταση κάθε μηνύματος.

### 1.2 Το endpoint μας (έτοιμο να δεχτεί τα callbacks)

```
URL     : https://app.rxvision.gr/api/v1/communications/apifon-dlr
Method  : POST
Accept  : application/json  (δεχόμαστε ΚΑΙ application/x-www-form-urlencoded)
Απόκριση: 200 OK  { "ok": true }   — απαντάμε άμεσα, το processing είναι non-blocking
Timeout : απαντάμε < 5 δευτ.
```

### 1.3 Τι ζητάμε να μας απαντήσετε / ενεργοποιήσετε

1. **Ενεργοποίηση DLR callbacks** για **SMS** και **Viber (IM Gateway)** στον κεντρικό
   λογαριασμό μας.
2. **Πώς δηλώνεται το callback URL** — ποιο από τα παρακάτω ισχύει;
   - **(α) Per-request:** πεδίο μέσα στο body της αποστολής. Αν ναι, **δώστε ακριβές όνομα
     & δομή** (π.χ. `callback_url`, `delivery_receipts`, `dlr_url`, `webhook`). Θα το
     προσθέσουμε εμείς σε κάθε `sms/send` και `im/send`.
   - **(β) Per-account (static):** το ρυθμίζετε εσείς/εμείς μία φορά στο portal ή μέσω
     support. Αν ναι, **καταχωρίστε το URL της §1.2**.
   - **(γ) Και τα δύο** (per-account default + per-request override) — ιδανικό.
3. **Ακριβές schema του DLR payload** — δώστε **επίσημο δείγμα JSON** (single + batch), με:
   - Το πεδίο του **message id** (πρέπει να είναι **ίδιο** με το id της απόκρισης αποστολής — §2).
   - Το πεδίο **κατάστασης** + **πλήρη λίστα δυνατών τιμών** (SMS & Viber ξεχωριστά).
   - Το πεδίο **timestamp** παράδοσης (+ μορφή/timezone).
   - Προαιρετικά: reason/error code για μη-παράδοση, MCC/MNC, αριθμό παραλήπτη.
4. **Batching:** στέλνετε **ένα event ανά κλήση** ή **array πολλών** σε μία κλήση; (Δεχόμαστε
   και τα δύο — δείτε Παράρτημα Α.)
5. **Content-Type:** `application/json` (προτιμώμενο) ή form-encoded;

### 1.4 Παράδειγμα DLR που **μπορούμε να καταναλώσουμε άμεσα**

Αν το callback σας έχει μία από αυτές τις μορφές, δουλεύει **χωρίς αλλαγή κώδικα** από
εμάς (batch array — προτιμώμενο):

```json
[
  {
    "message_id": "b3f1c2a4-0001-...",     // ίδιο id με την απόκριση αποστολής (§2)
    "status": "DELIVERED",                  // βλ. πίνακα τιμών §1.5
    "status_code": "DELIVRD",
    "channel": "sms",
    "to": "306901234567",
    "delivered_at": "2026-07-08T10:32:11Z"
  },
  {
    "message_id": "b3f1c2a4-0002-...",
    "status": "UNDELIVERED",
    "reason": "ABSENT_SUBSCRIBER",
    "channel": "viber",
    "to": "306907654321",
    "delivered_at": "2026-07-08T10:32:40Z"
  }
]
```

Ισοδύναμα δεκτό (single object με wrapper):

```json
{ "results": [ { "message_id": "...", "status": "DELIVERED" } ] }
```

### 1.5 Χαρτογράφηση κατάστασης (πώς την ερμηνεύουμε σήμερα)

Ο parser μας κάνει **uppercase** την τιμή κατάστασης και την κατατάσσει ως εξής. **Παρακαλούμε
επιβεβαιώστε ότι οι πραγματικές σας τιμές καλύπτονται· αν όχι, στείλτε την πλήρη λίστα σας
για να την προσθέσουμε.**

| Ερμηνεία μας | Τιμές που **ήδη** αναγνωρίζουμε | Ενέργεια |
|---|---|---|
| **Παραδόθηκε** (`delivered`) | `DELIVERED`, `DELIVRD`, `READ`, `SEEN` | ✔ σήμανση παράδοσης |
| **Δεν παραδόθηκε** (`failed`) | `UNDELIVERED`, `UNDELIVERABLE`, `FAILED`, `EXPIRED`, `REJECTED`, `ERROR` | ↩ **επιστροφή credits** |
| Ενδιάμεσο (π.χ. `SENT`, `ENROUTE`, `ACCEPTED`, `BUFFERED`) | αγνοούνται (περιμένουμε τελική) | — |

> Ζητούμενο: **τελική λίστα κωδικών** ανά κανάλι (SMS DLR & Viber statuses), ώστε να μην
> χάνεται ή παρερμηνεύεται καμία τιμή (π.χ. Viber «seen» vs «delivered»).

### 1.6 Ασφάλεια webhook (επαλήθευση γνησιότητας) ⭐

Το endpoint είναι **δημόσιο**. Χρειαζόμαστε **τουλάχιστον έναν** από τους παρακάτω
μηχανισμούς για να επιβεβαιώνουμε ότι το callback ήρθε όντως από την Apifon:

- **(Προτιμώμενο) HMAC υπογραφή σε header** — π.χ. `X-Apifon-Signature: <base64(HMAC-SHA256(rawBody, secret))>`.
  Δώστε: όνομα header, αλγόριθμο, **ποιο secret** χρησιμοποιείται (το client_secret ή
  ξεχωριστό signing key;), και πάνω σε **ποιο ακριβώς payload** (raw body bytes) υπολογίζεται.
- **(Απλό) Shared secret στο URL** — μπορούμε να σας δώσουμε URL της μορφής
  `https://app.rxvision.gr/api/v1/communications/apifon-dlr?token=<μυστικό>` και να το
  ελέγχουμε εμείς. Πείτε μας αν αυτό σας βολεύει — είναι το πιο γρήγορο.
- **(Δικτυακά) Λίστα source IPs** από τις οποίες καλείτε τα callbacks, για allow-listing.

### 1.7 Αξιοπιστία / Retries

- Αν το endpoint μας απαντήσει **μη-2xx** ή κάνει timeout, κάνετε **retry**; Πόσες φορές &
  με τι backoff; (θέλουμε να μη χάνεται κανένα DLR).
- Υπάρχει **at-least-once** εγγύηση; (Ο parser μας είναι **idempotent**: διπλό DLR για το
  ίδιο id/κατάσταση αγνοείται — άρα τα retries είναι ασφαλή.)

### 1.8 Κριτήρια αποδοχής (§1)

1. Στέλνουμε 1 SMS + 1 Viber σε πραγματικούς αριθμούς.
2. Λαμβάνουμε στο endpoint μας 2 DLR με τα **σωστά message ids** (§2) και τελική κατάσταση.
3. Ένα σκόπιμα μη-παραδόσιμο μήνυμα (π.χ. ανύπαρκτος αριθμός) παράγει `UNDELIVERED` → το
   σύστημά μας **επιστρέφει αυτόματα** τα credits.

---

## 2. Message ID στην απόκριση αποστολής ⭐ ΚΡΙΣΙΜΟ

### 2.1 Το πρόβλημα

Για να συσχετίσουμε ένα DLR (§1) με το σωστό μήνυμα, αποθηκεύουμε ένα **provider message id**
από την **απόκριση** των `sms/send` / `im/send`. Πρέπει αυτό το id να είναι **το ίδιο** που
θα εμφανιστεί αργότερα στο DLR.

### 2.2 Τι διαβάζουμε σήμερα (αμυντικά)

Ψάχνουμε το id με την εξής σειρά προτεραιότητας (πρώτο που βρεθεί):

1. `request_id` (top-level)
2. `results` ως **object** → για κάθε τιμή: `message_id` ή `id`
3. `results` ως **array** → `results[0].message_id` ή `results[0].id`
4. `id` (top-level)

### 2.3 Τι ζητάμε

- **Ποιο ακριβώς πεδίο** της απόκρισης αποστολής είναι το **μοναδικό id ανά παραλήπτη/μήνυμα**;
- Δώστε **δείγμα απόκρισης** για:
  - **single** αποστολή (1 παραλήπτης),
  - **bulk** αποστολή (πολλοί παραλήπτες σε μία κλήση) — πώς αντιστοιχίζεται ένα id **ανά
    παραλήπτη**;
- Σε bulk: το `request_id` είναι **ένα για όλη την κλήση** ή **ένα ανά παραλήπτη**; (Αν είναι
  ένα για όλη την κλήση, χρειαζόμαστε **ξεχωριστό per-recipient id** για να ταιριάζει με το DLR.)

### 2.4 Παράδειγμα απόκρισης που θα ήταν ιδανικό για εμάς

```json
{
  "request_id": "req-2026-07-08-abc",
  "results": {
    "306901234567": [ { "message_id": "b3f1c2a4-0001-...", "length": 1, "cost": 1 } ],
    "306907654321": [ { "message_id": "b3f1c2a4-0002-...", "length": 1, "cost": 1 } ]
  }
}
```

*(Κάθε `message_id` εδώ πρέπει να είναι αυτό που θα δούμε στο DLR του §1.4.)*

---

## 3. Native Viber → SMS Fallback

### 3.1 Στόχος

Όταν ένα **Viber** μήνυμα **δεν παραδοθεί** (ο παραλήπτης δεν έχει Viber / είναι offline),
θέλουμε να **παραδίδεται αυτόματα ως SMS**, ιδανικά μέσα στην **ίδια κλήση**.

### 3.2 Τι στέλνουμε σήμερα (Viber, IM Gateway)

```json
{
  "subscribers": [ { "number": "306901234567" } ],
  "im_channels": [
    { "id": "viber", "text": "Το κείμενο", "sender_id": "PHARMACY" }
  ]
}
```

### 3.3 Ερωτήματα

- Υποστηρίζει ο IM Gateway **native fallback** σε SMS; Αν ναι, **ποια η δομή**;
  π.χ. δεύτερο entry στο `im_channels`:
  ```json
  "im_channels": [
    { "id": "viber", "text": "…", "sender_id": "PHARMACY" },
    { "id": "sms",   "text": "…", "sender_id": "PHARMACY" }
  ]
  ```
  ή ξεχωριστό πεδίο `fallback` / `waterfall`; **Δώστε το ακριβές schema.**
- **Χρονισμός fallback:** μετά από πόσο χρόνο μη-παράδοσης Viber ενεργοποιείται το SMS;
  Ρυθμίζεται;
- **Τιμολόγηση:** χρεώνεται **μόνο το κανάλι που τελικά παραδόθηκε**, ή και τα δύο;
- **DLR διάκριση:** στο callback (§1) πώς **ξεχωρίζουμε** αν παραδόθηκε ως **Viber** ή ως
  **SMS** (χρειάζεται για σωστή χρέωση/επιστροφή στο πορτοφόλι του πελάτη)? Ζητάμε πεδίο
  τύπου `delivered_channel: "viber" | "sms"`.

*(Αν δεν υπάρχει native fallback: θα το κάνουμε εμείς εφαρμογικά — Viber, και σε DLR «not
delivered» στέλνουμε SMS. Προτιμούμε όμως το native για ακρίβεια χρόνου & κόστους.)*

---

## 4. Endpoint Polling Κατάστασης (εφεδρικό)

Ως **εφεδρεία** στα callbacks (π.χ. αν χαθεί ή καθυστερήσει ένα DLR), θέλουμε να μπορούμε
να **ρωτήσουμε** ενεργά την κατάσταση.

- Υπάρχει endpoint **query κατάστασης** για ένα ή περισσότερα message ids;
- Δώστε: **URL, μέθοδο, παραμέτρους** (message id / request id), σχήμα απόκρισης, **rate
  limits**, και **retention** (για πόσο διάστημα μετά την αποστολή είναι διαθέσιμη η κατάσταση;).

---

## 5. Balance & Τιμοκατάλογος ανά κανάλι

### 5.1 Υπόλοιπο (επιβεβαίωση)

- Επιβεβαιώστε ότι το `POST https://ars.apifon.com/services/api/v1/balance` (με body `{}`)
  είναι το **σωστό & σταθερό** endpoint. Σήμερα λαμβάνουμε:
  `{ "balance": …, "reserved": …, "plafon": …, "subscriptions": … }` — επιβεβαιώστε
  **μονάδες** (ευρώ; λεπτά; SMS units;) κάθε πεδίου.

### 5.2 Τιμές ανά κανάλι (νέο αίτημα)

- Υπάρχει endpoint που επιστρέφει την **τρέχουσα χρέωση ανά κανάλι** (SMS εσωτ./εξωτ., Viber),
  ώστε να **συγχρονίζουμε αυτόματα** το κόστος αντί να το ρυθμίζουμε χειροκίνητα;
- Πώς τιμολογείται το SMS όταν σπάει σε **πολλαπλά μέρη** (>160 / >70 Unicode χαρακτήρες);
  Το `cost`/`length` της απόκρισης αποστολής (§2.4) το αντικατοπτρίζει;

---

## 6. Sender IDs

- Επιβεβαιώστε τα **εγκεκριμένα sender IDs** στον λογαριασμό μας:
  - **SMS**: alphanumeric sender(s) + τυχόν όρια/χώρες.
  - **Viber**: εγκεκριμένος Viber sender / service id.
- Μπορούμε να ορίζουμε **διαφορετικό sender ανά αποστολή** στην ίδια κλήση (πεδίο `sender_id`);
  (Στο μέλλον ίσως θέλουμε να φαίνεται η επωνυμία **κάθε φαρμακείου** — προαιρετικό, αλλά καλό
  να ξέρουμε αν επιτρέπεται & τι έγκριση απαιτεί.)

---

## 7. Μη-λειτουργικές απαιτήσεις

- **Sandbox / test:** υπάρχει test περιβάλλον ή test numbers για να επαληθεύσουμε DLR χωρίς
  πραγματική χρέωση;
- **Throughput / rate limits:** μέγιστο μηνυμάτων/δευτ. στα `sms/send` & `im/send`; Μέγιστοι
  παραλήπτες ανά bulk κλήση;
- **Token OAuth:** επιβεβαιώστε το `expires_in` (το cache-άρουμε) και ότι **δεν** χρειάζεται
  `scope` (με scope παίρναμε `401` στο SMS — επιβεβαιωμένο από εμάς).
- **Χαρακτήρες/encoding:** UTF-8 / GSM-7 handling — το `length`/`cost` της απόκρισης το
  υπολογίζει σωστά για ελληνικούς (Unicode) χαρακτήρες;
- **Idempotency αποστολής:** υποστηρίζετε client-side idempotency key για αποφυγή διπλής
  χρέωσης σε retry; Αν ναι, ποιο πεδίο/header;

---

## Παράρτημα Α — Τι δέχεται **ήδη** ο webhook μας (μηδέν αλλαγή αν ταιριάξετε)

Ο parser του `POST /communications/apifon-dlr` είναι σχεδιασμένος **αμυντικά**. Αν το callback
σας ταιριάζει με οτιδήποτε παρακάτω, **δεν χρειάζεται καμία αλλαγή** από την πλευρά μας.

**Δομή (envelope) — δεκτά όλα:**
- top-level **array**: `[ {event}, {event}, … ]`
- ή object με ένα από τα wrappers: `{"results":[…]}`, `{"statuses":[…]}`,
  `{"delivery_receipts":[…]}`
- ή **μονό** event object.

**Πεδίο message id — δεκτό ένα από:** `message_id` · `id` · `request_id`

**Πεδίο κατάστασης — δεκτό ένα από (case-insensitive):** `status` · `delivery_status` ·
`status_code`

**Αναγνωριζόμενες τιμές (μετά από uppercase):**
- Παράδοση → `DELIVERED`, `DELIVRD`, `READ`, `SEEN`
- Μη-παράδοση → `UNDELIVERED`, `UNDELIVERABLE`, `FAILED`, `EXPIRED`, `REJECTED`, `ERROR`
- Οτιδήποτε άλλο → αγνοείται (θεωρείται ενδιάμεση κατάσταση, περιμένουμε τελικό DLR)

**Συμπεριφορά:**
- Απαντάμε **200** `{"ok":true}` άμεσα.
- Idempotent: επανάληψη ίδιου id+κατάστασης δεν έχει διπλή ενέργεια.
- Σε τελική **μη-παράδοση** → αυτόματη **επιστροφή credits** στο πορτοφόλι του πελάτη (μία φορά).

**Ό,τι χρειαζόμαστε από εσάς, στην ελάχιστη μορφή:**
```json
[ { "message_id": "<ίδιο με §2>", "status": "DELIVERED|UNDELIVERED", "delivered_at": "<ISO8601>" } ]
```

---

## Παράρτημα Β — Τι στέλνουμε σήμερα (για αναφορά)

**OAuth (Identity):**
```
POST https://ids.apifon.com/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<CID>&client_secret=<SECRET>
# ΧΩΡΙΣ scope. → { "access_token": "...", "expires_in": 3600 }
```

**SMS send:**
```
POST https://ars.apifon.com/services/api/v1/sms/send
Authorization: Bearer <token>
Content-Type: application/json; charset=utf-8

{ "message": { "text": "…", "sender_id": "PHARMACY" },
  "subscribers": [ { "number": "306901234567" } ] }
```

**Viber send (IM Gateway):**
```
POST https://ars.apifon.com/services/api/v1/im/send
Authorization: Bearer <token>
Content-Type: application/json; charset=utf-8

{ "subscribers": [ { "number": "306901234567" } ],
  "im_channels": [ { "id": "viber", "text": "…", "sender_id": "PHARMACY" } ] }
```

**Balance:**
```
POST https://ars.apifon.com/services/api/v1/balance
Authorization: Bearer <token>
Content-Type: application/json

{}
```

---

## Σύνοψη αιτημάτων (checklist προς Apifon)

| # | Θέμα | Παραδοτέο από Apifon | Προτεραιότητα |
|---|------|----------------------|:---:|
| 1 | DLR callbacks | Ενεργοποίηση SMS+Viber · ακριβές payload (single+batch) · τρόπος δήλωσης URL · υπογραφή/ασφάλεια · πολιτική retry | ⭐⭐⭐ |
| 2 | Message ID | Ακριβές πεδίο id (single+bulk) που ταιριάζει με το DLR · δείγματα απόκρισης | ⭐⭐⭐ |
| 3 | Viber→SMS fallback | Native υποστήριξη · schema · χρονισμός · τιμολόγηση · διάκριση καναλιού στο DLR | ⭐⭐ |
| 4 | Status polling | Endpoint · παράμετροι · rate limits · retention | ⭐ |
| 5 | Balance/pricing | Επιβεβαίωση balance + μονάδες · endpoint τιμών ανά κανάλι · multipart SMS | ⭐ |
| 6 | Sender IDs | Εγκεκριμένοι SMS/Viber senders · per-message sender | ⭐ |
| 7 | Non-functional | Sandbox · rate limits · encoding · idempotency key | ⭐ |

**Webhook μας για DLR:** `https://app.rxvision.gr/api/v1/communications/apifon-dlr`
**Τεχνική επικοινωνία:** delis.panos@gmail.com
