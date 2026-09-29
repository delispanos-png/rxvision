"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Receipt, Users, Wallet, Target, Pill, TrendingDown, TrendingUp, AlertTriangle, ChevronDown } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { pctDelta } from "@/lib/compare";
import { fmtDec, fmtEur, fmtNum, fmtPct } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";

type Verdict = "pressure" | "helps" | "neutral";
type Reason = "loss" | "below_avg" | "cuts" | "above_avg" | "near_avg" | "small" | "unallocated";
type DimKey = "category" | "kind" | "price_band" | "fund";

type Segment = {
  label: string;
  value: number; cost: number; cuts: number; profit: number; // cents
  margin_pct: number; return_on_capital_pct: number;
  revenue_share_pct: number; profit_share_pct: number;
  impact: number;                 // cents — κέρδος − (έσοδα × μέσο περιθώριο της διάστασης)
  prev_profit: number | null; delta_profit: number | null;
  verdict: Verdict; reason: Reason;
};
type Focus = Segment & { type: "pressure" | "helps" | "decline"; dim: DimKey };
type Kpis = {
  revenue: number; capital: number; gross_profit: number; fund_cuts: number; net_profit: number;
  margin_pct: number; return_on_capital_pct: number;
  prescriptions: number; patients: number; profit_per_prescription: number; profit_per_patient: number;
  top10_profit_share_pct: number; products: number;
  high_cost_revenue_pct: number; high_cost_capital_pct: number;
};
type Attention = {
  kpis: Kpis & { prev: Kpis };
  dimensions: { key: DimKey; segments: Segment[] }[];
  focus: Focus[];
};

/** Ό,τι χρειάζεται ένας φαρμακοποιός για να δει ΠΟΥ να κοιτάξει. Κανένα κείμενο δεν λέει «ανέβασε
 *  τιμή» ή «διαπραγματεύσου»: στα συνταγογραφούμενα το περιθώριο το ορίζει η κρατική διατίμηση. */
export function AttentionMap({ q }: { q: string }) {
  const t = useT();
  const [dim, setDim] = useState<DimKey>("price_band");
  const [showSmall, setShowSmall] = useState(false);
  const att = useQuery({
    queryKey: ["profitability", "attention", q],
    queryFn: () => api<Attention>(`/profitability/attention?${q}`),
  });
  const d = att.data;
  const k = d?.kpis;
  const pk = k?.prev;

  const DIM_LABEL: Record<DimKey, string> = {
    category: t("Θεραπευτική κατηγορία", "Therapeutic category"),
    kind: t("Είδος σκευάσματος", "Medicine kind"),
    price_band: t("Κλιμάκιο τιμής", "Price band"),
    fund: t("Ταμείο", "Insurance fund"),
  };
  const DIM_HELP: Record<DimKey, string> = {
    category: t("Κατηγορία με βάση τον κωδικό ATC του σκευάσματος.", "Category by the medicine's ATC code."),
    kind: t("ΦΥΚ, νοσοκομειακά, ναρκωτικά, γαληνικά, αντιβιοτικά ή κοινά — από τον κατάλογο της ΗΔΥΚΑ.", "High-cost, hospital, narcotic, galenic, antibiotic or ordinary — from the ΗΔΥΚΑ catalogue."),
    price_band: t("Λιανική ανά συσκευασία. Η διατίμηση δίνει μικρότερο ποσοστό όσο ακριβαίνει το φάρμακο.", "Retail per pack. State pricing gives a smaller percentage the more expensive the medicine."),
    fund: t("Μετά τις περικοπές, στους μήνες που σημείωσες ως εξοφλημένους.", "After cuts, in the months you marked as settled."),
  };
  const REASON: Record<Reason, string> = {
    loss: t("ζημιά", "loss"),
    below_avg: t("κάτω από τον μέσο όρο", "below average"),
    cuts: t("περικοπές", "cuts"),
    above_avg: t("πάνω από τον μέσο όρο", "above average"),
    near_avg: t("κοντά στον μέσο όρο", "near average"),
    small: t("μικρό βάρος", "small weight"),
    unallocated: t("χωρίς ανάλυση", "not broken down"),
  };

  const hint = (f: Focus): string => {
    if (f.type === "helps")
      return t("Φέρνει περισσότερο κέρδος από όσο αναλογεί στον όγκο του. Κράτα διαθεσιμότητα: μια συνταγή που φεύγει αλλού εδώ σου κοστίζει περισσότερο από τον μέσο όρο.",
               "Earns more than its volume suggests. Keep it available: a prescription that goes elsewhere here costs you more than average.");
    if (f.type === "decline")
      return t("Έφερε λιγότερο κέρδος από την ίδια περίοδο πέρσι. Δες αν χάνεις επαναλήψεις ή πελάτες σε αυτή την κατηγορία.",
               "Earned less than the same period last year. Check whether you are losing repeats or customers in this category.");
    if (f.reason === "loss")
      return t("Το κόστος ξεπερνά τα έσοδα. Έλεγξε αν η χονδρική είναι σωστή — όσες τιμές έχουν «~» είναι εκτίμηση.",
               "Cost exceeds revenue. Check the wholesale prices — those marked “~” are estimates.");
    if (f.dim === "fund")
      return f.reason === "cuts"
        ? t("Οι περικοπές αυτού του ταμείου τρώνε το κέρδος. Δες τους λόγους στην Αποζημίωση πριν από την επόμενη υποβολή.",
            "This fund's cuts eat into profit. Review the reasons under Reimbursement before the next submission.")
        : t("Χαμηλότερο περιθώριο στις συνταγές αυτού του ταμείου — συνήθως επειδή καλύπτει ακριβότερα σκευάσματα.",
            "Lower margin on this fund's prescriptions — usually because it covers more expensive medicines.");
    if (f.dim === "category")
      return t("Χαμηλότερο περιθώριο από τον μέσο όρο σου σε σημαντικό όγκο. Συνήθως το τραβούν κάτω λίγα ακριβά σκευάσματα — δες τα στα «Είδη χαμηλής κερδοφορίας» πιο κάτω.",
               "Lower margin than your average on significant volume. Usually a few expensive medicines pull it down — see “Low-margin items” below.");
    return t("Η διατίμηση δίνει μικρότερο ποσοστό όσο ακριβαίνει το φάρμακο, και τα χρήματα μένουν δεσμευμένα μέχρι να πληρώσει το ταμείο. Δεν διορθώνεται με την τιμή: φέρνε τα κατά παραγγελία συνταγής, όχι για απόθεμα, και παρακολούθησε την εξόφληση.",
             "State pricing gives a smaller percentage the more expensive the medicine, and the money stays tied up until the fund pays. Not fixable through price: order them per prescription rather than for stock, and follow up on payment.");
  };

  const signed = (c: number) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${fmtEur(Math.abs(c))}`;
  const segs = d?.dimensions.find((x) => x.key === dim)?.segments ?? [];
  const tv = segs.reduce((a, s) => a + s.value, 0);
  const avg = tv ? (segs.reduce((a, s) => a + s.profit, 0) / tv) * 100 : 0;
  const maxImpact = Math.max(1, ...segs.map((s) => Math.abs(s.impact)));
  const pressure = segs.filter((s) => s.verdict === "pressure");
  const helps = segs.filter((s) => s.verdict === "helps").sort((a, b) => b.impact - a.impact);
  const neutral = segs.filter((s) => s.verdict === "neutral");
  const neutralBig = neutral.filter((s) => s.reason !== "small").sort((a, b) => b.value - a.value);
  const neutralSmall = neutral.filter((s) => s.reason === "small").sort((a, b) => b.value - a.value);

  // Συναρτήσεις, ΟΧΙ components: component ορισμένο μέσα στο render ξαναστήνεται σε κάθε ανανέωση.
  const row = (s: Segment) => {
    const w = `${Math.max(4, (Math.abs(s.impact) / maxImpact) * 100)}%`;
    const tone = s.verdict === "pressure" ? "bg-rose-400" : s.verdict === "helps" ? "bg-emerald-400" : "bg-slate-300 dark:bg-slate-600";
    return (
      <li key={s.label} className="py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 break-words text-sm font-medium text-slate-800 dark:text-slate-100">{s.label}</span>
          <span className={`shrink-0 text-sm font-semibold tabular-nums ${s.impact < 0 ? "text-rose-600 dark:text-rose-400" : s.impact > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"}`}>{signed(s.impact)}</span>
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-1.5 rounded-full ${tone}`} style={{ width: w }} /></div>
        <p className="mt-1 text-xs text-slate-500">
          {t("περιθώριο", "margin")} {fmtPct(s.margin_pct)} · {fmtDec(s.revenue_share_pct, 1)}% {t("των εσόδων", "of revenue")}
          {s.cuts > 0 && <> · {t("περικοπές", "cuts")} {fmtEur(s.cuts)}</>}
          {s.delta_profit !== null && s.prev_profit !== null && s.prev_profit !== 0 && <> · {t("πέρσι", "last year")} {signed(s.delta_profit)}</>}
        </p>
      </li>
    );
  };

  const column = (title: string, Icon: typeof TrendingUp, tone: string, rows: Segment[], empty: string) => (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className={`mb-1 flex items-center justify-between gap-2 text-sm font-semibold ${tone}`}>
        <span className="flex items-center gap-1.5"><Icon className="h-4 w-4" />{title} <span className="font-normal text-slate-400">({rows.length})</span></span>
        {rows.length > 0 && <span className="tabular-nums">{signed(rows.reduce((a, s) => a + s.impact, 0))}</span>}
      </div>
      {rows.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map(row)}</ul>
        : <p className="py-3 text-xs text-slate-400">{empty}</p>}
    </div>
  );

  const FOCUS_STYLE = {
    pressure: { label: t("Πιέζει", "Pressure"), cls: "border-l-rose-500", badge: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300", Icon: AlertTriangle },
    decline: { label: t("Πτώση έναντι πέρσι", "Down vs last year"), cls: "border-l-amber-500", badge: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300", Icon: TrendingDown },
    helps: { label: t("Βοηθά", "Helps"), cls: "border-l-emerald-500", badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300", Icon: TrendingUp },
  } as const;

  return (
    <QueryState isLoading={att.isLoading} isError={att.isError} isEmpty={!!d && d.kpis.revenue === 0} onRetry={() => att.refetch()}>
      {k && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <KpiCard label={t("Απόδοση κεφαλαίου", "Return on capital")} icon={Gauge} accent="violet"
              help={t("Κέρδος για κάθε 1€ που πλήρωσες στη χονδρική για ό,τι δόθηκε. Δείχνει πόσο «δουλεύουν» τα χρήματα που βάζεις σε φάρμακα.", "Profit for every €1 paid to the wholesaler for what was dispensed. Shows how hard the money you put into medicines works.")}
              value={fmtPct(k.return_on_capital_pct)} sub={t(`${fmtDec(k.return_on_capital_pct, 0)} λεπτά ανά 1€ χονδρικής`, `${fmtDec(k.return_on_capital_pct, 0)} cents per €1 wholesale`)}
              trend={pctDelta(k.return_on_capital_pct, pk?.return_on_capital_pct)} />
            <KpiCard label={t("Κέρδος ανά συνταγή", "Profit per prescription")} icon={Receipt} accent="green"
              help={t("Μεικτό κέρδος διά τις συνταγές της περιόδου. Μια συνταγή που εκτελέστηκε σε πολλές δόσεις μετρά μία φορά.", "Gross profit divided by the period's prescriptions. A prescription dispensed in several parts counts once.")}
              value={fmtEur(k.profit_per_prescription)} sub={t(`${fmtNum(k.prescriptions)} συνταγές`, `${fmtNum(k.prescriptions)} prescriptions`)}
              trend={pctDelta(k.profit_per_prescription, pk?.profit_per_prescription)} />
            <KpiCard label={t("Κέρδος ανά πελάτη", "Profit per customer")} icon={Users} accent="sky"
              help={t("Μεικτό κέρδος διά τους διαφορετικούς ασθενείς που εξυπηρέτησες στην περίοδο.", "Gross profit divided by the distinct patients you served in the period.")}
              value={fmtEur(k.profit_per_patient)} sub={t(`${fmtNum(k.patients)} πελάτες`, `${fmtNum(k.patients)} customers`)}
              trend={pctDelta(k.profit_per_patient, pk?.profit_per_patient)} />
            <KpiCard label={t("Κεφάλαιο σε χονδρική", "Capital at wholesale")} icon={Wallet} accent="amber"
              help={t("Όσα πλήρωσες (ή θα πληρώσεις) στη χονδρική για ό,τι δόθηκε στην περίοδο. Μένουν δεσμευμένα μέχρι να πληρώσει το ταμείο.", "What you paid (or will pay) the wholesaler for what was dispensed. It stays tied up until the fund pays.")}
              value={fmtEur(k.capital)} sub={t("για ό,τι δόθηκε", "for what was dispensed")} />
            <KpiCard label={t("Συγκέντρωση κέρδους", "Profit concentration")} icon={Target} accent="indigo"
              help={t("Τι ποσοστό του κέρδους φέρνουν τα 10 πιο κερδοφόρα σκευάσματα. Υψηλό = εξαρτάσαι από λίγα· αν λείψουν, το νιώθεις αμέσως.", "Share of profit from your 10 most profitable medicines. High = you depend on a few; if they go missing you feel it at once.")}
              value={fmtPct(k.top10_profit_share_pct)} sub={t(`από 10 σε ${fmtNum(k.products)} σκευάσματα`, `from 10 of ${fmtNum(k.products)} medicines`)} />
            <KpiCard label={t("Βάρος ΦΥΚ", "High-cost weight")} icon={Pill} accent="rose"
              help={t("Τι ποσοστό του κεφαλαίου σου πάει σε φάρμακα υψηλού κόστους (ΦΥΚ). Έχουν μικρό περιθώριο και δεσμεύουν πολλά χρήματα.", "Share of your capital going to high-cost medicines. They carry a small margin and tie up a lot of money.")}
              value={fmtPct(k.high_cost_capital_pct)} sub={t(`${fmtDec(k.high_cost_revenue_pct, 1)}% των εσόδων`, `${fmtDec(k.high_cost_revenue_pct, 1)}% of revenue`)} />
          </div>

          <PanelCard title={t("Πού να στρέψεις την προσοχή σου", "Where to turn your attention")}>
            {d.focus.length === 0 ? (
              <p className="text-sm text-slate-500">{t("Καμία ενότητα δεν ξεχωρίζει: το κέρδος σου μοιράζεται ομοιόμορφα σε αυτή την περίοδο.", "Nothing stands out: your profit is spread evenly in this period.")}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {d.focus.map((f) => {
                  const st = FOCUS_STYLE[f.type];
                  const big = f.type === "decline" ? (f.delta_profit ?? 0) : f.impact;
                  return (
                    <div key={`${f.type}-${f.dim}-${f.label}`} className={`rounded-xl border border-l-4 border-slate-200 p-3 dark:border-slate-800 ${st.cls}`}>
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${st.badge}`}><st.Icon className="h-3 w-3" />{st.label}</span>
                        <span className="text-slate-400">{DIM_LABEL[f.dim]}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <b className="min-w-0 break-words text-slate-900 dark:text-slate-100">{f.label}</b>
                        <span className={`shrink-0 text-lg font-bold tabular-nums ${big < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>{signed(big)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {f.type === "decline"
                          ? t(`κέρδος ${fmtEur(f.profit)} έναντι ${fmtEur(f.prev_profit ?? 0)} πέρσι`, `profit ${fmtEur(f.profit)} vs ${fmtEur(f.prev_profit ?? 0)} last year`)
                          : t(`περιθώριο ${fmtPct(f.margin_pct)} · ${fmtDec(f.revenue_share_pct, 1)}% των εσόδων · ${fmtDec(f.cost / Math.max(1, k.capital) * 100, 1)}% του κεφαλαίου`,
                              `margin ${fmtPct(f.margin_pct)} · ${fmtDec(f.revenue_share_pct, 1)}% of revenue · ${fmtDec(f.cost / Math.max(1, k.capital) * 100, 1)}% of capital`)}
                      </p>
                      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{hint(f)}</p>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-3 text-xs text-slate-400">
              {t("Ο αριθμός δίπλα σε κάθε ενότητα είναι η επίδρασή της: πόσο περισσότερο (+) ή λιγότερο (−) κέρδος έφερε από όσο θα έφερνε με το μέσο περιθώριό σου. «Πτώση» = σύγκριση με την ίδια περίοδο πέρσι.",
                 "The number next to each item is its impact: how much more (+) or less (−) profit it brought than it would at your average margin. “Down” compares with the same period last year.")}
            </p>
          </PanelCard>

          <PanelCard
            title={t("Χάρτης κερδοφορίας", "Profitability map")}
            action={
              <div className="flex flex-wrap gap-1" role="tablist">
                {(Object.keys(DIM_LABEL) as DimKey[]).map((key) => (
                  <button key={key} role="tab" aria-selected={dim === key} onClick={() => setDim(key)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium ${dim === key ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"}`}>
                    {DIM_LABEL[key]}
                  </button>
                ))}
              </div>
            }
          >
            <p className="mb-3 text-xs text-slate-500">
              {DIM_HELP[dim]} {t(`Μέσο περιθώριο: ${fmtPct(avg)}. «Πιέζει» = τουλάχιστον 10% κάτω από αυτό, «βοηθά» = τουλάχιστον 10% πάνω· κάτω από 2% των εσόδων μια ενότητα δεν αλλάζει την εικόνα.`,
                                  `Average margin: ${fmtPct(avg)}. “Pressure” = at least 10% below it, “helps” = at least 10% above; below 2% of revenue an item does not change the picture.`)}
            </p>
            <div className="grid gap-3 lg:grid-cols-3">
              {column(t("Πιέζουν", "Pressure"), TrendingDown, "text-rose-600 dark:text-rose-400", pressure,
                t("Τίποτα δεν πιέζει σε αυτή τη διάσταση.", "Nothing is under pressure in this dimension."))}
              {column(t("Βοηθούν", "Help"), TrendingUp, "text-emerald-600 dark:text-emerald-400", helps,
                t("Καμία ενότητα δεν ξεχωρίζει προς τα πάνω.", "Nothing stands out upwards."))}
              <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="mb-1 text-sm font-semibold text-slate-500">
                  {t("Αδιάφορες", "Neutral")} <span className="font-normal text-slate-400">({neutral.length})</span>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {neutralBig.map((s) => (
                    <li key={s.label} className="flex items-baseline justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0 break-words text-slate-700 dark:text-slate-200">{s.label}
                        <span className="block text-xs text-slate-400">{REASON[s.reason]} · {fmtPct(s.margin_pct)} · {fmtDec(s.revenue_share_pct, 1)}%</span></span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">{signed(s.impact)}</span>
                    </li>
                  ))}
                </ul>
                {neutralSmall.length > 0 && (
                  <>
                    <button onClick={() => setShowSmall((v) => !v)} className="mt-2 flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700">
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSmall ? "rotate-180" : ""}`} />
                      {t(`${neutralSmall.length} μικρές ενότητες (κάτω από 2%)`, `${neutralSmall.length} small items (under 2%)`)}
                    </button>
                    {showSmall && (
                      <ul className="mt-1 space-y-1 text-xs text-slate-500">
                        {neutralSmall.map((s) => (
                          <li key={s.label} className="flex justify-between gap-2"><span className="min-w-0 break-words">{s.label}</span><span className="shrink-0 tabular-nums">{fmtPct(s.margin_pct)} · {fmtDec(s.revenue_share_pct, 1)}%</span></li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </PanelCard>
        </div>
      )}
    </QueryState>
  );
}
