# Θωράκιση Cloudflare — 2026-09-05

Συμπλήρωμα του `docs/security-review-2026-09.md`: άμυνες **στην άκρη** (edge), ώστε μη
εξουσιοδοτημένη κίνηση να σταματά **πριν** φτάσει στους servers.

Zone: `rxvision.gr` (ID `18e921c1768166eb9dd6e6efbc2a3199`) · πλάνο **Free**.

> ⚠️ Το API token βλέπει **και τα 27 domains** του λογαριασμού. Αγγίχθηκε **αποκλειστικά** το
> `rxvision.gr`. Σύσταση: περιόρισε το token σε μία zone + βάλε ημερομηνία λήξης.

## ✅ Τι εφαρμόστηκε

| Αλλαγή | Πριν | Μετά | Επαναφορά |
|---|---|---|---|
| `always_use_https` | off | **on** | PATCH `settings/always_use_https` → `off` |
| `min_tls_version` | 1.0 | **1.2** | PATCH `settings/min_tls_version` → `1.0` |
| Custom WAF | κανένας | **3 κανόνες** | Διέγραψε τους κανόνες από το entrypoint ruleset |

### Οι 3 κανόνες (phase `http_request_firewall_custom`)
1. **block** — γνωστά exploit probes: `/.env`, `/.git`, `/wp-admin`, `/wp-login`, `/xmlrpc.php`,
   `/phpmyadmin`, `/.aws`, `/vendor/phpunit`. *(Επαληθεύτηκε: 403 στην άκρη — δεν φτάνουν στον origin.)*
2. **managed_challenge** — `adminpanel.rxvision.gr` από χώρα ≠ GR/CY.
3. **managed_challenge** — `/api/v1/admin/*` από χώρα ≠ GR/CY.

Επιλέχθηκε **challenge** (όχι block) στους γεωγραφικούς ώστε να μη κλειδωθεί ο ιδιοκτήτης όταν
ταξιδεύει — ένας πραγματικός browser περνά, τα αυτοματοποιημένα εργαλεία όχι.

**Επαληθεύτηκε μετά:** `app`/`my` → 200 · exploit probes → 403 · http→https 301 · adminpanel εκτός GR → challenge.

### Σκόπιμα ΔΕΝ έγιναν
- **Κανόνας σε webhook paths** (Viva/Revolut/Apifon): δεν υπάρχουν αξιόπιστες λίστες IP των παρόχων·
  λάθος allowlist = **σπασμένες πληρωμές**. Η προστασία τους έγινε σωστά στον κώδικα (fail-closed + secret).
- **`www` proxied**: δοκιμάστηκε → **421** και **επαναφέρθηκε αμέσως**. Ο origin (185.158.133.1)
  επιστρέφει 421 για `www` **και απευθείας, χωρίς Cloudflare** → ήταν ήδη σπασμένο. Βλ. εκκρεμότητες.

## ⏳ Εκκρεμεί

### 1. Cloudflare Access στο adminpanel ⭐ (τα δικαιώματα υπάρχουν ήδη)
Αυθεντικοποίηση **στο Cloudflare** (email OTP) πριν φορτώσει καν η σελίδα. **Δωρεάν** έως 50 χρήστες.
Δεν ενεργοποιήθηκε γιατί **θέλει τον ιδιοκτήτη μπροστά** για δοκιμή — λάθος ρύθμιση = κλείδωμα έξω
(αναστρέψιμο σε δευτερόλεπτα, αλλά όχι την ημέρα του event).

### 2. SSL `full` → `full (strict)` — θέλει Origin CA cert
**Ο origin σερβίρει ΑΥΤΟ-ΥΠΟΓΕΓΡΑΜΜΕΝΟ πιστοποιητικό** (`Caddy Local Authority`, 12ωρης διάρκειας).
Με `full`, η Cloudflare κρυπτογραφεί προς τον origin αλλά **ΔΕΝ επαληθεύει** το πιστοποιητικό → ένας
man-in-the-middle μεταξύ Cloudflare και Hetzner θα μπορούσε να υποκλέψει την κίνηση (και το
`ORIGIN_AUTH_SECRET`). Απαιτεί θέση στο δίκτυο, αλλά είναι πραγματικό κενό.

**Σωστή λύση:** Cloudflare **Origin CA certificate** (δωρεάν, 15ετές) → εγκατάσταση στον Caddy και
στους 3 app nodes → μετά `ssl = strict`. **ΜΗΝ** αλλάξεις σε `strict` πριν μπει το πιστοποιητικό — θα πέσει το site.

### 3. Hetzner firewall: `:443` μόνο από IP της Cloudflare
Σήμερα τον απευθείας origin τον εμποδίζει **μόνο** ο HTTP origin-guard (`X-Origin-Auth`). Με firewall
σε επίπεδο δικτύου, ο origin γίνεται απρόσιτος εκτός Cloudflare. Το `hetzner_token` υπάρχει ήδη.

### 4. Πλάνο Pro (~€20/μήνα) — προαιρετικό
Ξεκλειδώνει πλήρη WAF managed rules (OWASP) + περισσότερους custom κανόνες + rate-limiting rules.

### 5. (Εκτός ασφάλειας) `www.rxvision.gr` επιστρέφει 421
Ο επισκέπτης που πληκτρολογεί `www.rxvision.gr` βλέπει **σφάλμα**. Το `rxvision.gr` (χωρίς www)
δουλεύει κανονικά. Προϋπάρχον θέμα του marketing site — θέλει διόρθωση στον πάροχο (185.158.133.1).
