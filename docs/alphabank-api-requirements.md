# Τι χρειαζόμαστε από την Alpha Bank — Alpha e-Commerce (κάρτες)

**Ημερομηνία:** 2026-07-08 · **Πλατφόρμα:** RxVision (`app.rxvision.gr`)

Θέλουμε να προσθέσουμε την **Alpha Bank** ως εναλλακτικό τρόπο πληρωμής με κάρτα (παράλληλα
με το Revolut) για αναβαθμίσεις συνδρομής. Η υλοποίηση είναι έτοιμη ως **redirect / hosted
payment page** (Alpha e-Commerce, Nexi/Cardlink). Χρειαζόμαστε τα εξής για ενεργοποίηση:

## 1) Διαπιστευτήρια (τα καταχωρούμε κρυπτογραφημένα)
- **Merchant ID (mid)**
- **Shared secret** για τον υπολογισμό του **digest** (υπογραφή μηνύματος)
- Επιβεβαίωση **test** & **live** merchant IDs

## 2) Endpoints (hosted payment page)
- Ακριβές **gateway URL** για **test** και **live** (η υλοποίησή μας υποθέτει
  `alpha.test.modirum.com/vpos/shophandlermpi` / `www.alphaecommerce.gr/vpos/shophandlermpi` —
  **επιβεβαιώστε**).

## 3) Πεδία αιτήματος & digest ⭐
- Η **ακριβής λίστα & σειρά** των πεδίων του POST (version, mid, orderid, orderDesc, amount,
  currency, payerEmail, trType, confirmUrl, cancelUrl …).
- Ο **ακριβής αλγόριθμος digest**: υποθέτουμε `Base64(SHA-256(concat(τιμές_πεδίων) + shared_secret))`.
  Επιβεβαιώστε αλγόριθμο, σειρά τιμών, και αν περιλαμβάνεται το shared secret στο τέλος.

## 4) Απάντηση (redirect-back) ⭐
- Σε ποιο **URL** και με ποια **μέθοδο** (GET/POST) επιστρέφει ο πάροχος. Το δικό μας:
  `https://app.rxvision.gr/api/v1/subscription/alpha-callback`
- Τα **πεδία της απάντησης** (status/κωδικός αποτελέσματος, orderid, txId, ποσό) + πώς
  υπολογίζεται το **digest επαλήθευσης** ώστε να επιβεβαιώνουμε τη γνησιότητα.
- Ποιες τιμές status σημαίνουν **επιτυχία** (π.χ. CAPTURED/AUTHORIZED).

## 5) Λοιπά
- Υποστήριξη **δόσεων** (installments) — αν/πώς.
- **Test κάρτες** για δοκιμές.
- Νόμισμα/μορφή ποσού (υποθέτουμε EUR, δεκαδικό «12.34»).

> Μόλις λάβουμε τα παραπάνω, ευθυγραμμίζουμε το `backend/app/services/alphabank_service.py`
> (πεδία & digest) και δοκιμάζουμε στο test περιβάλλον. Ο κώδικας είναι ήδη γραμμένος στη
> στάνταρ μορφή Alpha e-Commerce — πιθανότατα χρειάζεται μόνο επιβεβαίωση/μικρο-προσαρμογή.
