"use client";

import { useState } from "react";
import { BookOpen, Search, ChevronDown } from "lucide-react";
import { useT } from "@/store/prefStore";

type Loc = { el: string; en: string };
type Item = { kpi: Loc; what: Loc; how: Loc };
type Group = { title: Loc; emoji: string; items: Item[] };

// Κεντρικός κατάλογος: τι δείχνει & ΠΩΣ υπολογίζεται κάθε δείκτης. Πηγή αλήθειας για τα ⓘ tooltips.
const GROUPS: Group[] = [
  {
    title: { el: "Πίνακας Ελέγχου", en: "Dashboard" }, emoji: "📊", items: [
      { kpi: { el: "Συνταγές (πλήθος)", en: "Prescriptions (count)" }, what: { el: "Πόσες εκτελέσεις συνταγών έγιναν στην επιλεγμένη περίοδο.", en: "How many prescription executions occurred in the selected period." }, how: { el: "Μέτρηση εγγραφών prescription_executions με executed_at εντός της περιόδου του φίλτρου.", en: "Count of prescription_executions records with executed_at within the filter period." } },
      { kpi: { el: "Τζίρος / Αξία", en: "Turnover / Value" }, what: { el: "Συνολική λιανική αξία των εκτελεσμένων συνταγών.", en: "Total retail value of the executed prescriptions." }, how: { el: "Άθροισμα λιανική αξία (σε λεπτά) όλων των εκτελέσεων της περιόδου.", en: "Sum of retail value (in cents) of all executions in the period." } },
      { kpi: { el: "Συμμετοχή patient_ref", en: "Patient share (patient_ref)" }, what: { el: "Πόσα πλήρωσαν οι ασθενείς από την τσέπη τους.", en: "How much patients paid out of pocket." }, how: { el: "Άθροισμα συμμετοχή ασθενή όλων των εκτελέσεων.", en: "Sum of patient share across all executions." } },
      { kpi: { el: "Κάλυψη ταμείων", en: "Fund coverage" }, what: { el: "Πόσα κάλυψαν τα ασφαλιστικά ταμεία.", en: "How much the insurance funds covered." }, how: { el: "Αξία − Συμμετοχή ασθενή (amount_total − patient_share).", en: "Value − patient share (amount_total − patient_share)." } },
      { kpi: { el: "Δ% vs πέρσι", en: "Δ% vs last year" }, what: { el: "Μεταβολή σε σχέση με την ίδια περίοδο πέρυσι.", en: "Change versus the same period last year." }, how: { el: "(φετινό − περσινό) / περσινό × 100, για την ίδια ημερολογιακή περίοδο.", en: "(this year − last year) / last year × 100, for the same calendar period." } },
    ],
  },
  {
    title: { el: "Ασφαλισμένοι / Patient Intelligence", en: "Patients / Patient Intelligence" }, emoji: "👥", items: [
      { kpi: { el: "Συνέπεια (compliance)", en: "Adherence (compliance)" }, what: { el: "Πόσο συνεπείς είναι οι χρόνιοι ασθενείς στις επαναλαμβανόμενες συνταγές.", en: "How consistent chronic patients are with their repeat prescriptions." }, how: { el: "Για κάθε αλυσίδα επανάληψης μετράμε τα μηνιαία «παράθυρα» που έπρεπε να εκτελεστούν έως σήμερα και πόσα όντως εκτελέστηκαν: εκτελέστηκαν / αναμενόμενα × 100.", en: "For each repeat chain we count the monthly windows due until today and how many were actually executed: executed / expected × 100." } },
      { kpi: { el: "VIP / LTV", en: "VIP / LTV" }, what: { el: "Οι πιο πολύτιμοι πελάτες με βάση τη συνολική τους αξία.", en: "The most valuable customers by their total value." }, how: { el: "Κατάταξη ασθενών κατά συνολική λιανική αξία (rx_value_total)· τα top ποσοστά → VIP tiers.", en: "Patients ranked by total retail value (rx_value_total); the top percentiles → VIP tiers." } },
      { kpi: { el: "Σε κίνδυνο / Win-back", en: "At risk / Win-back" }, what: { el: "Πελάτες που έχουν αρχίσει να χάνονται.", en: "Customers who are starting to slip away." }, how: { el: "Ασθενείς με κενό (gap) από την τελευταία εκτέλεση πέρα από το αναμενόμενο διάστημα της αγωγής τους.", en: "Patients whose gap since the last execution exceeds the expected interval of their treatment." } },
      { kpi: { el: "Χαμένες ανανεώσεις", en: "Missed refills" }, what: { el: "Επαναλαμβανόμενες συνταγές που δεν εκτελέστηκαν στο παράθυρό τους.", en: "Repeat prescriptions not executed within their window." }, how: { el: "Παράθυρα επανάληψης που έκλεισαν χωρίς εκτέλεση (missed) — με την ανακτήσιμη αξία τους.", en: "Repeat windows that closed without an execution (missed) — with their recoverable value." } },
    ],
  },
  {
    title: { el: "Ιατροί", en: "Doctors" }, emoji: "🩺", items: [
      { kpi: { el: "Συνταγογράφηση ανά ιατρό", en: "Prescribing per doctor" }, what: { el: "Όγκος & αξία συνταγών ανά παραπέμποντα ιατρό.", en: "Volume & value of prescriptions per referring doctor." }, how: { el: "Ομαδοποίηση εκτελέσεων κατά doctor_id· πλήθος + άθροισμα αξίας.", en: "Executions grouped by doctor_id; count + value sum." } },
      { kpi: { el: "Πιστότητα ιατρού", en: "Doctor loyalty" }, what: { el: "Πόσο σταθερά «στέλνει» ο ιατρός στο φαρμακείο.", en: "How steadily the doctor sends patients to the pharmacy." }, how: { el: "Τάση όγκου του ιατρού στις τελευταίες περιόδους vs προηγούμενες.", en: "The doctor's volume trend over recent periods vs earlier ones." } },
    ],
  },
  {
    title: { el: "Αποζημίωση / Κλείσιμο Μήνα", en: "Reimbursement / Month Closing" }, emoji: "🧾", items: [
      { kpi: { el: "Αιτούμενο (claim)", en: "Claim" }, what: { el: "Το ποσό που θα ζητηθεί από τα ταμεία για τον μήνα.", en: "The amount to be claimed from the funds for the month." }, how: { el: "Άθροισμα αιτούμενο ποσό ανά ταμείο, με διαχωρισμό ΕΟΠΥΥ σε Φάρμακα/Εμβόλια.", en: "Sum of the claim amount per fund, splitting ΕΟΠΥΥ into Medicines/Vaccines." } },
      { kpi: { el: "Rebate (Ν.3918)", en: "Rebate (L.3918)" }, what: { el: "Κλιμακωτή κράτηση επί του καθαρού αιτούμενου ΕΟΠΥΥ-Φαρμάκων.", en: "Tiered deduction on the net ΕΟΠΥΥ-Medicines claim." }, how: { el: "Προοδευτική κλίμακα (0–5k 0% … 50k+ 8%) στη ΒΑΣΗ = ΕΟΠΥΥ φάρμακα εκτός ΦΥΚ/εμβολίων. Αφορά το ποσό που τελικά πληρώνεται.", en: "Progressive scale (0–5k 0% … 50k+ 8%) on the BASE = ΕΟΠΥΥ medicines excluding ΦΥΚ/vaccines. Applies to the amount finally paid." } },
      { kpi: { el: "Έκπτωση βάσει τζίρου (Ν.4052)", en: "Turnover-based discount (L.4052)" }, what: { el: "Πρόσθετη κλιμακωτή έκπτωση για τζίρο >35.000€.", en: "Additional tiered discount for turnover >€35,000." }, how: { el: "Προοδευτική κλίμακα (35–50k 0,5% … 100k+ 5%) στην ίδια ρεμπεϊτ-βάση.", en: "Progressive scale (35–50k 0.5% … 100k+ 5%) on the same rebate base." } },
      { kpi: { el: "Αναμ. είσπραξη (receipt)", en: "Expected receipt" }, what: { el: "Τι θα εισπράξει τελικά ο φαρμακοποιός.", en: "What the pharmacist will ultimately collect." }, how: { el: "Αιτούμενο − Rebate − Έκπτωση τζίρου.", en: "Claim − rebate − turnover discount." } },
      { kpi: { el: "Πρόβλεψη", en: "Forecast" }, what: { el: "Εκτίμηση αιτούμενου τρέχοντος μήνα ανά ταμείο.", en: "Estimated claim for the current month per fund." }, how: { el: "Α=μ.ό. 3 τελευταίων μηνών · Β=μ.ό. ίδιων 3 μηνών πέρυσι · Γ=ίδιος μήνας πέρυσι · Δ=(Γ−Β)/Β · Πρόβλεψη = Α×(1+Δ).", en: "A=avg of the last 3 months · B=avg of the same 3 months last year · C=same month last year · Δ=(C−B)/B · Forecast = A×(1+Δ)." } },
    ],
  },
  {
    title: { el: "Μελλοντικές συνταγές", en: "Future prescriptions" }, emoji: "📅", items: [
      { kpi: { el: "Κάλυψη περιόδου", en: "Period coverage" }, what: { el: "Πόσες επαναλήψεις ανοίγουν σε μια μελλοντική περίοδο.", en: "How many repeats open in a future period." }, how: { el: "Από ημερομηνία ανοίγματος της επανάληψης των αλυσίδων επανάληψης που πέφτει εντός της περιόδου.", en: "By the repeat's opening date of the repeat chains that falls within the period." } },
      { kpi: { el: "Πρόβλεψη κάλυψης", en: "Coverage forecast" }, what: { el: "Εκτιμώμενος όγκος/αξία που μπορείς να καλύψεις.", en: "Estimated volume/value you can cover." }, how: { el: "Άθροισμα αναμενόμενης αξίας των μελλοντικών παραθύρων (future_prescriptions).", en: "Sum of the expected value of the future windows (future_prescriptions)." } },
    ],
  },
  {
    title: { el: "Πιστότητα", en: "Loyalty" }, emoji: "🎁", items: [
      { kpi: { el: "Πόντοι", en: "Points" }, what: { el: "Πόντοι που μάζεψε ο εγγεγραμμένος πελάτης.", en: "Points collected by the registered customer." }, how: { el: "Εκτελέσεις επαναλαμβανόμενων συνταγών ΑΠΟ την ημερομηνία εγγραφής × «πόντοι ανά εκτέλεση» (ρύθμιση). ΔΕΝ μετρούν παλαιότερες εκτελέσεις.", en: "Repeat-prescription executions FROM the registration date × «points per execution» (setting). Earlier executions do NOT count." } },
      { kpi: { el: "Πορτοφόλι €", en: "Wallet €" }, what: { el: "Διαθέσιμη αξία για εξαργύρωση.", en: "Value available for redemption." }, how: { el: "(πόντοι × λεπτά/πόντο) + προσαρμογές − εξαργυρώσεις (μη ακυρωμένες).", en: "(points × cents/point) + adjustments − redemptions (non-cancelled)." } },
      { kpi: { el: "Επίπεδο (tier)", en: "Tier" }, what: { el: "Βαθμίδα πιστότητας.", en: "Loyalty tier." }, how: { el: "Με βάση τους συνολικούς πόντους: Bronze 0 · Silver 400 · Gold 1000 · Platinum 2500.", en: "Based on total points: Bronze 0 · Silver 400 · Gold 1000 · Platinum 2500." } },
    ],
  },
  {
    title: { el: "Μετρήσεις πελάτη", en: "Customer measurements" }, emoji: "❤️", items: [
      { kpi: { el: "ΔΜΣ / BMI", en: "BMI" }, what: { el: "Δείκτης μάζας σώματος.", en: "Body mass index." }, how: { el: "βάρος(kg) ÷ ύψος(m)². Χρωματισμός: <18.5 ή ≥25 κίτρινο, ≥30 κόκκινο.", en: "weight(kg) ÷ height(m)². Coloring: <18.5 or ≥25 amber, ≥30 red." } },
      { kpi: { el: "Πίεση", en: "Blood pressure" }, what: { el: "Τελευταία μέτρηση αρτηριακής πίεσης.", en: "Latest blood-pressure reading." }, how: { el: "Συστολική/Διαστολική. ≥130/85 οριακό (κίτρινο), ≥140/90 υψηλό (κόκκινο).", en: "Systolic/Diastolic. ≥130/85 borderline (amber), ≥140/90 high (red)." } },
      { kpi: { el: "Ζάχαρο", en: "Blood sugar" }, what: { el: "Τελευταία μέτρηση γλυκόζης.", en: "Latest glucose reading." }, how: { el: "mg/dL. 100–125 οριακό (κίτρινο), ≥126 υψηλό (κόκκινο).", en: "mg/dL. 100–125 borderline (amber), ≥126 high (red)." } },
    ],
  },
];

export default function GuidePage() {
  const t = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(GROUPS[0].title.el);
  const s = q.trim().toLowerCase();
  const searchable = (i: Item) => (i.kpi.el + i.what.el + i.how.el + i.kpi.en + i.what.en + i.how.en).toLowerCase();
  const groups = GROUPS.map((g) => ({ ...g, items: s ? g.items.filter((i) => searchable(i).includes(s)) : g.items })).filter((g) => g.items.length);

  return (
    <div className="w-full">
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

      <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {groups.map((g) => {
          const expanded = !!s || open === g.title.el;
          return (
            <div key={g.title.el} className="rx-card overflow-hidden">
              <button onClick={() => setOpen(open === g.title.el ? null : g.title.el)} className="flex w-full items-center justify-between px-4 py-3 text-left">
                <span className="font-semibold text-slate-800 dark:text-slate-200">{g.emoji} {t(g.title.el, g.title.en)}</span>
                <ChevronDown className={`h-4 w-4 text-slate-400 transition ${expanded ? "rotate-180" : ""}`} />
              </button>
              {expanded && (
                <div className="border-t border-slate-100 dark:border-slate-800">
                  {g.items.map((i) => (
                    <div key={i.kpi.el} className="border-b border-slate-50 px-4 py-3 last:border-0 dark:border-slate-800/60">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t(i.kpi.el, i.kpi.en)}</div>
                      <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t(i.what.el, i.what.en)}</div>
                      <div className="mt-1 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-500 dark:bg-slate-800/60"><b>{t("Υπολογισμός:", "Computed:")}</b> {t(i.how.el, i.how.en)}</div>
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
