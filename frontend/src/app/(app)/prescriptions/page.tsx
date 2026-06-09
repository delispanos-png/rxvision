"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Receipt, Wallet, Pill, AlertTriangle, Search, Download } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { useUiStore, filtersToQuery } from "@/store/uiStore";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { downloadCsv } from "@/lib/csv";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { ExportButton } from "@/components/export/ExportButton";
import { KpiCard } from "@/components/kpi/KpiCard";
import { PanelCard } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/QueryState";
import { Modal } from "@/components/ui/Modal";

type Prescription = {
  external_id: string;
  executed_at: string;
  source: string;
  icd10: string[];
  amount_total: number; // cents
  amount_claimed: number; // cents
  has_unexecuted_substances: boolean;
  patient_name?: string | null;
  amka?: string | null;
  fund_name?: string | null;
  status?: string | null;
};

const STATUS_EL: Record<string, string> = { executed: "Εκτελεσμένη", partial: "Μερικώς", cancelled: "Ακυρωμένη" };
const CATEGORY_EL: Record<string, string> = {
  normal: "Κανονικό", narcotic: "Ναρκωτικό", fyk: "ΦΥΚ", vaccine: "Εμβόλιο", allergen: "Αλλεργιογόνο", special: "Ειδικό",
};

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
const fundCols: Column<FundRow>[] = [
  {
    key: "fund_name", header: "Ταμείο / Ομάδα",
    render: (r) => (
      <span className="inline-flex items-center gap-2">
        {r.fund_name || "—"}
        {r.is_group && <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700" title={(r.funds ?? []).map((f) => f.fund_name).join(", ")}>ομάδα · {r.funds?.length}</span>}
      </span>
    ),
  },
  { key: "rx", header: "Συνταγές", align: "right", render: (r) => fmtNum(r.rx), sortValue: (r) => r.rx },
  { key: "value", header: "Αξία", align: "right", render: (r) => fmtEur(r.value), sortValue: (r) => r.value },
  { key: "claimed", header: "Αιτούμενο", align: "right", render: (r) => fmtEur(r.claimed), sortValue: (r) => r.claimed },
  { key: "unexecuted", header: "Ανεκτέλεστες", align: "right", render: (r) => fmtNum(r.unexecuted), sortValue: (r) => r.unexecuted },
];

function BarcodeChip({ bc, patient, date }: { bc: string; patient?: string | null; date?: string | null }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const info = [patient || "", date ? new Date(date).toLocaleString("el-GR", { dateStyle: "medium", timeStyle: "short" }) : ""].filter(Boolean).join(" · ");
  const onEnter = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) { setPos({ x: r.left + r.width / 2, y: r.top }); setShow(true); }
  };
  return (
    <span
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={() => setShow(false)}
      className="cursor-default rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-200"
    >
      {bc}
      {show && info && typeof document !== "undefined" && createPortal(
        <div
          style={{ position: "fixed", left: pos.x, top: pos.y - 10, transform: "translate(-50%, -100%)", zIndex: 9999 }}
          className="pointer-events-none whitespace-nowrap rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white shadow-2xl"
        >
          {info}
          <span className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
        </div>,
        document.body,
      )}
    </span>
  );
}

const columns: Column<Prescription>[] = [
  { key: "executed_at", header: "Ημ/νία", render: (r) => fmtDate(r.executed_at) },
  { key: "external_id", header: "Κωδικός" },
  { key: "patient_name", header: "Ασθενής", sortable: false, render: (r) => r.patient_name || "—" },
  { key: "amka", header: "ΑΜΚΑ", hideOnMobile: true, sortable: false, render: (r) => r.amka || "—" },
  { key: "fund_name", header: "Ταμείο", hideOnMobile: true, sortable: false, render: (r) => r.fund_name || "—" },
  {
    key: "status", header: "Κατάσταση", hideOnMobile: true, sortable: false,
    render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.has_unexecuted_substances ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
        {r.has_unexecuted_substances ? "Μερικώς" : STATUS_EL[r.status || "executed"] || "Εκτελεσμένη"}
      </span>
    ),
  },
  { key: "icd10", header: "ICD-10", hideOnMobile: true, sortable: false, render: (r) => (r.icd10 ?? []).join(", ") },
  { key: "amount_total", header: "Αξία", align: "right", render: (r) => fmtEur(r.amount_total) },
  { key: "amount_claimed", header: "Από ταμείο", align: "right", render: (r) => fmtEur(r.amount_claimed) },
];

const unexecutedColumns: Column<UnexecutedRow>[] = [
  { key: "name", header: "Σκεύασμα", render: (r) => r.name ?? r.product_id },
  { key: "category", header: "Κατηγορία", hideOnMobile: true, render: (r) => CATEGORY_EL[r.category] || r.category || "—" },
  {
    key: "barcodes", header: "Από συνταγή",
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
  { key: "occurrences", header: "Φορές", align: "right", render: (r) => fmtNum(r.occurrences) },
  { key: "lost_value", header: "Χαμένη αξία", align: "right", render: (r) => fmtEur(r.lost_value) },
];

export default function PrescriptionsPage() {
  const router = useRouter();
  const filters = useUiStore();
  const q = filtersToQuery(filters);
  const [barcode, setBarcode] = useState("");
  const bc = barcode.trim();
  const listQs = bc ? `${q}&barcode=${encodeURIComponent(bc)}` : q;
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
  // always-on: also powers the period-total KPIs (sum across funds), not just the popup
  const byFund = useQuery({
    queryKey: ["prescriptions", "by-fund", q],
    queryFn: () => api<{ items: FundRow[] }>(`/prescriptions/by-fund?${q}`),
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

  return (
    <ModuleGuard module="prescription_analytics">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Συνταγές</h1>
          <p className="mt-1 text-sm text-slate-500">Εκτελέσεις & ανεκτέλεστες δραστικές της περιόδου</p>
        </div>
        <ExportButton path="/prescriptions" query={`?${q}`} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateRangeFilter />
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Αναζήτηση barcode</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="π.χ. 2606022236114"
              inputMode="numeric"
              className="w-56 rounded-lg border border-slate-300 py-2 pl-8 pr-8 text-sm text-slate-900 focus:border-brand-500 focus:outline-none"
            />
            {bc && (
              <button onClick={() => setBarcode("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" title="Καθαρισμός">×</button>
            )}
          </div>
        </label>
        {bc && <span className="pb-2 text-xs text-slate-400">Αναζήτηση σε όλη την περίοδο</span>}
      </div>

      <div className="space-y-4">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label="Συνταγές" value={fmtNum(totalRx)} sub="σύνολο περιόδου · ανά ταμείο →" icon={Receipt} accent="indigo"
            onClick={() => setFundModal({ title: "Συνταγές ανά ταμείο", metric: "rx" })} />
          <KpiCard label="Αξία συνταγών" value={fmtEur(totalValue)} sub="σύνολο περιόδου · ανά ταμείο →" icon={Wallet} accent="violet"
            onClick={() => setFundModal({ title: "Αξία συνταγών ανά ταμείο", metric: "value" })} />
          <KpiCard label="Αιτούμενα ταμείων" value={fmtEur(totalClaimed)} sub="προς ασφ. φορείς · ανά ταμείο →" icon={Pill} accent="amber"
            onClick={() => setFundModal({ title: "Αιτούμενο ανά ταμείο", metric: "claimed" })} />
          <KpiCard
            label="Με ανεκτέλεστα"
            value={fmtNum(unexecutedCount)}
            sub={`χαμένη αξία ${fmtEur(un?.total_lost_value ?? 0)} · ανά ταμείο →`}
            icon={AlertTriangle}
            accent="rose"
            onClick={() => setFundModal({ title: "Ανεκτέλεστες ανά ταμείο", metric: "unexecuted" })}
          />
        </div>

        {/* unexecuted chart */}
        {unRows.length > 0 && (
          <PanelCard
            title="Ανεκτέλεστες δραστικές"
            action={
              <div className="flex gap-4 text-sm">
                <span className="text-slate-500">
                  Σύνολο: <b className="text-slate-800">{fmtNum(un?.total_occurrences ?? 0)}</b>
                </span>
                <span className="text-slate-500">
                  Χαμένη αξία: <b className="text-amber-600">{fmtEur(un?.total_lost_value ?? 0)}</b>
                </span>
              </div>
            }
          >
            <BarChart
              labels={unRows.slice(0, 10).map((r) => r.name ?? r.product_id)}
              data={unRows.slice(0, 10).map((r) => r.occurrences)}
              name="Φορές"
              horizontal
              height={Math.max(220, unRows.slice(0, 10).length * 38)}
            />
          </PanelCard>
        )}

        {/* unexecuted table */}
        <PanelCard title="Ανεκτέλεστες δραστικές — αναλυτικά" bodyClassName="pt-2">
          <DataTable
            columns={unexecutedColumns}
            rows={unRows}
            rowKey={(r) => r.product_id}
            empty="Καμία ανεκτέλεστη δραστική στην περίοδο."
          />
        </PanelCard>

        {/* recent prescriptions table */}
        <PanelCard title="Πρόσφατες εκτελέσεις" bodyClassName="pt-2">
          <QueryState
            isLoading={list.isLoading}
            isError={list.isError}
            isEmpty={items.length === 0}
            onRetry={() => list.refetch()}
            empty="Δεν υπάρχουν εκτελέσεις στην περίοδο."
          >
            <DataTable columns={columns} rows={items} rowKey={(r) => r.external_id}
              serverSort={{ key: sort.key, dir: sort.dir === 1 ? "asc" : "desc" }}
              onServerSort={onServerSort}
              onRowClick={(r) => router.push(`/prescriptions/${encodeURIComponent(r.external_id)}`)} />
          </QueryState>
          {/* pagination */}
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-slate-500">
              Σελίδα {page}{items.length ? ` · εγγραφές ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + items.length}` : ""}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || list.isFetching}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >← Προηγούμενη</button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={items.length < PAGE_SIZE || list.isFetching}
                className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >Επόμενη →</button>
            </div>
          </div>
        </PanelCard>
      </div>

      {/* per-fund breakdown popup (clickable KPIs) */}
      <Modal open={!!fundModal} onClose={() => setFundModal(null)} title={fundModal?.title} size="2xl">
        <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
          <p className="text-sm text-slate-500">Σύνολο περιόδου · {fundRows.length} ταμεία</p>
          {fundRows.length > 0 && (
            <button
              onClick={() => downloadCsv("ana-tameio", [
                { key: "fund_name", header: "Ταμείο" },
                { key: "rx", header: "Συνταγές" },
                { key: "value", header: "Αξία (€)", value: (r: FundRow) => (r.value / 100).toFixed(2) },
                { key: "claimed", header: "Αιτούμενο (€)", value: (r: FundRow) => (r.claimed / 100).toFixed(2) },
                { key: "unexecuted", header: "Ανεκτέλεστες" },
              ], fundRows)}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> Εξαγωγή CSV
            </button>
          )}
        </div>
        <QueryState isLoading={byFund.isLoading} isError={byFund.isError}
          isEmpty={fundRows.length === 0} onRetry={() => byFund.refetch()} empty="Καμία εγγραφή.">
          <DataTable pageSize={20} columns={fundCols} rows={fundRows} rowKey={(r) => r.fund_name} />
        </QueryState>
      </Modal>
    </ModuleGuard>
  );
}
