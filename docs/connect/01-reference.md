# RxVision Connect — Τεχνική αναφορά (τι χτίστηκε)

> Συνοδευτικό του `00-audit-and-design.md`. Εκεί είναι το **γιατί** και οι αποφάσεις· εδώ το
> **τι υπάρχει** στον κώδικα. Ημερομηνία: 2026-09-24.

## Αρχιτεκτονική με μια ματιά

```
frontend/src/app/(app)/connect/page.tsx      ΜΙΑ σελίδα, 6 καρτέλες (URL hash)
        ↓ api()
api/v1/routers/connect.py                    λεπτά endpoints, require("portal:manage", module="connect")
        ↓
repositories/connect.py                      ΟΛΟΙ οι κανόνες — δίκτυο + εμπορικός κύκλος
        ├── services/connect_availability.py  ΕΝΑΣ υπολογισμός διαθεσιμότητας
        ├── services/pharmacy_directory.py    ΕΝΑ σημείο: ΑΦΜ → φαρμακείο + φρουρός εισόδου
        └── repositories/pharmacy_catalog.py  ΥΠΑΡΧΟΝ απόθεμα & ledger — δεν φτιάχτηκε δεύτερο
workers/connect.py                           λήξη κρατήσεων (beat, κάθε 5΄, ουρά fast)
```

## Συλλογές

Όλες **διατενάντ** εκτός από το `connect_policies` (ενδοτενάντ, μέσω `BaseRepository`).

| Collection | Κλειδιά |
|---|---|
| `connect_groups` | `name`, `owner_tenant_id`, `members[]` |
| `connect_invites` | `group_id`, `from/to_tenant_id`, `to_afm`, `status` |
| `connect_policies` | **tenant-scoped**: `global_pct`, `safety_qty`, `per_group{}`, `auto_offer`, `reservation_minutes`, `require_doc_ref` |
| `connect_requests` | `from_tenant_id`, `group_ids[]`, `barcode`, `qty`, `qty_covered`, `urgency`, `status`, `expires_at` |
| `connect_offers` | `request_id`, `from/to_tenant_id`, `qty`, `mode: auto\|manual`, `status` |
| `connect_reservations` | `offer_id`, `tenant_id` (ποιος δεσμεύει), `barcode`, `qty`, `expires_at`, `status` |
| `connect_movements` | `source/dest_tenant_id`, `barcode`, `qty`, `batch`, `expiry`, `doc_ref`, `status` |
| `connect_returns` / `connect_settlements` / `connect_disputes` | πάνω σε `movement_id` |

## Οι κανόνες, όλοι server-side

**Ορατότητα.** `_my_groups()` → `_visible_requests_q()` / `_mine_q()`. Κανένα endpoint δεν
δέχεται «για ποιον»· η ταυτότητα έρχεται από το token. Το `tests/test_connect_flows.py`
επαληθεύει ότι τρίτο φαρμακείο ούτε βλέπει ούτε επεμβαίνει.

**Διαθεσιμότητα.**
`min(ποσοστό ομάδας, καθολικό όριο) × απόθεμα` ∧ `απόθεμα − ασφαλείας` − `ενεργές κρατήσεις`.
Οι κρατήσεις είναι **καθολικές**, όχι ανά ομάδα → δύο δίκτυα δεν ξοδεύουν το ίδιο τεμάχιο.
Άγνωστο απόθεμα → `None`, που σημαίνει «ρώτα τον φαρμακοποιό» (ΟΧΙ μηδέν).

**Αυτόματη απάντηση.** Στη δημιουργία αιτήματος, όποιο μέλος έχει το είδος με απόθεμα και
`auto_offer=true` απαντά μόνο του, μέχρι τη ζητούμενη ποσότητα. Πάντα ανακλητή όσο εκκρεμεί.

**Κράτηση.** Γεννιέται στην **αποδοχή**, όχι στην εμφάνιση. Λήγει μόνη της (προεπιλογή 60΄)
και η ποσότητα επιστρέφει στο αίτημα, που ξανανοίγει.

**Απόθεμα.** Μεταβάλλεται μόνο στο «**Παρέδωσα**»: −qty στην αφετηρία, +qty στον προορισμό,
με εγγραφή στο υπάρχον ledger και των δύο. Όπου το είδος δεν παρακολουθείται, δεν συμβαίνει
τίποτα — δεν γεννιούνται φαντάσματα ειδών.

**Υπόλοιπο.** **Παράγωγο** από τις κινήσεις (θετικό = μου οφείλουν). Δεν υπάρχει αποθηκευμένος
μετρητής: ένας μετρητής που ξεσυγχρονίζεται δημιουργεί διαφωνία μεταξύ δύο φαρμακείων.

**Τακτοποίηση.** Σε είδος (επιστροφή, τριών βημάτων) ή σε αξία (καταγραφή ποσού). Το RxVision
**δεν εκδίδει παραστατικά** και δεν υποθέτει τίποτα για τη φορολογική φύση της πράξης· κρατά
προαιρετικό `doc_ref` και προαιρετική απαίτησή του ανά φαρμακείο.

## Ασφάλεια

- Κάθε endpoint: `require("portal:manage", module="connect")` — ταυτότητα, δικαίωμα, συνδρομή.
- Είσοδος σε δίκτυο μόνο με **ενεργό το module** στον παραλήπτη (`join_block(require_module=True)`).
- Audit: κάθε POST/PUT/DELETE καταγράφεται από το `AuditMiddleware` με `request_id`, actor, IP.
- **Κανένα δεδομένο ασθενή** δεν αγγίζεται· το κύκλωμα είναι φαρμακείο ↔ φαρμακείο ↔ προϊόν.
- Δεν υπάρχει αναζήτηση φαρμακείων — μόνο ταυτοποίηση γνωστού ΑΦΜ.

## Συνδρομή

`addons.connect` = 30 €/μήνα · 300 €/έτος (καθαρές). Opt-in module, αναλογική χρέωση στην
ενεργοποίηση μέσω `billable_gate` + `addon_service`. Προσφέρεται και από τα 4 πακέτα.

## Επόμενα (V2, τεκμηριωμένα ως ΜΗ υλοποιημένα)

Έξυπνο ταίριασμα (απόσταση/ώρες/ιστορικό), γέφυρα δικτύων **με ρητή ανθρώπινη προώθηση**,
λειτουργία έκτακτης ανάγκης, δείκτες αξιοπιστίας συνεργάτη, πρόβλεψη διαθεσιμότητας.
