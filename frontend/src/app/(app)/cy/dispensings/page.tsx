"use client";

/* RxVision Κύπρος: Εκτελέσεις (όπως η «Λίστα συνταγών» στην Ελλάδα). Κοινό φίλτρο περιόδου,
   αναζήτηση (πελάτης, κωδικός ΟΑΥ, αρ. συνταγής, σκεύασμα), τύπος, ταξινόμηση από τον server
   (καλύπτει ΟΛΕΣ τις σελίδες). Κλικ σε γραμμή → η εκτέλεση με όλες τις γραμμές της. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { downloadCsv } from "@/lib/csv";
import { fmtDateTime, fmtEur, fmtMoney, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Totals = { hio: number; beneficiary: number; pc2: number; total: number };
type Row = {
  dispensing_id: string; prescription_id: string; kind: "drug" | "consumable"; dispensed_at: string;
  patient_ref: string | null; patient_name: string | null; doctor_id: string | null; doctor: string | null; user: string | null;
  instance: number; instances: number; lines: number; not_dispensed: number; items: string[]; totals: Totals; versions: number;
};
type Resp = { total: number; page: number; page_size: number; items: Row[] };
const SORT_KEYS = new Set(["dispensed_at", "total", "hio", "beneficiary"]);
const PAGE = 50;

export default function CyDispensingsPage() {
  const t = useT();
  const router = useRouter();
  const { dateFrom, dateTo } = useUiStore();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<"" | "drug" | "consumable">("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "dispensed_at", dir: "desc" });
  const [page, setPage] = useState(1);
  const [extra, setExtra] = useState<{ doctor_id?: string; patient_ref?: string }>({});
  // ?sort=… από τις κάρτες του Dashboard, ?doctor_id=/?patient_ref= από τις καρτέλες (χωρίς useSearchParams: θέλει Suspense στο build)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s0 = sp.get("sort");
    if (s0 && SORT_KEYS.has(s0)) setSort({ key: s0, dir: "desc" });
    setExtra({ doctor_id: sp.get("doctor_id") || undefined, patient_ref: sp.get("patient_ref") || undefined });
  }, []);
  useEffect(() => setPage(1), [dateFrom, dateTo, term, kind, sort, extra]);

  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, sort: sort.key, dir: sort.dir === "asc" ? "1" : "-1",
    page: String(page), page_size: String(PAGE) });
  if (term) params.set("q", term);
  if (kind) params.set("kind", kind);
  if (extra.doctor_id) params.set("doctor_id", extra.doctor_id);
  if (extra.patient_ref) params.set("patient_ref", extra.patient_ref);
  const qs = params.toString();
  const list = useQuery({ queryKey: ["cy", "dispensings", qs], queryFn: () => api<Resp>(`/cy/dispensings?${qs}`) });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE));

  const cols: Column<Row>[] = [
    { key: "dispensed_at", header: t("Ημ/νία", "Date"), render: (r) => fmtDateTime(r.dispensed_at) },
    { key: "patient_name", header: t("Πελάτης", "Customer"), sortable: false, render: (r) => r.patient_name || "—" },
    { key: "items", header: t("Σκευάσματα", "Products"), sortable: false, hideOnMobile: true,
      render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.items.join(" · ")}{r.lines > r.items.length ? " …" : ""}
        {r.not_dispensed > 0 && <span className="ml-1 text-amber-600">({r.not_dispensed} {t("δεν δόθηκαν", "not given")})</span>}</span> },
    { key: "doctor", header: t("Γιατρός", "Doctor"), sortable: false, hideOnMobile: true, render: (r) => r.doctor || "—" },
    { key: "instance", header: t("Φάση", "Step"), sortable: false, align: "center",
      render: (r) => <span>{r.instance}/{r.instances}{r.instance >= r.instances && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-slate-800">{t("τέλος", "end")}</span>}</span> },
    { key: "hio", header: t("ΟΑΥ", "HIO"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.totals.hio) },
    { key: "beneficiary", header: t("Πελάτης €", "Customer €"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.totals.beneficiary) },
    { key: "total", header: t("Σύνολο", "Total"), align: "right", render: (r) => <b>{fmtEur(r.totals.total)}</b> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Εκτελέσεις", "Dispensings")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Όλες οι εκτελέσεις ΓεΣΥ της περιόδου. Κλικ σε γραμμή για τη λεπτομέρεια.", "All GHS dispensings in the period. Click a row for details.")}</p>
        </div>
        <DateRangeFilter />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Πελάτης, κωδ. ΟΑΥ, αρ. συνταγής ή σκεύασμα", "Customer, HIO code, prescription no. or product")}
              className="w-80 max-w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
          </div>
          <button className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">{t("Αναζήτηση", "Search")}</button>
        </form>
        {(["", "drug", "consumable"] as const).map((k) => (
          <button key={k || "all"} onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-sm ${kind === k ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>
            {k === "" ? t("Όλες", "All") : k === "drug" ? t("Φάρμακα", "Drugs") : t("Αναλώσιμα", "Consumables")}
          </button>
        ))}
        {(extra.doctor_id || extra.patient_ref) && (
          <button onClick={() => { setExtra({}); router.replace("/cy/dispensings"); }} className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700">
            {extra.doctor_id ? t("Ένας γιατρός", "One doctor") : t("Ένας πελάτης", "One customer")} ✕
          </button>
        )}
        <span className="ml-auto text-sm text-slate-500">{fmtNum(list.data?.total ?? 0)} {t("εκτελέσεις", "dispensings")}</span>
        {(list.data?.items.length ?? 0) > 0 && (
          <button onClick={() => downloadCsv("ektelesis-gesy", [
            { key: "dispensed_at", header: t("Ημ/νία", "Date"), value: (r: Record<string, unknown>) => fmtDateTime(r.dispensed_at as string) },
            { key: "prescription_id", header: t("Συνταγή", "Prescription") },
            { key: "patient_name", header: t("Πελάτης", "Customer") },
            { key: "doctor", header: t("Γιατρός", "Doctor") },
            { key: "instance", header: t("Φάση", "Step"), value: (r: Record<string, unknown>) => `${r.instance}/${r.instances}` },
            { key: "hio", header: t("ΟΑΥ (€)", "HIO (€)"), value: (r: Record<string, unknown>) => fmtMoney((r.totals as Totals).hio) },
            { key: "beneficiary", header: t("Πελάτης (€)", "Customer (€)"), value: (r: Record<string, unknown>) => fmtMoney((r.totals as Totals).beneficiary) },
            { key: "total", header: t("Σύνολο (€)", "Total (€)"), value: (r: Record<string, unknown>) => fmtMoney((r.totals as Totals).total) },
          ], list.data!.items as unknown as Record<string, unknown>[])}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        )}
      </div>

      <div className="rx-card p-2">
        <QueryState isLoading={list.isLoading} isError={list.isError} onRetry={() => list.refetch()}
          isEmpty={(list.data?.items.length ?? 0) === 0} empty={t("Καμία εκτέλεση με αυτά τα φίλτρα.", "No dispensings match these filters.")}>
          <DataTable columns={cols} rows={list.data?.items ?? []} rowKey={(r) => r.dispensing_id}
            serverSort={sort} onServerSort={(key) => SORT_KEYS.has(key) && setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}
            onRowClick={(r) => router.push(`/cy/dispensings/${encodeURIComponent(r.dispensing_id)}`)} />
        </QueryState>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-700">‹ {t("Προηγ.", "Prev")}</button>
          <span className="text-slate-500">{t("Σελίδα", "Page")} {page}/{pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40 dark:border-slate-700">{t("Επόμ.", "Next")} ›</button>
        </div>
      )}
    </div>
  );
}
