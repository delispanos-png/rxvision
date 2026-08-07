# Copilot Ρουτίνες (Scheduled Automations) — Design (μελλοντική έκδοση)

> Στόχος (ιδιοκτήτης, 2026-08): ο Copilot να εκτελεί **επαναλαμβανόμενες, προγραμματισμένες** ενέργειες
> από φυσική γλώσσα. Π.χ. «Κάθε πρωί στις 10:00 στείλε μου report με τον top πελάτη», «Κάθε Δευτέρα
> ετοίμασε πρόταση παραγγελίας», «Στείλε ενημερωτικό στους ασθενείς με ανανέωση αυτή τη βδομάδα».

## Θεμέλια που ήδη υπάρχουν
- **Copilot action framework** (`copilot_service.py`): Level 2 read tools (get_kpis/get_top/…) + Level 3
  `propose_action` (whitelisted `SERVER_ACTIONS`, εκτελούνται ΜΟΝΟ μετά από επιβεβαίωση χρήστη, με RBAC re-check).
- **Celery beat** (`workers/celery_app.py`): πλήθος periodic tasks (reminders, transformations, billing…).
- **Messaging** (Apifon SMS/Viber/email + prepaid wallet + GDPR consent), **order-advisor**, **segments**
  (VIP/at-risk/due-refill/birthday) από Patient Intelligence.

## Πρόταση: υποσύστημα «Ρουτίνες»
1. **Collection `copilot_routines`** (tenant-scoped, extends BaseRepository):
   `{name, schedule, action, params, delivery, auto_run, enabled, created_by, last_run, next_run,
   last_result, tz:"Europe/Athens"}`.
2. **Δημιουργία με φυσική γλώσσα:** νέο tool `propose_routine(name, schedule, action, params, delivery,
   auto_run)` — ο Copilot ΠΑΡΣΑΡΕΙ το αίτημα σε δομημένη ρουτίνα και την **ΠΡΟΤΕΙΝΕΙ** (ο χρήστης βλέπει
   ΑΚΡΙΒΩΣ: πότε · τι · σε ποιους · auto ή approval — και επιβεβαιώνει). Ίδιο pattern με το σημερινό
   `propose_action`, αλλά μόνιμη.
3. **Dispatcher:** νέο beat task (κάθε ~5–15′) → βρίσκει due routines (`next_run <= now`, enabled) →
   εκτελεί → υπολογίζει επόμενο `next_run` → logs + notify.
4. **Οθόνη «Ρουτίνες»:** λίστα, enable/disable, edit, **run-now**, ιστορικό εκτελέσεων.

## Κατάλογος ενεργειών (τι μπορεί να προγραμματιστεί)
- **📊 Reports** (read-only): τρέχει data query (get_top/get_kpis/reimbursement…) → format → delivery
  (in-app καμπανάκι / email). «Πρωινό report». **Ασφαλές → auto-run OK.**
- **✉️ Επικοινωνία**: μήνυμα (SMS/Viber/email) σε **segment** (VIP/at-risk/due-refill/γενέθλια) με template.
  **Απαιτεί: consent (GDPR) + prepaid wallet + preview.**
- **📦 Παραγγελίες**: πρόταση/τοποθέτηση από order-advisor. **Απαιτεί: budget + έγκριση.**
- **⚙️ Λειτουργικά**: sync ΗΔΥΚΑ, υπενθύμιση κλεισίματος μήνα, κ.λπ.

## Ασφάλεια / διακυβέρνηση (ΚΡΙΣΙΜΟ)
- **Δύο βαθμίδες εκτέλεσης:**
  - **Read/report** → τρέχει & παραδίδει αυτόματα (δεν αλλάζει τίποτα).
  - **Outward/mutating** (παραγγελία, μηνύματα σε πελάτες, χρέωση) → ΕΙΤΕ (α) ρητή standing authorization
    στη δημιουργία («auto-run» με σαφές scope), ΕΙΤΕ (β) τρέχει ως **DRAFT/πρόταση** που ο χρήστης εγκρίνει
    κάθε φορά («κάθε πρωί ετοίμασε την παραγγελία και ρώτα με»). Default = **approval**, όχι auto.
- **RBAC:** η ρουτίνα τρέχει με τα δικαιώματα του δημιουργού· δεν κάνει ό,τι δεν επιτρέπεται στον χρήστη.
- **Consent + budgets:** μηνύματα ΜΟΝΟ σε συναινούντες παραλήπτες (GDPR)· wallet/όρια για SMS· budget για παραγγελίες.
- **Audit + kill switch:** κάθε εκτέλεση καταγράφεται· pause/disable ανά πάσα στιγμή· αποτυχία → ειδοποίηση.
- **PII:** στον LLM μόνο ό,τι χρειάζεται (AMKA ποτέ — scrubbed).

## Μοντέλο χρονοπρογραμματισμού
- Presets («κάθε πρωί 10:00», «κάθε Δευτέρα», «1η του μήνα») + optional cron για power users. TZ = Αθήνα.

## Φάσεις υλοποίησης (προτεινόμενη σειρά)
1. **Φάση 1 — Report routines** (read-only → πάγκος/email): χαμηλό ρίσκο, άμεση αξία («πρωινό report»).
   **✅ ΥΛΟΠΟΙΗΘΗΚΕ 2026-08-07 (v1.37.22)** — `copilot_routines.py`, tool `propose_routine`, beat `run_due_routines` (κάθε 10′), οθόνη `/copilot/routines` + inbox. Report = LLM summary με deterministic fallback.
2. **Φάση 2 — Communication routines** (segments): με consent/wallet/preview governance.
   **✅ ΥΛΟΠΟΙΗΘΗΚΕ 2026-08-07 (v1.37.23)** — `action:"message"`· refactor campaign engine σε `comms.run_campaign`· default **draft/approval** (pending_approval run → φαρμακοποιός εγκρίνει/απορρίπτει), **auto** μόνο με `max_recipients` cap· consent+wallet+module gate+kill-switch.
3. **Φάση 3 — Order routines** (propose/auto): με budget/approval governance.

Κάθε φάση = ξεχωριστό, καλά-scoped release. Ξεκινάμε από Φάση 1 όποτε ο ιδιοκτήτης δώσει το ΟΚ.
