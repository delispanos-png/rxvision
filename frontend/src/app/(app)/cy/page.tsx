"use client";

/* RxVision Κύπρος: Dashboard. ΙΔΙΑ δομή με το ελληνικό (/dashboard): χαιρετισμός, κοινό φίλτρο
   περιόδου, 5 κάρτες με σύγκριση με πέρσι, πορεία αξίας, top γιατροί, πρόσφατες εκτελέσεις, ώρες
   αιχμής, ημερολόγιο. Ό,τι δεν υπάρχει στο XML ΓεΣΥ αντικαθίσταται: το ICD-10 από τα σκευάσματα,
   το «αιτούμενο ταμείων» από την απαίτηση ΟΑΥ, το μεικτό κέρδος από την πληρωμή πελατών (δεν
   υπάρχει χονδρική). Από κάτω, οι κάρτες που έχει ΜΟΝΟ η Κύπρος (ανοιχτές/χαμένες συνταγές, PC2). */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 as BarIcon, FileUp, Receipt, Users, Wallet, HandCoins } from "lucide-react";
import { api } from "@/lib/apiClient";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { LineChart } from "@/components/charts/LineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { BarChart } from "@/components/charts/BarChart";
import { HeatmapChart, type HeatCell } from "@/components/charts/HeatmapChart";
import { CalendarHeatmap } from "@/components/charts/CalendarHeatmap";
import { fmtDate, fmtDateTime, fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Summary = { executions: number; value: number; hio: number; beneficiary: number; pc2: number; prescriptions: number; patient_count: number };
type Bucket = { bucket: string; value: number };
type HeatPoint = { dow: number; hour: number; value: number };
type Top = { _id?: string | null; name?: string | null; rx: number; value: number };
type Row = { dispensing_id: string; dispensed_at: string; patient_name: string | null; kind: string; instance: number; instances: number; totals: { total: number } };
type Overview = {
  open_prescriptions: number; lines_not_dispensed: number; last_import: string | null;
  chains: { soon: number; late: number; lost: number };
  lost_customers: { lost: number; leak: number; monthly_value_cents: number };
};

const eur0 = (c: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);

export default function CyDashboardPage() {
  const t = useT();
  const router = useRouter();
  const { dateFrom: from, dateTo: to } = useUiStore();
  const qs = `date_from=${from}&date_to=${to}`;
  const prevR = prevYearRange(from, to);

  const summary = useQuery({ queryKey: ["cy", "dash", "summary", qs], queryFn: () => api<Summary>(`/cy/dashboard/summary?${qs}`) });
  const prev = useQuery({
    queryKey: ["cy", "dash", "summary", "prev", prevR?.from, prevR?.to],
    queryFn: () => api<Summary>(`/cy/dashboard/summary?date_from=${prevR!.from}&date_to=${prevR!.to}`),
    enabled: !!prevR,
  });
  const tsVal = useQuery({ queryKey: ["cy", "dash", "ts", "value", qs], queryFn: () => api<Bucket[]>(`/cy/dashboard/timeseries?metric=value&${qs}`) });
  const tsHio = useQuery({ queryKey: ["cy", "dash", "ts", "hio", qs], queryFn: () => api<Bucket[]>(`/cy/dashboard/timeseries?metric=hio&${qs}`) });
  const tsExec = useQuery({ queryKey: ["cy", "dash", "ts", "exec", qs], queryFn: () => api<Bucket[]>(`/cy/dashboard/timeseries?metric=executions&${qs}`) });
  const topDoc = useQuery({ queryKey: ["cy", "dash", "doc", qs], queryFn: () => api<Top[]>(`/cy/dashboard/top?dim=doctors&${qs}`) });
  const topProd = useQuery({ queryKey: ["cy", "dash", "prod", qs], queryFn: () => api<Top[]>(`/cy/dashboard/top?dim=products&${qs}`) });
  const heat = useQuery({ queryKey: ["cy", "dash", "heat", qs], queryFn: () => api<HeatPoint[]>(`/cy/dashboard/heatmap?${qs}`) });
  const recent = useQuery({ queryKey: ["cy", "dash", "recent", qs], queryFn: () => api<{ items: Row[] }>(`/cy/dispensings?${qs}&page_size=6`) });
  const ov = useQuery({ queryKey: ["cy", "overview"], queryFn: () => api<Overview>("/cy/overview") });

  const s = summary.data, p = prev.data, o = ov.data;
  const labels = (tsVal.data ?? []).map((b) => { const [, m, d] = b.bucket.split("-"); return `${d}/${m}`; });
  const heatCells: HeatCell[] = (heat.data ?? []).map((x) => [x.hour, x.dow - 1, x.value]);
  const calendarData: [string, number][] = (tsExec.data ?? []).map((b) => [b.bucket, b.value]);
  const calendarWeeks = Math.ceil((calendarData.length || 7) / 7) + 1;
  const h = new Date().getHours();
  const greeting = h < 12 ? t("Καλημέρα", "Good morning") : h < 18 ? t("Καλησπέρα", "Good afternoon") : t("Καλό βράδυ", "Good evening");
  const dateLabel = new Date().toLocaleDateString(t("el-GR", "en-GB"), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const list = (sort: string) => router.push(`/cy/dispensings?sort=${sort}`);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{greeting}! 👋</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Επισκόπηση φαρμακείου", "Pharmacy overview")} · {dateLabel}
            {o?.last_import ? ` · ${t("τελευταία εισαγωγή", "last import")} ${fmtDateTime(o.last_import)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter />
          <Link href="/cy/import" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
            <FileUp className="h-4 w-4" /> {t("Εισαγωγή XML", "Import XML")}
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard label={t("Εκτελέσεις", "Dispensings")} value={fmtNum(s?.executions ?? 0)} icon={Receipt} accent="indigo"
          sub={`${fmtNum(s?.prescriptions ?? 0)} ${t("συνταγές · δες λίστα", "prescriptions · see list")}`} trend={pctDelta(s?.executions, p?.executions)}
          help={t("Εκτελέσεις ΓεΣΥ με ημερομηνία μέσα στην περίοδο του φίλτρου. Μία συνταγή με πολλές φάσεις μετρά μία εκτέλεση ανά φάση.", "GHS dispensings dated within the selected period. A prescription with several steps counts one dispensing per step.")}
          onClick={() => list("dispensed_at")} />
        <KpiCard label={t("Αξία εκτελέσεων", "Dispensed value")} value={eur0(s?.value ?? 0)} icon={BarIcon} accent="violet"
          sub={t("σύνολο περιόδου · δες λίστα", "period total · see list")} trend={pctDelta(s?.value, p?.value)}
          help={t("Άθροισμα της συνολικής αξίας (ΟΑΥ + πελάτης) όλων των εκτελέσεων της περιόδου.", "Sum of total value (HIO + customer) of all dispensings in the period.")}
          onClick={() => list("total")} />
        <KpiCard label={t("Απαίτηση από ΟΑΥ", "Claim to HIO")} value={eur0(s?.hio ?? 0)} icon={Wallet} accent="amber"
          sub={t("όσα πληρώνει ο ΟΑΥ · δες λίστα", "paid by the HIO · see list")} trend={pctDelta(s?.hio, p?.hio)}
          help={t("Το μέρος της αξίας που απαιτείται από τον ΟΑΥ.", "The part of the value claimed from the HIO.")}
          onClick={() => list("hio")} />
        <KpiCard label={t("Πληρωμή πελατών", "Paid by customers")} value={eur0(s?.beneficiary ?? 0)} icon={HandCoins} accent="green"
          sub={`PC2 ${eur0(s?.pc2 ?? 0)}`} trend={pctDelta(s?.beneficiary, p?.beneficiary)}
          help={t("Συμμετοχή + διαφορά τιμής (PC2) που πλήρωσαν οι πελάτες στο ταμείο.", "Co-payment + price difference (PC2) paid by customers at the till.")}
          onClick={() => list("beneficiary")} />
        <KpiCard label={t("Πελάτες", "Customers")} value={fmtNum(s?.patient_count ?? 0)} icon={Users} accent="sky"
          sub={t("μοναδικοί · δες λίστα", "unique · see list")} trend={pctDelta(s?.patient_count, p?.patient_count)}
          help={t("Μοναδικοί πελάτες με τουλάχιστον μία εκτέλεση στην περίοδο.", "Unique customers with at least one dispensing in the period.")}
          onClick={() => router.push("/cy/patients")} />
      </div>

      {/* Μόνο Κύπρος: συνέχεια συνταγών */}
      {o && (
        <div className="mt-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Tile href="/cy/open" label={t("Ανοιχτές συνταγές", "Open prescriptions")} value={fmtNum(o.open_prescriptions)}
            hint={`${fmtNum(o.chains.soon)} ${t("σύντομα", "soon")} · ${fmtNum(o.chains.late)} ${t("καθυστερούν", "late")}`} />
          <Tile href="/cy/lost" label={t("Χαμένοι πελάτες", "Lost customers")} value={`${fmtNum(o.lost_customers.lost)} + ${fmtNum(o.lost_customers.leak)}`}
            hint={`${fmtEur(o.lost_customers.monthly_value_cents)} ${t("τον μήνα", "per month")}`} tone="rose" />
          <Tile href="/cy/open?status=lost" label={t("Συνταγές που χάθηκαν", "Lost prescriptions")} value={fmtNum(o.chains.lost)}
            hint={t("δεν συνεχίστηκαν εδώ", "not continued here")} tone="rose" />
          <Tile href="/cy/not-dispensed" label={t("Είδη που δεν δόθηκαν", "Items not dispensed")} value={fmtNum(o.lines_not_dispensed)}
            hint={t("έλλειψη ή χαμένη πώληση", "stock-out or lost sale")} tone="amber" />
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Πορεία αξίας & απαίτησης ΟΑΥ", "Value & HIO claim trend")} className="lg:col-span-2">
          <LineChart labels={labels} height={300} colors={["#ef4444", "#10b981"]} series={[
            { name: t("Αξία (€)", "Value (€)"), data: (tsVal.data ?? []).map((b) => Math.round(b.value / 100)) },
            { name: t("ΟΑΥ (€)", "HIO (€)"), data: (tsHio.data ?? []).map((b) => Math.round(b.value / 100)) },
          ]} />
        </PanelCard>
        <PanelCard title={t("Ανάλυση ανά σκεύασμα (αξία)", "Breakdown by product (value)")}>
          <DonutChart height={300} data={(topProd.data ?? []).map((d) => ({ name: d.name || "—", value: Math.round(d.value / 100) }))} />
        </PanelCard>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PanelCard title={t("Top Ιατροί (αξία)", "Top Doctors (value)")} className="lg:col-span-2">
          <BarChart horizontal height={300} name="€"
            labels={(topDoc.data ?? []).map((d) => d.name || "—")}
            data={(topDoc.data ?? []).map((d) => Math.round(d.value / 100))} />
        </PanelCard>
        <PanelCard title={t("Πρόσφατες εκτελέσεις", "Recent dispensings")} bodyClassName="pt-2">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(recent.data?.items ?? []).map((r) => (
              <li key={r.dispensing_id}>
                <Link href={`/cy/dispensings/${encodeURIComponent(r.dispensing_id)}`} className="flex items-center justify-between py-3 hover:opacity-80">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-600">
                        {r.kind === "drug" ? t("Φάρμακα", "Drugs") : t("Αναλώσιμα", "Consumables")} {r.instance}/{r.instances}
                      </span>
                      <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{r.patient_name || "—"}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">{fmtDate(r.dispensed_at)}</div>
                  </div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmtEur(r.totals.total)}</div>
                </Link>
              </li>
            ))}
            {!recent.isLoading && (recent.data?.items?.length ?? 0) === 0 && (
              <li className="py-8 text-center text-sm text-slate-400">{t("Καμία εκτέλεση στην περίοδο.", "No dispensings in the period.")}</li>
            )}
          </ul>
        </PanelCard>
      </div>

      <div className="mt-4">
        <PanelCard title={t("Ώρες αιχμής, μοτίβο εβδομάδας (όλη η περίοδος)", "Peak hours, weekly pattern (whole period)")}>
          <p className="-mt-1 mb-3 text-xs text-slate-400">
            {t("Όλες οι Δευτέρες της περιόδου αθροίζονται μαζί, όλες οι Τρίτες μαζί κ.λπ. Δείχνει το τυπικό μοτίβο της εβδομάδας, όχι μία συγκεκριμένη εβδομάδα. Ώρα Κύπρου.",
              "All Mondays in the period are summed together, all Tuesdays together, etc. Shows the typical weekly pattern, not one specific week. Cyprus time.")}
          </p>
          <HeatmapChart cells={heatCells} />
        </PanelCard>
      </div>

      <div className="mt-4">
        <PanelCard title={t("Ημερολόγιο αιχμής, εκτελέσεις ανά ημερομηνία", "Peak calendar, dispensings per date")}>
          <CalendarHeatmap data={calendarData} height={Math.max(180, calendarWeeks * 18 + 80)} />
        </PanelCard>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href: string; tone?: "rose" | "amber" }) {
  const c = tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-600" : "text-slate-900 dark:text-slate-100";
  return (
    <Link href={href} className="rx-card block p-4 transition hover:shadow-lg hover:ring-1 hover:ring-brand-200">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${c}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </Link>
  );
}
