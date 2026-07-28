# Apifon API — Ανάλυση Κάλυψης Αναγκών RxVision

**Ημερομηνία:** 2026-07-28 · **Πηγή:** https://docs.apifon.com (Getting Started + API Reference)
**Σχετικό:** [`apifon-api-requirements.md`](apifon-api-requirements.md) (το spec που στείλαμε στην Apifon)

---

## 0. Κρίσιμη διευκρίνιση αρχιτεκτονικής (ΔΙΑΒΑΣΕ ΠΡΩΤΑ)

Το μοντέλο μας είναι **ΕΝΑΣ κεντρικός λογαριασμός Apifon** (της πλατφόρμας), προπληρωμένος από εμάς.
**ΔΕΝ υπάρχει ξεχωριστός λογαριασμός Apifon ανά φαρμακείο.** Κάθε φαρμακείο έχει **πορτοφόλι (wallet)
στο ΔΙΚΟ μας σύστημα** (`message_wallet`, ακέραια cents). Ροή:

```
Φαρμακείο πληρώνει (κάρτα) → πιστώνεται το wallet ΤΟΥ στο RxVision → στέλνει μήνυμα →
χρεώνεται το wallet του → εμείς στέλνουμε μέσω του ΚΕΝΤΡΙΚΟΥ Apifon → Apifon χρεώνει ΕΜΑΣ κεντρικά.
```

**Συνέπεια:** οι περισσότερες «self-service» ανάγκες ζουν στο **ΔΙΚΟ μας σύστημα**, ΟΧΙ στο Apifon API.
Το Apifon API χρειάζεται μόνο για: **αποστολή**, **delivery receipts (DLR)**, **κεντρικό balance/τιμές**,
**sender IDs**. Δεν υπάρχει «υποδομή account ανά φαρμακείο στην Apifon» να διαχειριστούμε — είναι κεντρικό.

---

## 1. Αντιστοίχιση αναγκών → κάλυψη

| # | Ανάγκη (πελάτη/δική μας) | Πού ζει | Apifon API το καλύπτει; | Κατάσταση |
|---|---|---|---|---|
| A | **Top-up μόνος του** (φαρμακείο προσθέτει υπόλοιπο) | **Δικό μας** (κάρτα → wallet) | Άσχετο με Apifon | ⚙️ Δικό μας — υπάρχει βάση (`message_wallet` + top-up order). Θέλει self-service UI. |
| B | **Βλέπει το υπόλοιπό του** | **Δικό μας** (`message_wallet.balance`) | Άσχετο με Apifon | ✅ Υπάρχει |
| C | **Βλέπει ποια μηνύματα παραδόθηκαν** | Δικό μας log **+ Apifon DLR** | **ΝΑΙ, μερικώς** (callbacks) | ⭕ Εξαρτάται από DLR (§2) |
| D | «Διαχείριση όλης της υποδομής του account του στην Apifon» | — | **ΟΧΙ** (δεν υπάρχει per-pharmacy account) | ❌ Δεν εφαρμόζεται — κεντρικό μοντέλο |
| E | **Αποστολή** SMS/Viber | Apifon | ✅ ΝΑΙ | ✅ Λειτουργεί |
| F | **Κεντρικό υπόλοιπο** (πλατφόρμας) | Apifon | ✅ ΝΑΙ (`GET /balance`) | ✅ Λειτουργεί |
| G | **Viber → SMS fallback** | Apifon | ✅ **ΝΑΙ — native** («IM Failover to SMS») | 🟡 Να το ενεργοποιήσουμε |
| H | **Τιμές ανά κανάλι** (auto-sync) | Apifon | ❓ Δεν τεκμηριώνεται | ⭕ Να ρωτηθεί |
| I | **Sender IDs ανά φαρμακείο** | Apifon | ❓ Δεν τεκμηριώνεται (χρειάζεται έγκριση) | ⭕ Να ρωτηθεί |
| J | **Status polling** (εφεδρεία DLR) | Apifon | ❓ Δεν βρέθηκε | ⭕ Να ρωτηθεί |

---

## 2. Τι ΕΠΙΒΕΒΑΙΩΝΕΙ το documentation (νέα ευρήματα)

1. **DLR callback URL** → ρυθμίζεται μέσω πεδίου **`callback_url`** μέσα στα **`campaign_defaults`** μιας
   λίστας/αποστολής (δηλ. **per-request / per-list**, ΟΧΙ μόνο per-account). → Απαντά το §1.2 του spec:
   **μπορούμε να το βάζουμε εμείς σε κάθε αποστολή.**
2. **Native Viber→SMS fallback** υπάρχει ως **«IM Failover to SMS»** στο IM Gateway. → Απαντά το §3 μας:
   **δεν χρειάζεται να το κάνουμε εφαρμογικά** — το κάνει η Apifon.
3. **Callbacks έρχονται από IP `20.56.2.71`** → μπορούμε να κάνουμε **IP allow-listing** στο webhook μας
   (απαντά το §1.6 — μηχανισμός ασφαλείας χωρίς HMAC).
4. **Balance:** `GET /services/api/v1/balance` (επιβεβαιωμένο endpoint· μονάδες πεδίων ΔΕΝ τεκμηριώνονται).
5. **Callbacks:** υπάρχουν ενότητες «SMS Callback Statuses» & «IM Callback Statuses» (οι ακριβείς τιμές
   είναι στο doc αλλά πέρα από το όριο που κατάφερα να διαβάσω — βλ. §4).
6. Endpoints: SMS `POST /services/api/v1/sms`, IM `POST /services/api/v1/im`.

---

## 3. Τι ΔΕΝ κατάφερα να εξαγάγω από το online doc (truncation)

Το `apireference.html` είναι ένα τεράστιο single-page. Το εργαλείο ανάγνωσης το έκοψε πριν τις ενότητες
βάθους. Έμειναν **αδιάβαστα** (αλλά υπαρκτά στο doc) τα εξής — που είναι **ακριβώς** αυτά που ζητά το spec
μας να επιβεβαιώσει η Apifon:

- **Ακριβές schema DLR payload** (SMS & IM) + **πλήρης λίστα status values** (§1.5, §Παράρτημα Α).
- **Πεδίο message-id** στην απόκριση αποστολής & αν **ταιριάζει** με το DLR (§2).
- **Δομή «IM Failover to SMS»** (πώς δηλώνεται, χρέωση, διάκριση καναλιού στο DLR) (§3).
- **Μονάδες Balance Response** (ευρώ/λεπτά/units) (§5.1).
- **Endpoint τιμών ανά κανάλι** (§5.2) — δεν φάνηκε καθόλου.

**Πρόταση:** αυτά είτε τα διαβάζουμε απευθείας στο doc (τα anchors `#im-failover-to-sms`,
`#sms-callback-statuses`, `#im-callback-statuses`, `#balance-response`), είτε τα ζητάμε ρητά — ήδη τα ζητά
το spec μας. Εναλλακτικά, τα **SDK** (Java/PHP/C#/Python/NodeJS) έχουν συγκεκριμένα request/response models.

---

## 4. Συμπέρασμα — τι πράγματι μπορεί να καλύψει το API

- **Αποστολή, κεντρικό balance, Viber→SMS fallback, DLR callbacks (per-request URL):** ✅ **καλύπτονται**.
- **«Παραδόθηκε/δεν παραδόθηκε» ανά μήνυμα (το κρίσιμο για τον πελάτη):** ✅ **εφικτό μέσω DLR** — απομένει
  να κλειδώσουμε το ακριβές payload/status-codes/message-id (τα schemas του §3 εδώ).
- **Top-up / υπόλοιπο / self-service:** ✅ **δικό μας** (κάρτα → wallet) — **δεν χρειάζεται τίποτα από Apifon**.
- **«Διαχείριση account ανά φαρμακείο στην Apifon»:** ❌ **δεν υφίσταται** — το μοντέλο είναι κεντρικός
  λογαριασμός + per-pharmacy wallet στο RxVision. (Το μόνο per-pharmacy Apifon touchpoint = προαιρετικά
  **sender ID** ανά φαρμακείο, που θέλει έγκριση — §I.)
- **Τιμές ανά κανάλι / status polling:** ❓ να επιβεβαιωθούν από Apifon (δεν τεκμηριώνονται online).
