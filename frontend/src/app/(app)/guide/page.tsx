"use client";

import { useState } from "react";
import { BookOpen, Search, ChevronDown } from "lucide-react";
import { useT } from "@/store/prefStore";

type Item = { kpi: string; what: string; how: string };
type Group = { title: string; emoji: string; items: Item[] };

// Κεντρικός κατάλογος: τι δείχνει & ΠΩΣ υπολογίζεται κάθε δείκτης. Πηγή αλήθειας για τα ⓘ tooltips.
const GROUPS: Group[] = [
  {
    title: "Πίνακας Ελέγχου", emoji: "📊", items: [
      { kpi: "Συνταγές (πλήθος)", what: "Πόσες εκτελέσεις συνταγών έγιναν στην επιλεγμένη περίοδο.", how: "Μέτρηση εγγραφών prescription_executions με executed_at εντός της περιόδου του φίλτρου." },
      { kpi: "Τζίρος / Αξία", what: "Συνολική λιανική αξία των εκτελεσμένων συνταγών.", how: "Άθροισμα λιανική αξία (σε λεπτά) όλων των εκτελέσεων της περιόδου." },
      { kpi: "Συμμετοχή patient_ref", what: "Πόσα πλήρωσαν οι ασθενείς από την τσέπη τους.", how: "Άθροισμα συμμετοχή ασθενή όλων των εκτελέσεων." },
      { kpi: "Κάλυψη ταμείων", what: "Πόσα κάλυψαν τα ασφαλιστικά ταμεία.", how: "Αξία − Συμμετοχή ασθενή (amount_total − patient_share)." },
      { kpi: "Δ% vs πέρσι", what: "Μεταβολή σε σχέση με την ίδια περίοδο πέρυσι.", how: "(φετινό − περσινό) / περσινό × 100, για την ίδια ημερολογιακή περίοδο." },
    ],
  },
  {
    title: "Ασφαλισμένοι / Patient Intelligence", emoji: "👥", items: [
      { kpi: "Συνέπεια (compliance)", what: "Πόσο συνεπείς είναι οι χρόνιοι ασθενείς στις επαναλαμβανόμενες συνταγές.", how: "Για κάθε αλυσίδα επανάληψης μετράμε τα μηνιαία «παράθυρα» που έπρεπε να εκτελεστούν έως σήμερα και πόσα όντως εκτελέστηκαν: εκτελέστηκαν / αναμενόμενα × 100." },
      { kpi: "VIP / LTV", what: "Οι πιο πολύτιμοι πελάτες με βάση τη συνολική τους αξία.", how: "Κατάταξη ασθενών κατά συνολική λιανική αξία (rx_value_total)· τα top ποσοστά → VIP tiers." },
      { kpi: "Σε κίνδυνο / Win-back", what: "Πελάτες που έχουν αρχίσει να χάνονται.", how: "Ασθενείς με κενό (gap) από την τελευταία εκτέλεση πέρα από το αναμενόμενο διάστημα της αγωγής τους." },
      { kpi: "Χαμένες ανανεώσεις", what: "Επαναλαμβανόμενες συνταγές που δεν εκτελέστηκαν στο παράθυρό τους.", how: "Παράθυρα επανάληψης που έκλεισαν χωρίς εκτέλεση (missed) — με την ανακτήσιμη αξία τους." },
    ],
  },
  {
    title: "Ιατροί", emoji: "🩺", items: [
      { kpi: "Συνταγογράφηση ανά ιατρό", what: "Όγκος & αξία συνταγών ανά παραπέμποντα ιατρό.", how: "Ομαδοποίηση εκτελέσεων κατά doctor_id· πλήθος + άθροισμα αξίας." },
      { kpi: "Πιστότητα ιατρού", what: "Πόσο σταθερά «στέλνει» ο ιατρός στο φαρμακείο.", how: "Τάση όγκου του ιατρού στις τελευταίες περιόδους vs προηγούμενες." },
    ],
  },
  {
    title: "Αποζημίωση / Κλείσιμο Μήνα", emoji: "🧾", items: [
      { kpi: "Αιτούμενο (claim)", what: "Το ποσό που θα ζητηθεί από τα ταμεία για τον μήνα.", how: "Άθροισμα αιτούμενο ποσό ανά ταμείο, με διαχωρισμό ΕΟΠΥΥ σε Φάρμακα/Εμβόλια." },
      { kpi: "Rebate (Ν.3918)", what: "Κλιμακωτή κράτηση επί του καθαρού αιτούμενου ΕΟΠΥΥ-Φαρμάκων.", how: "Προοδευτική κλίμακα (0–5k 0% … 50k+ 8%) στη ΒΑΣΗ = ΕΟΠΥΥ φάρμακα εκτός ΦΥΚ/εμβολίων. Αφορά το ποσό που τελικά πληρώνεται." },
      { kpi: "Έκπτωση βάσει τζίρου (Ν.4052)", what: "Πρόσθετη κλιμακωτή έκπτωση για τζίρο >35.000€.", how: "Προοδευτική κλίμακα (35–50k 0,5% … 100k+ 5%) στην ίδια ρεμπεϊτ-βάση." },
      { kpi: "Αναμ. είσπραξη (receipt)", what: "Τι θα εισπράξει τελικά ο φαρμακοποιός.", how: "Αιτούμενο − Rebate − Έκπτωση τζίρου." },
      { kpi: "Πρόβλεψη", what: "Εκτίμηση αιτούμενου τρέχοντος μήνα ανά ταμείο.", how: "Α=μ.ό. 3 τελευταίων μηνών · Β=μ.ό. ίδιων 3 μηνών πέρυσι · Γ=ίδιος μήνας πέρυσι · Δ=(Γ−Β)/Β · Πρόβλεψη = Α×(1+Δ)." },
    ],
  },
  {
    title: "Μελλοντικές συνταγές", emoji: "📅", items: [
      { kpi: "Κάλυψη περιόδου", what: "Πόσες επαναλήψεις ανοίγουν σε μια μελλοντική περίοδο.", how: "Από ημερομηνία ανοίγματος της επανάληψης των αλυσίδων επανάληψης που πέφτει εντός της περιόδου." },
      { kpi: "Πρόβλεψη κάλυψης", what: "Εκτιμώμενος όγκος/αξία που μπορείς να καλύψεις.", how: "Άθροισμα αναμενόμενης αξίας των μελλοντικών παραθύρων (future_prescriptions)." },
    ],
  },
  {
    title: "Πιστότητα", emoji: "🎁", items: [
      { kpi: "Πόντοι", what: "Πόντοι που μάζεψε ο εγγεγραμμένος πελάτης.", how: "Εκτελέσεις επαναλαμβανόμενων συνταγών ΑΠΟ την ημερομηνία εγγραφής × «πόντοι ανά εκτέλεση» (ρύθμιση). ΔΕΝ μετρούν παλαιότερες εκτελέσεις." },
      { kpi: "Πορτοφόλι €", what: "Διαθέσιμη αξία για εξαργύρωση.", how: "(πόντοι × λεπτά/πόντο) + προσαρμογές − εξαργυρώσεις (μη ακυρωμένες)." },
      { kpi: "Επίπεδο (tier)", what: "Βαθμίδα πιστότητας.", how: "Με βάση τους συνολικούς πόντους: Bronze 0 · Silver 400 · Gold 1000 · Platinum 2500." },
    ],
  },
  {
    title: "Μετρήσεις πελάτη", emoji: "❤️", items: [
      { kpi: "ΔΜΣ / BMI", what: "Δείκτης μάζας σώματος.", how: "βάρος(kg) ÷ ύψος(m)². Χρωματισμός: <18.5 ή ≥25 κίτρινο, ≥30 κόκκινο." },
      { kpi: "Πίεση", what: "Τελευταία μέτρηση αρτηριακής πίεσης.", how: "Συστολική/Διαστολική. ≥130/85 οριακό (κίτρινο), ≥140/90 υψηλό (κόκκινο)." },
      { kpi: "Ζάχαρο", what: "Τελευταία μέτρηση γλυκόζης.", how: "mg/dL. 100–125 οριακό (κίτρινο), ≥126 υψηλό (κόκκινο)." },
    ],
  },
];

export default function GuidePage() {
  const t = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(GROUPS[0].title);
  const s = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({...g, items: s ? g.items.filter((i) => (i.kpi + i.what + i.how).toLowerCase().includes(s)) : g.items })).filter((g) => g.items.length);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-indigo-600 text-white shadow-lg"><BookOpen className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πώς υπολογίζονται οι δείκτες", "How the indicators are computed")}</h1>
          <p className="text-sm text-slate-500">{t("Αναλυτική επεξήγηση κάθε KPI: τι δείχνει & πώς προκύπτει — η ίδια πηγή με τα ⓘ της εφαρμογής.", "What each KPI means & how it is derived.")}</p>
        </div>
      </div>

      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση δείκτη…", "Search indicator…")}
          className="w-full rounded-xl border border-slate-300 py-2.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800" />
      </div>

      <div className="space-y-3">
        {groups.map((g) => {
          const expanded = !!s || open === g.title;
          return (
            <div key={g.title} className="rx-card overflow-hidden">
              <button onClick={() => setOpen(open === g.title ? null : g.title)} className="flex w-full items-center justify-between px-4 py-3 text-left">
                <span className="font-semibold text-slate-800 dark:text-slate-200">{g.emoji} {g.title}</span>
                <ChevronDown className={`h-4 w-4 text-slate-400 transition ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded && (
                <div className="border-t border-slate-100 dark:border-slate-800">
                  {g.items.map((i) => (
                    <div key={i.kpi} className="border-b border-slate-50 px-4 py-3 last:border-0 dark:border-slate-800/60">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{i.kpi}</div>
                      <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{i.what}</div>
                      <div className="mt-1 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-500 dark:bg-slate-800/60"><b>{t("Υπολογισμός:", "Computed:")}</b> {i.how}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
