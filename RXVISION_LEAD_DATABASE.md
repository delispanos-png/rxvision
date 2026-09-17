# RxVision — Σχήμα δεδομένων Lead Engine

Συνοδεύει το `RXVISION_LEAD_ENGINE_ARCHITECTURE.md`.
MongoDB — **όλες οι συλλογές είναι platform-level** (καμία δεν έχει `tenant_id` ως φραγμό
απομόνωσης· ο έλεγχος γίνεται στο επίπεδο του platform admin).

---

## 0. Αρχή: μη διπλασιάζεις αλήθεια

Κάθε πεδίο που υπάρχει ήδη σε `tenants` / `subscriptions` / `users` **δεν αντιγράφεται ως
πηγή**. Όπου αποθηκεύεται, είναι σαφώς σημειωμένο ως **[cache]**: γράφεται από την ωριαία
προβολή, ξαναγράφεται ολόκληρο, και κανείς δεν το επεξεργάζεται με το χέρι.

Αν ένα cache πεδίο διαφωνεί με την πηγή, **η πηγή έχει δίκιο**.

---

## 1. `leads` — επέκταση της σημερινής `trial_leads`

Δεν δημιουργείται νέα συλλογή. Η `trial_leads` **μετονομάζεται σε `leads`** με αντιγραφή
(οι 6 υπάρχουσες εγγραφές κρατούν το `_id` τους) και η παλιά μένει ως `trial_leads_backup`
μέχρι να επιβεβαιωθεί.

```js
{
  _id: "800778958",              // lead_key: ΑΦΜ → email → "tid:<tenant_id>"
  source: "trial_purged",        // trial | signup_abandoned | announcement_request | churn | manual

  // ── ταυτότητα (υπάρχοντα πεδία trial_leads, αμετάβλητα) ──
  afm, email, phone, contact_name, pharmacy_name, country,
  original_tenant_id, purged_at, reason,

  // ── σύνδεση με ζωντανό λογαριασμό (ΝΕΟ — γι' αυτό λείπουν σήμερα τα 5) ──
  tenant_id: "pharmacy-45fd0a" | null,

  // ── κύκλος ζωής ──
  stage: "trial_expired",        // [cache] αυτόματο
  status: "new",                 // χειροκίνητο
  status_reason: null,
  assigned_to: null,             // platform_admins._id
  tags: ["NEEDS_CALL"],

  // ── [cache] δοκιμαστική ──
  trial: { started_at, ends_at, duration_days, days_left, days_since_expiry, bucket: "8_30" },

  // ── [cache] δραστηριότητα ──
  activity: {
    last_login_at, last_action_at, days_since_activity,
    actions_30d: 6, actions_total: 6, active_days_30d: 2,
    features: ["reimbursement", "hdika_connected"],
    data_connected: true, returned_after_days: 6
  },

  // ── [cache] σκορ ──
  score: { value: 62, band: "engaged", computed_at, signals: [ {key, points, why}, … ] },

  // ── επικοινωνία & προσφορές (σύνοψη· η αλήθεια στα lead_communications/lead_offers) ──
  comms:  { last_sent_at, sent_30d: 1, opened_total: 1, clicked_total: 0, last_opened_at },
  offers: { last_sent_at, open_offers: 1, redeemed_total: 0 },

  // ── επόμενη ενέργεια (σύνοψη της ανοιχτής lead_tasks) ──
  next_action: { task_id, action: "call", due_at, priority: "high", assigned_to },

  // ── συγκατάθεση / αποκλεισμός ──
  consent: { marketing: true, source: "trial_signup", at, channels: {email:true, sms:false} },
  unsubscribed_at: null,
  suppressed: false, suppress_reason: null,

  // ── μετατροπή ──
  conversion: null,              // βλ. §9

  trial_allowed: false,          // ΥΠΑΡΧΟΝ — μπλοκ επανα-trial. ΔΕΝ αλλάζει σημασία.
  created_at, updated_at
}
```

**Δείκτες:** `stage`, `status`, `score.value` (φθίνων), `assigned_to`,
`next_action.due_at`, `tenant_id` (αραιός), `afm`, `email`,
`{stage:1, status:1, "score.value":-1}` για τον κύριο πίνακα.

---

## 2. `lead_events` — το χρονολόγιο

```js
{ _id, lead_key, kind: "email.opened", at, by: "pdelis@cloudon.gr" | "system",
  title: "Άνοιξε το email «Η δοκιμή σου τελείωσε»",
  data: { campaign_id, … },
  ref: { kind: "campaign", id } }
```

**Δείκτες:** `{lead_key:1, at:-1}`, `{kind:1, at:-1}`.
**Διατήρηση:** κανένα TTL. Το χρονολόγιο είναι το προϊόν· χάνοντάς το χάνεις τον λόγο ύπαρξης
του συστήματος. Η διαγραφή γίνεται μόνο μαζί με τον lead (αίτημα διαγραφής, §11).

---

## 3. `lead_status_history`

```js
{ _id, lead_key, from: "contacted", to: "offer_sent", by, at, reason }
```
Ξεχωριστά από τα events γιατί απαντά διαφορετική ερώτηση: «ποιος άλλαξε τι και γιατί» —
είναι εγγραφή λογοδοσίας, όχι αφήγηση.

---

## 4. `lead_notes`

```js
{ _id, lead_key, kind: "call" | "meeting" | "demo" | "objection" | "note",
  body: "Θέλει πρώτα να δει το Loyalty.", by, at, pinned: false }
```
Κάθε σημείωση γράφει και ένα `lead.note` event ώστε να φαίνεται στο χρονολόγιο.

---

## 5. `lead_tasks`

```js
{ _id, lead_key, action: "call" | "email" | "demo" | "offer" | "followup",
  title, due_at, priority: "high"|"normal"|"low",
  assigned_to, status: "open"|"done"|"cancelled",
  created_by, created_at, done_at, done_note }
```
**Δείκτες:** `{status:1, due_at:1}` (τροφοδοτεί το «Σήμερα»), `{assigned_to:1, status:1}`.

---

## 6. `lead_segments` — αποθηκευμένοι κανόνες

```js
{ _id, name: "Υψηλή δραστηριότητα, έληξε η δοκιμή",
  rules: { match: "all", conditions: [
    {field: "stage",       op: "is",  value: "trial_expired"},
    {field: "score.value", op: "gte", value: 70},
    {field: "status",      op: "not_in", value: ["won","do_not_contact","lost"]}
  ]},
  builtin: false, created_by, created_at, updated_at }
```

Ίδιο σχήμα κανόνων με το `services/audience.py` των ασθενών (`match` + `conditions`),
**σκόπιμα** — ένας τρόπος να γράφεις κανόνες σε όλο το προϊόν.
Μαζί του έρχεται και το μάθημα από εκεί: **άγνωστο πεδίο ή κενοί κανόνες = σφάλμα, ποτέ
«όλοι»** (17/09: κανόνες λάθος σχήματος άνοιγαν σιωπηλά όλο το πελατολόγιο).

---

## 7. `lead_campaigns` + `lead_recipients` + `lead_comm_events` *(Φάση 2)*

```js
// lead_campaigns
{ _id, name, channel: "email", subject, preheader, body_html, template_key,
  audience: { segment_id } | { rules },
  offer_id, purpose: "marketing" | "transactional",
  status: "draft"|"queued"|"sending"|"paused"|"completed"|"cancelled",
  scheduled_at, stats: {recipients, sent, failed, opened, clicked, converted},
  created_by, approved_by, created_at }

// lead_recipients  —  ΜΟΝΑΔΙΚΟ ΚΛΕΙΔΙ = η ιδεμποτεντότητα
{ _id, key: "<campaign_id>|<lead_key>",      // unique index
  campaign_id, lead_key, email,
  status: "pending"|"sending"|"sent"|"failed"|"skipped",
  skip_reason: "no_consent"|"unsubscribed"|"frequency_cap"|"no_email"|"suppressed",
  attempts: 0, sent_at, opened_at, clicked_at, error }

// lead_comm_events  — ανοίγματα/κλικ
{ _id, campaign_id, lead_key, kind: "open"|"click", at, url, ua_hash }
```

Το `key` με μοναδικό δείκτη είναι η **ίδια** λύση που απέτρεψε τη διπλή αποστολή στις
καμπάνιες ασθενών. Είναι αποδεδειγμένη εδώ μέσα, όχι θεωρία.

---

## 8. `platform_offers` + `coupons` (v2) + `coupon_redemptions` *(Φάση 3)*

```js
// platform_offers — ΓΕΝΙΚΟ μοντέλο, χωρίς hardcoded τύπους στη λογική
{ _id, name: "Επιστροφή Σεπτεμβρίου −20%", description,
  type: "percent" | "fixed" | "free_period" | "extended_trial",
  value: 20,                   // % | cents | μήνες | ημέρες — κατά τύπο
  currency: "EUR",
  applies_to: { plans: [], cycles: ["monthly","yearly"], min_months: null },
  eligibility: { new_customers_only: false, returning_only: true, segment_id },
  valid_from, valid_to, active: true, created_by, created_at }
```

Νέος τύπος προσφοράς = **μία νέα τιμή `type` + μία συνάρτηση εφαρμογής**. Καμία αλλαγή στο
σχήμα, στη στόχευση, στην αποστολή ή στο UI.

```js
// coupons — ΕΠΕΚΤΑΣΗ της υπάρχουσας (σήμερα: _id, tenant_id, discount_pct, used)
{ _id: "RXV-8F3K2A",           // ο κωδικός· ΥΠΑΡΧΟΝ
  offer_id, name, description,
  discount_type: "percent",     // ΝΕΟ (τα παλιά = percent)
  discount_value: 20,           // ΝΕΟ (= παλιό discount_pct)
  discount_pct: 20,             // ΔΙΑΤΗΡΕΙΤΑΙ για συμβατότητα με feedback_service
  tenant_id: null,              // ΥΠΑΡΧΟΝ· null = δεν είναι δεμένο σε φαρμακείο
  lead_key: "800778958",        // ΝΕΟ
  plans: [], cycles: [],
  valid_from, valid_to,
  max_redemptions: 1, max_per_pharmacy: 1, redeemed: 0,
  active: true, used: false }   // `used` ΔΙΑΤΗΡΕΙΤΑΙ
```

⚠️ **Συμβατότητα:** το `feedback_service.validate_coupon/apply_discount/redeem_coupon` και
το `billing_service.renew_now` διαβάζουν `discount_pct` και `used`. Και τα δύο **μένουν**.
Το υπάρχον κουπόνι στην παραγωγή (1 εγγραφή) δεν θίγεται.

```js
// coupon_redemptions — γιατί το `used: bool` δεν αρκεί για πολλαπλές χρήσεις
{ _id, code, lead_key, tenant_id, at, amount_before, amount_after, invoice_id }
```

---

## 9. Μετατροπή & απόδοση

Μέσα στο `leads.conversion`:

```js
{ at, tenant_id, plan, cycle, amount_cents,
  attribution: {
    model: "last_touch",
    campaign_id, offer_id, coupon_code, channel: "email",
    salesperson: "pdelis@cloudon.gr",
    touches: [ {kind:"email.opened", campaign_id, at}, {kind:"offer.sent", at}, … ]
  } }
```

Η `touches` γεμίζει **από την αρχή** (όλες οι επαφές 90 ημερών πριν τη μετατροπή), ακόμη κι
αν το `model` είναι `last_touch`. Έτσι το πέρασμα σε first-touch ή multi-touch αύριο είναι
αλλαγή υπολογισμού — **όχι χαμένα δεδομένα**.

---

## 10. Αυτοματισμοί *(Φάση 4)*

```js
// lead_journeys
{ _id, name, active: false,
  trigger: { kind: "stage_entered", value: "trial_expired" },
  entry_rules: { match:"all", conditions:[…] },
  steps: [
    { id: "s1", kind: "wait",     days: 2 },
    { id: "s2", kind: "send",     campaign_template: "trial_expired", offer_id: null },
    { id: "s3", kind: "wait",     days: 5 },
    { id: "s4", kind: "branch",   condition: {field:"comms.opened_total", op:"gte", value:1},
                                  then: "s5", otherwise: "s6" },
    { id: "s5", kind: "task",     action: "call", priority: "high" },
    { id: "s6", kind: "send",     campaign_template: "reengagement" }
  ],
  caps: { max_per_day: 50 } }

// lead_journey_runs  —  ΜΟΝΑΔΙΚΟ {journey_id, lead_key}: κανείς δεν μπαίνει δύο φορές
{ _id, journey_id, lead_key, step_id, status:"running"|"done"|"stopped",
  next_at, entered_at, stopped_reason }
```

Το σχήμα `trigger → entry_rules → steps[wait|send|task|tag|branch]` είναι ακριβώς αυτό που
χρειάζεται ένας οπτικός κατασκευαστής αργότερα. **Δεν φτιάχνουμε τον κατασκευαστή τώρα** —
φτιάχνουμε το μοντέλο που τον επιτρέπει.

---

## 11. Διατήρηση & διαγραφή

| Συλλογή | Διατήρηση |
|---|---|
| `leads` | όσο υπάρχει σχέση· ρύθμιση `lead_retention_months` (24) για leads χωρίς καμία επαφή |
| `lead_events`, `lead_status_history` | όσο ζει ο lead |
| `lead_recipients` | 24 μήνες (αρκεί για απόδοση & συχνότητα) |
| `lead_comm_events` | 24 μήνες |
| `coupon_redemptions` | μόνιμα (λογιστική) |

Αίτημα διαγραφής φαρμακείου → σβήνονται lead + events + notes + tasks + recipients.
**Εξαίρεση:** μένει μία γραμμή αποκλεισμού `{afm_hash, unsubscribed_at, do_not_contact}`,
γιατί για να μην του ξαναστείλουμε πρέπει να θυμόμαστε ότι δεν θέλει. Το ΑΦΜ αποθηκεύεται
**κατακερματισμένο**, ώστε η εγγραφή να μην είναι πια στοιχείο επικοινωνίας.

---

## 12. Μεταναστεύσεις — όλες αναστρέψιμες

| # | Ενέργεια | Ασφάλεια |
|---|---|---|
| M1 | `trial_leads` → `leads` (αντιγραφή, ίδια `_id`) | η παλιά μένει ως `trial_leads_backup` |
| M2 | νέοι δείκτες `leads`, `lead_events`, `lead_tasks` | προσθετικοί |
| M3 | 1η πλήρης προβολή | γράφει μόνο `stage/trial/activity/score` |
| M4 | `coupons`: +`discount_type`, `discount_value` | **δεν** αφαιρείται το `discount_pct` |
| M5 | `audit_logs` index `{tenant_id:1, at:-1}` | **υπάρχει ήδη** |

Καμία μετανάστευση δεν διαγράφει, δεν μετονομάζει και δεν ξαναγράφει υπάρχον πεδίο.
Κανένα `update_many({})` με κενό φίλτρο — μάθημα από 17/09.
