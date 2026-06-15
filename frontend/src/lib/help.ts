// Contextual help per circuit (page). Shown by the floating "?" button (PageHelp) and
// mirrored in docs/USER_MANUAL.md. Keep entries short, practical and in Greek.

export type Help = {
  title: string;
  title_en?: string;
  intro: string;
  intro_en?: string;
  what: { label: string; desc: string; label_en?: string; desc_en?: string }[];
  tips?: string[];
  tips_en?: string[];
};

export const HELP: Record<string, Help> = {
  "/dashboard": {
    title: "Πίνακας Ελέγχου",
    title_en: "Dashboard",
    intro: "Η συνολική εικόνα του φαρμακείου για την επιλεγμένη περίοδο — τζίρος, συνταγές, ασθενείς και τάσεις με μια ματιά.",
    intro_en: "The overall view of the pharmacy for the selected period — turnover, prescriptions, patients and trends at a glance.",
    what: [
      { label: "Κάρτες KPI", desc: "Σύνολα περιόδου (αξία, συνταγές, ασθενείς…). Κάνε κλικ σε μια κάρτα για αναλυτική λίστα.", label_en: "KPI cards", desc_en: "Period totals (value, prescriptions, patients…). Click a card for a detailed list." },
      { label: "Γράφημα τάσης", desc: "Δύο γραμμές — Αξία (κόκκινο) & Αιτούμενα (πράσινο) ανά ημερομηνία (DD/MM).", label_en: "Trend chart", desc_en: "Two lines — Value (red) & Claimed (green) by date (DD/MM)." },
      { label: "Φίλτρο περιόδου", desc: "Πάνω δεξιά — επηρεάζει ΟΛΑ τα νούμερα της σελίδας.", label_en: "Period filter", desc_en: "Top right — affects ALL numbers on the page." },
    ],
    tips: ["Άλλαξε την περίοδο για σύγκριση μηνών/ετών.", "Όλα τα KPI είναι clickable → σε πάνε στη λεπτομέρεια."],
    tips_en: ["Change the period to compare months/years.", "All KPIs are clickable → they take you to the detail."],
  },
  "/prescriptions": {
    title: "Συνταγές",
    title_en: "Prescriptions",
    intro: "Όλες οι εκτελέσεις συνταγών με ανάλυση ανά ταμείο, κατάσταση και αξία.",
    intro_en: "All prescription executions with breakdown by insurance fund, status and value.",
    what: [
      { label: "Λίστα εκτελέσεων", desc: "Ταξινόμηση (πιάνει ΟΛΕΣ τις σελίδες) + φίλτρα. Κουμπί αντιγραφής δίπλα στο ΑΜΚΑ.", label_en: "Executions list", desc_en: "Sorting (applies to ALL pages) + filters. Copy button next to the ΑΜΚΑ." },
      { label: "KPIs ανά ταμείο", desc: "Σύνολα περιόδου ανά ταμείο/κατάσταση — κλικ για λίστα.", label_en: "KPIs by fund", desc_en: "Period totals by insurance fund/status — click for a list." },
      { label: "Ανεκτέλεστες δραστικές", desc: "Χαμένη αξία από φάρμακα που δεν εκτελέστηκαν.", label_en: "Unexecuted substances", desc_en: "Lost value from medicines that were not executed." },
      { label: "Λεπτομέρεια συνταγής", desc: "Κλικ σε γραμμή → πλήρη στοιχεία + δέντρο επαναλήψεων (✅ εκτελεσμένες / ❌ χαμένες / 🔜 μελλοντικές) + μερικές εκτελέσεις.", label_en: "Prescription detail", desc_en: "Click a row → full details + repeats tree (✅ executed / ❌ missed / 🔜 upcoming) + partial executions." },
      { label: "Εξαγωγή", desc: "CSV / XLSX / PDF με επαγγελματική μορφοποίηση.", label_en: "Export", desc_en: "CSV / XLSX / PDF with professional formatting." },
    ],
    tips: ["Στη λεπτομέρεια μιας επαναλαμβανόμενης συνταγής βλέπεις όλη την αλυσίδα των μηνιαίων επαναλήψεων."],
    tips_en: ["In the detail of a recurring prescription you see the whole chain of monthly repeats."],
  },
  "/doctors": {
    title: "Ιατροί",
    title_en: "Doctors",
    intro: "Ανάλυση συνταγογράφησης ανά γιατρό και ειδικότητα.",
    intro_en: "Prescribing analysis by doctor and specialty.",
    what: [
      { label: "Top ιατροί", desc: "Ποιοι γιατροί φέρνουν τις περισσότερες συνταγές/αξία.", label_en: "Top doctors", desc_en: "Which doctors bring the most prescriptions/value." },
      { label: "Ανά ειδικότητα", desc: "Drill-down: συνταγές ανά ειδικότητα → ανά γιατρό.", label_en: "By specialty", desc_en: "Drill-down: prescriptions by specialty → by doctor." },
    ],
    tips: ["Κλικ σε γιατρό/ειδικότητα για αναλυτικά."],
    tips_en: ["Click a doctor/specialty for details."],
  },
  "/patients": {
    title: "Ασφαλισμένοι",
    title_en: "Patients",
    intro: "Οι ασθενείς σου, με αναζήτηση και στοιχεία επικοινωνίας.",
    intro_en: "Your patients, with search and contact details.",
    what: [
      { label: "Αναζήτηση", desc: "Με ΑΜΚΑ, όνομα, επώνυμο, τηλέφωνο ή email.", label_en: "Search", desc_en: "By ΑΜΚΑ, first name, surname, phone or email." },
      { label: "Καρτέλα ασθενή", desc: "Ιστορικό, φάρμακα, αξία — και στοιχεία επικοινωνίας (τηλ/email/διεύθυνση).", label_en: "Patient card", desc_en: "History, medicines, value — and contact details (phone/email/address)." },
      { label: "Γραφήματα", desc: "Κλειστά by default — ανοίγουν με κλικ για περισσότερη οθόνη.", label_en: "Charts", desc_en: "Collapsed by default — expand with a click for more screen space." },
    ],
    tips: ["Τα στοιχεία επικοινωνίας αποθηκεύονται ξεχωριστά — ΔΕΝ χάνονται σε συγχρονισμό ΗΔΥΚΑ."],
    tips_en: ["Contact details are stored separately — they are NOT lost on a ΗΔΥΚΑ sync."],
  },
  "/icd10": {
    title: "ICD-10 (Διαγνώσεις)",
    title_en: "ICD-10 (Diagnoses)",
    intro: "Ανάλυση ανά διάγνωση (ICD-10): ποιες παθήσεις, πόσες συνταγές, τι αξία.",
    intro_en: "Analysis by diagnosis (ICD-10): which conditions, how many prescriptions, what value.",
    what: [
      { label: "Top διαγνώσεις", desc: "Με τα ονόματά τους (όχι μόνο κωδικοί).", label_en: "Top diagnoses", desc_en: "With their names (not just codes)." },
      { label: "Drill-down", desc: "Κλικ σε διάγνωση → σχετικές συνταγές/φάρμακα.", label_en: "Drill-down", desc_en: "Click a diagnosis → related prescriptions/medicines." },
    ],
  },
  "/profitability": {
    title: "Κερδοφορία",
    title_en: "Profitability",
    intro: "Μικτό κέρδος και περιθώρια ανά διάσταση.",
    intro_en: "Gross profit and margins by dimension.",
    what: [
      { label: "Κέρδος", desc: "Λιανική − χονδρική κόστος. Όλα σε ευρώ/cents.", label_en: "Profit", desc_en: "Retail − wholesale cost. Everything in euros/cents." },
      { label: "Διαστάσεις", desc: "Ανά φάρμακο, κατηγορία ή ταμείο — με φίλτρο περιόδου.", label_en: "Dimensions", desc_en: "By medicine, category or insurance fund — with period filter." },
    ],
  },
  "/future": {
    title: "Μελλοντικές",
    title_en: "Upcoming",
    intro: "Επερχόμενες επαναλήψεις/ανανεώσεις — ποιοι ασθενείς αναμένονται και πότε.",
    intro_en: "Upcoming repeats/renewals — which patients are expected and when.",
    what: [
      { label: "Λίστα", desc: "Αναμενόμενη ημερομηνία, ασθενής, φάρμακα.", label_en: "List", desc_en: "Expected date, patient, medicines." },
      { label: "KPIs", desc: "Κλικ → pop-up με λίστα.", label_en: "KPIs", desc_en: "Click → pop-up with a list." },
    ],
    tips: ["Χρήσιμο για να προετοιμάζεις απόθεμα και να θυμίζεις στους ασθενείς."],
    tips_en: ["Useful for preparing stock and reminding patients."],
  },
  "/orders": {
    title: "Παραγγελίες",
    title_en: "Orders",
    intro: "Προτάσεις παραγγελίας βάσει κατανάλωσης και επερχόμενων αναγκών.",
    intro_en: "Order suggestions based on consumption and upcoming needs.",
    what: [
      { label: "Πρόταση", desc: "Σκεύασμα, προμηθευτής, ποσότητα, εκτιμώμενο κόστος.", label_en: "Suggestion", desc_en: "Product, supplier, quantity, estimated cost." },
    ],
  },
  "/communications": {
    title: "Επικοινωνία",
    title_en: "Communications",
    intro: "Newsletter και μηνύματα προς τους ασθενείς (email/SMS).",
    intro_en: "Newsletter and messages to patients (email/SMS).",
    what: [
      { label: "Στόχευση κοινού", desc: "Έξυπνα segments (επερχόμενες, ανενεργοί, ανά πάθηση/δραστική…).", label_en: "Audience targeting", desc_en: "Smart segments (upcoming, inactive, by condition/active substance…)." },
      { label: "Templates", desc: "Έτοιμα πρότυπα email/SMS με μεταβλητές ({name} κ.λπ.).", label_en: "Templates", desc_en: "Ready-made email/SMS templates with variables ({name} etc.)." },
      { label: "Ιστορικό", desc: "Τι στάλθηκε, πότε, σε ποιους.", label_en: "History", desc_en: "What was sent, when, to whom." },
    ],
    tips: ["Ρύθμισε το δικό σου email/SMS account στις Ρυθμίσεις → Επικοινωνία.", "Στέλνε μόνο σε όσους έχουν δώσει συγκατάθεση (GDPR)."],
    tips_en: ["Set up your own email/SMS account in Settings → Communications.", "Send only to those who have given consent (GDPR)."],
  },
  "/closing": {
    title: "Κλείσιμο μήνα",
    title_en: "Month closing",
    intro: "Συγκεντρωτικά στοιχεία μήνα για κλείσιμο και συμφωνία.",
    intro_en: "Aggregated monthly figures for closing and reconciliation.",
    what: [{ label: "Σύνολα", desc: "Ανά ταμείο/κατάσταση για τον μήνα.", label_en: "Totals", desc_en: "By insurance fund/status for the month." }],
  },
  "/pharmacyone": {
    title: "PharmacyOne",
    title_en: "PharmacyOne",
    intro: "Διασύνδεση με το PharmacyOne (μόνο ανάγνωση).",
    intro_en: "Integration with PharmacyOne (read-only).",
    what: [{ label: "Δεδομένα", desc: "Επαλήθευση/σύγκριση χωρίς αλλαγές στο PharmacyOne.", label_en: "Data", desc_en: "Verification/comparison without changes to PharmacyOne." }],
  },
  "/advisor": {
    title: "Σύμβουλος Επιχείρησης",
    title_en: "Business Advisor",
    intro: "Βαθιά AI ανάλυση: κατηγορίες, παράλληλες πωλήσεις, ευκαιρίες και στοχευμένες προτάσεις.",
    intro_en: "Deep AI analysis: categories, cross-sells, opportunities and targeted suggestions.",
    what: [
      { label: "Insights", desc: "Τι πάει καλά, τι όχι, πού υπάρχει ευκαιρία.", label_en: "Insights", desc_en: "What is going well, what is not, where there is opportunity." },
      { label: "Cross-sell κάρτες", desc: "Κλικ → λίστα ασθενών + στοιχεία επικοινωνίας + δημιουργία καμπάνιας.", label_en: "Cross-sell cards", desc_en: "Click → patient list + contact details + campaign creation." },
    ],
  },
  "/order-advisor": {
    title: "Σύμβουλος Παραγγελίας",
    title_en: "Order Advisor",
    intro: "Έξυπνες προτάσεις παραγγελίας με βάθος (κατανάλωση, τάσεις, επερχόμενες ανάγκες).",
    intro_en: "Smart, in-depth order suggestions (consumption, trends, upcoming needs).",
    what: [{ label: "Προτάσεις", desc: "Τι, πόσο και πότε να παραγγείλεις.", label_en: "Suggestions", desc_en: "What, how much and when to order." }],
  },
  "/nutrition": {
    title: "Σύμβουλος Διατροφής",
    title_en: "Nutrition Advisor",
    intro: "Εξατομικευμένο διατροφικό πλάνο ανά ασθενή, με βάση τα φάρμακα/δραστικές που λαμβάνει.",
    intro_en: "Personalized nutrition plan per patient, based on the medicines/active substances they take.",
    what: [
      { label: "Αναζήτηση ασθενή", desc: "Με ΑΜΚΑ/όνομα/τηλέφωνο.", label_en: "Patient search", desc_en: "By ΑΜΚΑ/name/phone." },
      { label: "Πλάνο", desc: "Προτάσεις (✅ τρόφιμα / ⛔ αποφυγή / 💡 συμβουλές) → email ή εκτύπωση.", label_en: "Plan", desc_en: "Suggestions (✅ foods / ⛔ avoid / 💡 tips) → email or print." },
    ],
  },
  "/settings": {
    title: "Ρυθμίσεις",
    title_en: "Settings",
    intro: "Χρήστες & ρόλοι, διασύνδεση ΗΔΥΚΑ, επικοινωνία και συγχρονισμός.",
    intro_en: "Users & roles, ΗΔΥΚΑ integration, communications and sync.",
    what: [
      { label: "Συγχρονισμός (Ingestion)", desc: "Άντληση από ΗΔΥΚΑ + ιστορικό συγχρονισμών + πρόοδος (περίοδος/cursor).", label_en: "Sync (Ingestion)", desc_en: "Fetching from ΗΔΥΚΑ + sync history + progress (period/cursor)." },
      { label: "Χρήστες/Ρόλοι", desc: "Ποιος βλέπει τι.", label_en: "Users/Roles", desc_en: "Who sees what." },
      { label: "Επικοινωνία", desc: "SMTP (email) & SMS (Apifon) του φαρμακείου.", label_en: "Communications", desc_en: "The pharmacy's SMTP (email) & SMS (Apifon)." },
    ],
  },
  "/account": {
    title: "Λογαριασμός",
    title_en: "Account",
    intro: "Τα στοιχεία και οι προτιμήσεις του λογαριασμού σου (θέμα, γλώσσα).",
    intro_en: "Your account details and preferences (theme, language).",
    what: [{ label: "Προτιμήσεις", desc: "Dark mode, γλώσσα (Ελληνικά/English), σύμπτυξη μενού.", label_en: "Preferences", desc_en: "Dark mode, language (Ελληνικά/English), menu collapse." }],
  },
};

export function helpFor(pathname: string): Help | null {
  const keys = Object.keys(HELP).sort((a, b) => b.length - a.length);
  const k = keys.find((key) => pathname === key || pathname.startsWith(key + "/"));
  return k ? HELP[k] : null;
}
