# Onboarding & Payment Flow — Spec v2 (2026-07-29)

> Στόχος: κανένας λογαριασμός δεν δημιουργείται πριν την **επιβεβαιωμένη πληρωμή** (ή επιλογή
> trial). Τα **credentials (owner login) μπαίνουν ΤΕΛΕΥΤΑΙΑ**. Να σχεδιαστεί πολύ προσεκτικά.

## 1. Τύποι πακέτων
- **Κανονικά (paid) πακέτα** (Essential/Growth/Advanced): ο πελάτης **πληρώνει upfront** → ο
  λογαριασμός ενεργοποιείται **αμέσως** ως `active`. **Καμία δωρεάν δοκιμή.**
- **Trial πακέτο** (ΕΝΑ ειδικό, «e-trial» 14 ημερών): είναι το **ΠΛΗΡΕΣ** πακέτο (όλα μέσα, μεγάλη
  ανάλυση). **Μόνο αυτό είναι δωρεάν** — καμία πληρωμή. Δημιουργείται ως `trialing`.

## 2. Σειρά wizard (ΝΕΑ)
1. **Στοιχεία Πελάτη** (εταιρεία) — + **έλεγχος διπλότυπου ΑΦΜ** (§6).
2. **Πακέτο & Χρήστες**.
3. **Πληρωμή** — παρακάμπτεται αν το πακέτο είναι το trial.
4. **Credentials (owner)** — ξεκλειδώνει **ΜΟΝΟ** μετά από επιβεβαιωμένη πληρωμή (ή trial).

## 3. Ροή ΚΑΡΤΑ (Viva) — για paid πακέτα
1. Αποθηκεύεται **προσωρινή εγγραφή** (`pending_registrations`): εταιρεία + πακέτο + owner name/email
   (ΧΩΡΙΣ κωδικό), status `awaiting_payment`, `expires_at` (π.χ. 2 ώρες).
2. Δημιουργείται **Viva checkout** με `allowRecurring=True` → **αποθηκεύει την κάρτα** (για ανανεώσεις,
   top-ups μηνυμάτων, Copilot, Pharmacat) **ΚΑΙ χρεώνει την 1η περίοδο**. MerchantTrns = `signup:<pending_id>`.
3. webhook «Νέα Πληρωμή» (StatusId F) → pending γίνεται `paid`, κρατάμε `viva_transaction_id`.
4. Ο πελάτης επιστρέφει (redirect) → η σελίδα βλέπει `paid` → προχωρά στο **βήμα credentials** →
   βάζει κωδικό → **δημιουργείται ο λογαριασμός** (tenant + owner + συνδρομή `active`, `card_saved`).
5. Αν **δεν** πληρώσει / εγκαταλείψει → **τίποτα δεν δημιουργείται**· η pending λήγει.

## 4. Ροή ΤΡΑΠΕΖΙΚΗ ΚΑΤΑΘΕΣΗ — για paid πακέτα (με πιστοποίηση)
1. Ο πελάτης καταχωρεί το αίτημα → `pending_registrations` status `awaiting_bank_approval`
   (κανένας λογαριασμός ακόμα). Ο πελάτης βλέπει «αναμονή έγκρισης».
2. Στον **adminpanel** εμφανίζεται pending· ο admin βλέπει τα χρήματα και πατά **«Έγκριση/Πιστοποίηση»**.
3. Με την έγκριση → **email με μοναδικό link** (token) στον πελάτη → τον πάει **κατευθείαν στο βήμα
   credentials** → βάζει κωδικό → **δημιουργείται ο λογαριασμός** (`active`).

## 5. Ροή TRIAL πακέτο
1. Χωρίς πληρωμή → κατευθείαν στο **βήμα credentials** → δημιουργία λογαριασμού (`trialing`, 14 ημ.).
2. Στη **λήξη 14 ημερών**: με το επόμενο login → **pop-up** «διάλεξε πακέτο για να συνεχίσεις»
   (λίστα paid πακέτων). Ο χρήστης πληρώνει → γίνεται `active`.
3. **Το trial ΔΕΝ ξαναεμφανίζεται** ως επιλογή (ούτε στο pop-up ούτε σε νέα εγγραφή με ίδιο ΑΦΜ).

## 6. Έλεγχος διπλότυπου ΑΦΜ (νέο)
- Στο βήμα «Στοιχεία Πελάτη» (μετά το ΑΦΜ) → έλεγχος αν υπάρχει ήδη tenant/συνδρομή με το ίδιο ΑΦΜ.
- Αν **υπάρχει** → μπλοκάρουμε τη συνέχεια + μήνυμα «Υπάρχει ήδη συνδρομή για αυτό το ΑΦΜ» +
  παραπομπή σε: **[Σύνδεση]** · **[Ξέχασα τον κωδικό]** · **[Επανενεργοποίηση συνδρομής]**.
- Public endpoint που επιστρέφει μόνο boolean (χωρίς διαρροή στοιχείων).

## 7. Χρήση αποθηκευμένης κάρτας (card-on-file)
- **Ανανεώσεις**: αυτόματη recurring χρέωση στη λήξη περιόδου (υπάρχουσα `charge_recurring`).
- **Top-ups μηνυμάτων**, **Copilot**, **Pharmacat**: χρέωση στην ίδια αποθηκευμένη κάρτα.

## 8. Καταστάσεις pending_registrations
`awaiting_payment` (κάρτα) · `awaiting_bank_approval` (τράπεζα) · `paid`/`approved` → `completed`
(λογαριασμός δημιουργήθηκε) · `expired` (λήξη χωρίς πληρωμή).

## 9. Επηρεαζόμενα σημεία κώδικα (implementation map)
**Backend:**
- `pending_registrations` collection (νέο) + service.
- `onboarding.py`: `/register-intent` (create pending + Viva checkout / bank pending), `/register-status`
  (poll), `/register-complete` (credentials → materialize), `/check-afm` (§6), bank-approval flow.
- `billing_service.handle_viva_webhook`: αναγνώριση `signup:<id>` → mark pending `paid`.
- `onboarding_service`: split «materialize account from pending» από το «create pending».
- Trial: flag στο πακέτο (`is_trial`), single-use enforcement, login pop-up trigger (expiry).
- Email: bank-approval link (mailer).
- Admin: λίστα «Εκκρεμείς εγγραφές/πληρωμές» + κουμπί Έγκριση.

**Frontend:**
- `register/page.tsx`: αναδιάταξη (credentials τελευταία), branch trial/paid/bank, Viva redirect,
  poll status, resume-from-email-link (deep link στο credentials step με token), ΑΦΜ duplicate UI.
- Login: pop-up επιλογής πακέτου στη λήξη trial.

## 10. Ανοιχτά (να επιβεβαιωθούν στην πορεία)
- Ποιο ακριβώς πακέτο είναι «το trial» (σήμερα υπάρχει `trial | Δωρεάν δοκιμή | seats 2`).
- Ποσό 1ης χρέωσης κάρτας = τιμή περιόδου (μηνιαία/ετήσια) του επιλεγμένου πακέτου.
- Διάρκεια ισχύος pending / bank-approval link.
