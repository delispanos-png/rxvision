"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Receipt, Wallet, Pill, AlertTriangle, Search, Download, HeartPulse, Stethoscope } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { Tooltip } from "@/components/ui/Tooltip";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { prevYearRange, pctDelta } from "@/lib/compare";
import { fmtEur, fmtNum, fmtDate, fmtDateTime, fmtMoney} from "@/lib/formatters";
import { downloadCsv } from "@/lib/csv";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { MultiSelect } from "@/components/filters/MultiSelect";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportMenu } from "@/components/export/ExportMenu";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/prefStore";

type T = (el: string, en: string) => string;

type Prescription = {
  external_id: string;
  executed_at: string;
  source: string;
  icd10: string[];
  amount_total: number; // cents
  amount_claimed: number; // cents
  has_unexecuted_substances: boolean;
  patient_share?: number; // cents — αιτούμενο/πληρωτέο από ασφαλισμένο
  patient_name?: string | null;
  amka?: string | null;
  fund_name?: string | null;
  fund_general?: string | null; // γενική ονομασία ταμείου (group, π.χ. ΕΟΠΥΥ)
  icd10_named?: string[];       // «κωδικός — τίτλος»
  status?: string | null;
  chronic?: boolean | null;
};

const statusEl = (t: T): Record<string, string> => ({ executed: t("Εκτελεσμένη", "Executed"), partial: t("Μερικώς", "Partial"), cancelled: t("Ακυρωμένη", "Cancelled") });
const categoryEl = (t: T): Record<string, string> => ({
  normal: t("Κανονικό", "Normal"), narcotic: t("Ναρκωτικό", "Narcotic"), fyk: "ΦΥΚ", vaccine: t("Εμβόλιο", "Vaccine"), allergen: t("Αλλεργιογόνο", "Allergen"), special: t("Ειδικό", "Special"),
});

type UnexecutedRow = {
  product_id: string;
  name: string;
  category: string;
  occurrences: number;
  qty: number;
  lost_value: number; // cents
  barcodes?: string[];
  rxs?: { barcode: string; patient?: string | null; date?: string | null }[];
};

type FundRow = { fund_name: string; rx: number; value: number; claimed: number; unexecuted: number; is_group?: boolean; funds?: { fund_name: string }[] };
type FundMetric = "rx" | "value" | "claimed" | "unexecuted";
const makeFundCols = (t: T): Column<FundRow>[] => [
  {
    key: "fund_name", header: t("Ταμείο / Ομάδα", "Fund / Group"),
    render: (r) => (
      <span className="inline-flex items-center gap-2">
        {r.fund_name || "—"}
        {r.is_group && <Tooltip label={(r.funds ?? []).map((f) => f.fund_name).join(", ")}><span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">{t("ομάδα", "group")} · {r.funds?.length}</span></Tooltip>}
      </span>
    ),
  },
  { key: "rx", header: t("Συνταγές", "Prescriptions"), align: "right", render: (r) => fmtNum(r.rx), sortValue: (r) => r.rx },
  { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
  { key: "claimed", header: t("Αιτούμενο", "Claimed"), align: "right", render: (r) => fmtEur(r.claimed), sortValue: (r) => r.claimed },
  { key: "unexecuted", header: t("Ανεκτέλεστες", "Unexecuted"), align: "right", render: (r) => fmtNum(r.unexecuted), sortValue: (r) => r.unexecuted },
];

function BarcodeChip({ bc, patient, date }: { bc: string; patient?: string | null; date?: string | null }) {
  const info = [patient || "", date ? fmtDateTime(date) : ""].filter(Boolean).join(" · ");
  return (
    <Tooltip label={info}>
      <span className="cursor-default rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-200">
        {bc}
      </span>
    </Tooltip>
  );
}

// Compact ICD-10 χαρακτηρισμός + κοινό hover «μήνυμα» (Tooltip): όλες οι διαγνώσεις, μία/γραμμή.
function DxBubble({ dx, label, title }: { dx: string[]; label: string; title: string }) {
  return (
    <Tooltip lines={dx} title={title}>
      <span className="inline-flex max-w-[12rem] cursor-help items-center gap-1 truncate rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
        <Stethoscope className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </Tooltip>
  );
}

const makeColumns = (t: T): Column<Prescription>[] => {
  const STATUS_EL = statusEl(t);
  return [
  { key: "executed_at", header: t("Ημ/νία", "Date/time"), render: (r) => fmtDateTime(r.executed_at) },
  { key: "barcode", header: "Barcode", sortValue: (r) => r.external_id, render: (r) => (
    <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
      {r.chronic ? <Tooltip label={t("Χρόνια αγωγή", "Chronic therapy")}><HeartPulse className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t("Χρόνια αγωγή", "Chronic therapy")} /></Tooltip> : null}
      {r.external_id.split(":")[0]}
    </span>
  ) },
  { key: "execno", header: t("Εκτ.", "Exec"), align: "right", sortable: false, render: (r) => r.external_id.split(":")[1] || "1" },
  { key: "patient_name", header: t("Ασθενής", "Patient"), sortable: false, render: (r) => r.patient_name || "—" },
  { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, sortable: false, render: (r) => r.amka ? (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">{r.amka}<CopyButton value={r.amka} /></span>
  ) : "—" },
  { key: "fund_general", header: t("Ταμείο", "Fund"), hideOnMobile: true, sortable: false, render: (r) => r.fund_general || r.fund_name || "—" },
  {
    key: "status", header: t("Κατάσταση", "Status"), hideOnMobile: true, sortable: false,
    render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.has_unexecuted_substances ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
        {r.has_unexecuted_substances ? t("Μερικώς", "Partial") : STATUS_EL[r.status || "executed"] || t("Εκτελεσμένη", "Executed")}
      </span>
    ),
  },
  { key: "icd10", header: t("Διάγνωση", "Diagnosis"), hideOnMobile: true, sortable: false, render: (r) => {
    const dx = r.icd10_named ?? r.icd10 ?? [];
    if (!dx.length) return <span className="text-slate-300">—</span>;
    // ΠΑΝΤΑ ο αριθμός των διαγνώσεων (ομοιόμορφα) — οι αναλυτικές στο hover-bubble.
    const label = `${dx.length} ${dx.length === 1 ? t("διάγνωση", "diagnosis") : t("διαγνώσεις", "diagnoses")}`;
    return <DxBubble dx={dx} label={label} title={t("Διαγνώσεις", "Diagnoses")} />;
  } },
  { key: "amount_total", header: t("Αξία", "Value"), align: "right", render: (r) => fmtEur(r.amount_total) },
  { key: "patient_share", header: t("Από ασφ/νο", "From patient"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.patient_share ?? 0) },
  { key: "amount_claimed", header: t("Από ταμείο", "From fund"), align: "right", render: (r) => fmtEur(r.amount_claimed) },
  ];
};

const makeUnexecutedColumns = (t: T): Column<UnexecutedRow>[] => {
  const CATEGORY_EL = categoryEl(t);
  return [
  { key: "name", header: t("Σκεύασμα", "Product"), render: (r) => r.name ?? r.product_id },
  { key: "category", header: t("Κατηγορία", "Category"), hideOnMobile: true, render: (r) => CATEGORY_EL[r.category] || r.category || "—" },
  {
    key: "barcodes", header: t("Από συνταγή", "From prescription"),
    render: (r) => {
      const rxs: { barcode: string; patient?: string | null; date?: string | null }[] =
        r.rxs ?? (r.barcodes ?? []).map((b) => ({ barcode: b }));
      return (
        <div className="flex flex-wrap gap-1.5">
          {rxs.slice(0, 4).map((x) => <BarcodeChip key={x.barcode} bc={x.barcode} patient={x.patient} date={x.date} />)}
          {rxs.length > 4 && <span className="text-xs text-slate-400">+{rxs.length - 4}</span>}
          {!rxs.length && <span className="text-slate-300">—</span>}
        </div>
      );
    },
  },
  { key: "occurrences", header: t("Φορές", "Times"), align: "right", render: (r) => fmtNum(r.occurrences) },
  { key: "lost_value", header: t("Χαμένη αξία", "Lost value"), align: "right", render: (r) => fmtEur(r.lost_value) },
  ];
};

export default function PrescriptionsPage() {
  const t = useT();
  const STATUS_EL = statusEl(t);
  const columns = makeColumns(t);
  const unexecutedColumns = makeUnexecutedColumns(t);
  const fundCols = makeFundCols(t);
  const router = useRouter();
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [barcode, setBarcode] = useState("");
  const [amka, setAmka] = useState("");
  const [patientName, setPatientName] = useState("");
  const [status, setStatus] = useState("");           // "" | executed | partial
  const [chars, setChars] = useState<string[]>([]);   // πολλαπλά χαρακτηριστικά (AND)
  const bc = barcode.trim();
  // φίλτρα λίστας (πέρα από το κοινό date/fund/doctor/icd10) — αγνοούν περίοδο όταν ψάχνεις barcode/ΑΜΚΑ/όνομα
  const extra = [
    bc && `barcode=${encodeURIComponent(bc)}`,
    amka.trim() && `amka=${encodeURIComponent(amka.trim())}`,
    patientName.trim() && `patient=${encodeURIComponent(patientName.trim())}`,
    status && `status=${status}`,
    chars.length && `characteristic=${encodeURIComponent(chars.join(","))}`,
  ].filter(Boolean).join("&");
  const listQs = extra ? `${q}&${extra}` : q;
  const anyFilter = !!(bc || amka.trim() || patientName.trim() || status || chars.length);
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "executed_at", dir: -1 });
  const SERVER_SORTS = new Set(["executed_at", "external_id", "amount_total", "amount_claimed"]);
  const onServerSort = (key: string) => {
    if (!SERVER_SORTS.has(key)) return;
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: -1 }));
    setPage(1);
  };
  // reset to page 1 whenever the filters/search change
  useEffect(() => { setPage(1); }, [listQs]);

  const list = useQuery({
    queryKey: ["prescriptions", "list", listQs, page, sort.key, sort.dir],
    queryFn: () => api<{ items: Prescription[] }>(`/prescriptions?${listQs}&page=${page}&page_size=${PAGE_SIZE}&sort=${sort.key}&dir=${sort.dir}`),
  });

  const unexecuted = useQuery({
    queryKey: ["prescriptions", "unexecuted", q],
    queryFn: () =>
      api<{ items: UnexecutedRow[]; total_occurrences: number; total_lost_value: number }>(
        `/prescriptions/unexecuted?${q}`,
      ),
  });

  const [fundModal, setFundModal] = useState<{ title: string; metric: FundMetric } | null>(null);
  const [unexecModal, setUnexecModal] = useState<UnexecutedRow | null>(null);
  // always-on: also powers the period-total KPIs (sum across funds), not just the popup
  const byFund = useQuery({
    queryKey: ["prescriptions", "by-fund", q],
    queryFn: () => api<{ items: FundRow[] }>(`/prescriptions/by-fund?${q}`),
  });
  const pr = prevYearRange(filters.dateFrom, filters.dateTo);
  const prevFund = useQuery({
    queryKey: ["prescriptions", "by-fund", "prevYear", pr?.from, pr?.to],
    queryFn: () => api<{ items: FundRow[] }>(`/prescriptions/by-fund?${filtersToQuery({ ...filters, dateFrom: pr!.from, dateTo: pr!.to })}`),
    enabled: !!pr,
  });
  const fundData = byFund.data?.items ?? [];
  const fundMetric = fundModal?.metric ?? "value";
  const fundRows = [...fundData].sort((a, b) => (b[fundMetric] as number) - (a[fundMetric] as number));

  const items = list.data?.items ?? [];
  const un = unexecuted.data;
  const unRows = un?.items ?? [];

  // period totals (whole date range), summed across funds — NOT the visible page
  const totalRx = fundData.reduce((a, f) => a + f.rx, 0);
  const totalValue = fundData.reduce((a, f) => a + f.value, 0);
  const totalClaimed = fundData.reduce((a, f) => a + f.claimed, 0);
  const unexecutedCount = fundData.reduce((a, f) => a + f.unexecuted, 0);
  // πέρσι, ίδια περίοδος → Δ
  const pf = prevFund.data?.items ?? [];
  const pRx = pf.reduce((a, f) => a + f.rx, 0), pValue = pf.reduce((a, f) => a + f.value, 0);
  const pClaimed = pf.reduce((a, f) => a + f.claimed, 0), pUnexec = pf.reduce((a, f) => a + f.unexecuted, 0);
  const hasPrev = !!prevFund.data;

  return (
    <ModuleGuard module="prescription_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("Συνταγές", "Prescriptions")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Εκτελέσεις & ανεκτέλεστες δραστικές της περιόδου", "Executions & unexecuted substances for the period")}</p>
        </div>
        <ExportMenu<Prescription> filename="syntages" title={t("Συνταγές — εκτελέσεις περιόδου", "Prescriptions — executions for the period")}
          columns={[
            { key: "executed_at", header: t("Ημ/νία", "Date"), value: (r) => fmtDate(r.executed_at) },
            { key: "external_id", header: t("Κωδικός", "Code") },
            { key: "patient_name", header: t("Ασθενής", "Patient"), value: (r) => r.patient_name || "—" },
            { key: "amka", header: "ΑΜΚΑ", value: (r) => r.amka || "—" },
            { key: "fund_name", header: t("Ταμείο", "Fund"), value: (r) => r.fund_name || "—" },
            { key: "status", header: t("Κατάσταση", "Status"), value: (r) => STATUS_EL[r.status ?? ""] || r.status || "—" },
            { key: "amount_total", header: t("Αξία (€)", "Value (€)"), value: (r) => fmtMoney((r.amount_total || 0)) },
            { key: "amount_claimed", header: t("Από ταμείο (€)", "From fund (€)"), value: (r) => fmtMoney((r.amount_claimed || 0)) },
          ]}
          fetchRows={async () => {
            const all: Prescription[] = [];
            for (let p = 1; p <= 30; p++) {
              const r = await api<{ items: Prescription[] }>(`/prescriptions?${q}&page=${p}&page_size=500&sort=executed_at&dir=-1`);
              all.push(...r.items);
              if (r.items.length < 500) break;
            }
            return all;
          }} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateRangeFilter />
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t("Αναζήτηση barcode", "Search barcode")}</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder={t("π.χ. 2606022236114", "e.g. 2606022236114")}
              inputMode="numeric"
              className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm text-slate-900 focus:border-brand-500 focus:outline-none sm:w-48"
            />
          </div>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">ΑΜΚΑ</span>
          <input value={amka} onChange={(e) => setAmka(e.target.value)} placeholder={t("π.χ. 01017…", "e.g. 01017…")} inputMode="numeric"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none sm:w-40" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t("Όνομα ασθενή", "Patient name")}</span>
          <input value={patientName} onChange={(e) => setPatientName(e.target.value)} placeholder={t("π.χ. ΠΑΠΑΔΟΠΟΥΛΟΣ", "e.g. surname")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none sm:w-48" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t("Κατάσταση", "Status")}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none">
            <option value="">{t("Όλες", "All")}</option>
            <option value="executed">{t("Εκτελεσμένες", "Executed")}</option>
            <option value="partial">{t("Μερικώς", "Partial")}</option>
          </select>
        </label>
        <MultiSelect
          label={t("Χαρακτηριστικά", "Characteristics")}
          allLabel={t("Όλα", "All")}
          selectedLabel={(n) => t(`${n} επιλεγμένα`, `${n} selected`)}
          clearLabel={t("Καθαρισμός", "Clear")}
          selected={chars}
          onChange={setChars}
          groups={[
            { title: t("Χαρακτηριστικά", "Characteristics"), options: [
              { value: "chronic", label: t("Χρόνια αγωγή", "Chronic") },
              { value: "high_cost", label: t("Υψηλού κόστους", "High cost") },
              { value: "narcotic", label: t("Ναρκωτικό", "Narcotic") },
              { value: "antibiotic", label: t("Αντιβιοτικό", "Antibiotic") },
              { value: "special_antibiotic", label: t("Ειδικό αντιβιοτικό", "Special antibiotic") },
              { value: "n3816", label: t("Νόμος 3816 (ΦΥΚ)", "Law 3816") },
              { value: "ifet", label: "ΙΦΕΤ" },
              { value: "heparin", label: t("Ηπαρίνη", "Heparin") },
              { value: "vaccines", label: t("Εμβόλιο", "Vaccine") },
              { value: "desensitization", label: t("Εμβόλιο απευαισθ.", "Desensitization") },
              { value: "single_dose", label: t("Μονοδοσιακό", "Single-dose") },
              { value: "by_brand", label: t("Εμπορική ονομασία", "By brand") },
              { value: "ekas", label: "ΕΚΑΣ" },
              { value: "eopyy_only", label: t("Μόνο φαρμακεία ΕΟΠΥΥ", "EOPYY pharmacies only") },
              { value: "hospital_only", label: t("Μόνο νοσοκομεία", "Hospitals only") },
              { value: "eopyy_preapproval", label: t("Απαιτεί προέγκριση", "Pre-approval") },
              { value: "outside_eopyy", label: t("Εκτός φαρμ. κόστους", "Outside EOPYY cost") },
              { value: "negative_list", label: t("Αρνητική λίστα", "Negative list") },
              { value: "home_delivery", label: t("Κατ' οίκον", "Home delivery") },
              { value: "intangible", label: t("Άυλη", "Intangible") },
            ] },
            { title: t("Διάρκεια", "Duration"), options: [
              { value: "monthly", label: t("Μηνιαία", "Monthly") },
              { value: "bimonthly", label: t("Δίμηνη", "Bimonthly") },
            ] },
            { title: t("Επαναληψιμότητα", "Repeatability"), options: [
              { value: "simple", label: t("Απλή", "Simple") },
              { value: "repeat", label: t("Επαναλαμβανόμενη", "Repeating") },
              { value: "3", label: t("Τρίμηνη", "3-month") },
              { value: "4", label: t("Τετράμηνη", "4-month") },
              { value: "5", label: t("Πεντάμηνη", "5-month") },
              { value: "6", label: t("Εξάμηνη", "6-month") },
            ] },
          ]}
        />
        {anyFilter && (
          <button onClick={() => { setBarcode(""); setAmka(""); setPatientName(""); setStatus(""); setChars([]); }}
            className="mb-0.5 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            × {t("Καθαρισμός", "Clear")}
          </button>
        )}
        {(bc || amka.trim() || patientName.trim()) && <span className="pb-2 text-xs text-slate-400">{t("Αναζήτηση σε όλη την περίοδο", "Search across the whole period")}</span>}
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label={t("Συνταγές", "Prescriptions")} value={fmtNum(totalRx)} sub={t("σύνολο περιόδου · ανά ταμείο →", "period total · by fund →")} icon={Receipt} accent="indigo" trend={hasPrev ? pctDelta(totalRx, pRx) : undefined}
            onClick={() => setFundModal({ title: t("Συνταγές ανά ταμείο", "Prescriptions by fund"), metric: "rx" })} />
          <KpiCard label={t("Αξία συνταγών", "Prescriptions value")} value={fmtEur(totalValue)} sub={t("σύνολο περιόδου · ανά ταμείο →", "period total · by fund →")} icon={Wallet} accent="violet" trend={hasPrev ? pctDelta(totalValue, pValue) : undefined}
            onClick={() => setFundModal({ title: t("Αξία συνταγών ανά ταμείο", "Prescriptions value by fund"), metric: "value" })} />
          <KpiCard label={t("Αιτούμενα ταμείων", "Funds claimed")} value={fmtEur(totalClaimed)} sub={t("προς ασφ. φορείς · ανά ταμείο →", "to insurance funds · by fund →")} icon={Pill} accent="amber" trend={hasPrev ? pctDelta(totalClaimed, pClaimed) : undefined}
            onClick={() => setFundModal({ title: t("Αιτούμενο ανά ταμείο", "Claimed by fund"), metric: "claimed" })} />
          <KpiCard
            label={t("Με ανεκτέλεστα", "With unexecuted")}
            value={fmtNum(unexecutedCount)}
            sub={t(`χαμένη αξία ${fmtEur(un?.total_lost_value ?? 0)} · ανά ταμείο →`, `lost value ${fmtEur(un?.total_lost_value ?? 0)} · by fund →`)}
            icon={AlertTriangle}
            accent="rose"
            trend={hasPrev ? pctDelta(unexecutedCount, pUnexec) : undefined}
            onClick={() => setFundModal({ title: t("Ανεκτέλεστες ανά ταμείο", "Unexecuted by fund"), metric: "unexecuted" })}
          />
        </div>

        {/* unexecuted chart */}
        {unRows.length > 0 && (
          <PanelCard
            collapsible
            defaultOpen={false}
            title={t("Ανεκτέλεστες δραστικές", "Unexecuted substances")}
            action={
              <div className="flex gap-4 text-sm">
                <span className="text-slate-500">
                  {t("Σύνολο", "Total")}: <b className="text-slate-800">{fmtNum(un?.total_occurrences ?? 0)}</b>
                </span>
                <span className="text-slate-500">
                  {t("Χαμένη αξία", "Lost value")}: <b className="text-amber-600">{fmtEur(un?.total_lost_value ?? 0)}</b>
                </span>
              </div>
            }
          >
            <BarChart
              labels={unRows.slice(0, 10).map((r) => r.name ?? r.product_id)}
              data={unRows.slice(0, 10).map((r) => r.occurrences)}
              name={t("Φορές", "Times")}
              horizontal
              height={Math.max(220, unRows.slice(0, 10).length * 38)}
            />
          </PanelCard>
        )}

        {/* unexecuted table */}
        <PanelCard collapsible defaultOpen={false} title={t("Ανεκτέλεστες δραστικές — αναλυτικά", "Unexecuted substances — details")} bodyClassName="pt-2">
          <DataTable
            columns={unexecutedColumns}
            rows={unRows}
            rowKey={(r) => r.product_id}
            onRowClick={(r) => setUnexecModal(r)}
            empty={t("Καμία ανεκτέλεστη δραστική στην περίοδο.", "No unexecuted substances in the period.")}
          />
        </PanelCard>

        {/* recent prescriptions table */}
        <PanelCard title={t("Πρόσφατες εκτελέσεις", "Recent executions")} bodyClassName="pt-2">
          <QueryState
            isLoading={list.isLoading}
            isError={list.isError}
            isEmpty={items.length === 0}
            onRetry={() => list.refetch()}
            empty={t("Δεν υπάρχουν εκτελέσεις στην περίοδο.", "No executions in the period.")}
          >
            <DataTable columns={columns} rows={items} rowKey={(r) => r.external_id}
              serverSort={{ key: sort.key, dir: sort.dir === 1 ? "asc" : "desc" }}
              onServerSort={onServerSort}
              onRowClick={(r) => router.push(`/prescriptions/${encodeURIComponent(r.external_id)}`)} />
          </QueryState>
          {/* pagination */}
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-500">
              {t("Σελίδα", "Page")} {page}{items.length ? t(` · εγγραφές ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + items.length}`, ` · records ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + items.length}`) : ""}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || list.isFetching}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >← {t("Προηγούμενη", "Previous")}</button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={items.length < PAGE_SIZE || list.isFetching}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >{t("Επόμενη", "Next")} →</button>
            </div>
          </div>
        </PanelCard>
      </div>

      {/* per-fund breakdown popup (clickable KPIs) */}
      <Modal open={!!fundModal} onClose={() => setFundModal(null)} title={fundModal?.title} size="2xl">
        <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-500">{t("Σύνολο περιόδου", "Period total")} · {fundRows.length} {t("ταμεία", "funds")}</p>
          {fundRows.length > 0 && (
            <button
              onClick={() => downloadCsv("ana-tameio", [
                { key: "fund_name", header: t("Ταμείο", "Fund") },
                { key: "rx", header: t("Συνταγές", "Prescriptions") },
                { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r: FundRow) => fmtMoney(r.value) },
                { key: "claimed", header: t("Αιτούμενο (€)", "Claimed (€)"), value: (r: FundRow) => fmtMoney(r.claimed) },
                { key: "unexecuted", header: t("Ανεκτέλεστες", "Unexecuted") },
              ], fundRows)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> {t("Εξαγωγή CSV", "Export CSV")}
            </button>
          )}
        </div>
        <QueryState isLoading={byFund.isLoading} isError={byFund.isError}
          isEmpty={fundRows.length === 0} onRetry={() => byFund.refetch()} empty={t("Καμία εγγραφή.", "No records.")}>
          <DataTable pageSize={20} columns={fundCols} rows={fundRows} rowKey={(r) => r.fund_name} />
        </QueryState>
      </Modal>

      {/* all prescriptions for a clicked unexecuted item */}
      <Modal open={!!unexecModal} onClose={() => setUnexecModal(null)} title={unexecModal ? t(`${unexecModal.name} — όλες οι συνταγές`, `${unexecModal.name} — all prescriptions`) : ""} size="2xl">
        {unexecModal && (() => {
          const rxs = unexecModal.rxs ?? (unexecModal.barcodes ?? []).map((b) => ({ barcode: b, patient: null, date: null }));
          return (
            <>
              <div className="-mt-2 mb-3 text-sm text-slate-500">
                {unexecModal.occurrences} {t("φορές ανεκτέλεστο", "times unexecuted")} · {rxs.length} {t("συνταγές", "prescriptions")} · {t("χαμένη αξία", "lost value")} <b className="text-amber-600">{fmtEur(unexecModal.lost_value)}</b>
              </div>
              <div className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                {rxs.map((x, i) => (
                  <button key={`${x.barcode}-${i}`} onClick={() => { setUnexecModal(null); router.push(`/prescriptions/${encodeURIComponent(x.barcode)}`); }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                    <span className="font-mono text-brand-700 dark:text-brand-300">{x.barcode}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">{x.patient || "—"}</span>
                    <span className="shrink-0 text-xs text-slate-400">{x.date ? fmtDate(x.date) : ""}</span>
                  </button>
                ))}
              </div>
            </>
          );
        })()}
      </Modal>
    </ModuleGuard>
  );
}
