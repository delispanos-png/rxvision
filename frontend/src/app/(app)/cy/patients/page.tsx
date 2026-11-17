"use client";

/* RxVision Κύπρος: Πελάτες (όπως οι «Ασφαλισμένοι» στην Ελλάδα). Αναζήτηση με όνομα ή κωδικό
   ΟΑΥ, εκτελέσεις και αξία στην περίοδο, τελευταία επίσκεψη, κατάσταση των συνταγών του
   (η χειρότερη: χάθηκε > καθυστερεί > σύντομα). Κλικ → Καρτέλα πελάτη. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { api } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { downloadCsv } from "@/lib/csv";
import { fmtDate, fmtEur, fmtMoney, fmtNum } from "@/lib/formatters";
import { STATUS_STYLE, ageOf, type ChainStatus } from "@/lib/cy";
import { useT } from "@/store/prefStore";

type Row = { patient_ref: string; full_name: string | null; gender: string | null; dob: string | null; rx: number; value: number;
  beneficiary: number; last: string; consumables: boolean; status: ChainStatus | "closed" };

export default function CyPatientsPage() {
  const t = useT();
  const router = useRouter();
  const { dateFrom, dateTo } = useUiStore();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: "1000", ...(term ? { q: term } : {}) }).toString();
  const list = useQuery({ queryKey: ["cy", "patients", qs], queryFn: () => api<{ items: Row[]; total: number }>(`/cy/patients?${qs}`) });
  const rows = list.data?.items ?? [];

  const cols: Column<Row>[] = [
    { key: "full_name", header: t("Πελάτης", "Customer"), render: (r) => <span className="font-medium">{r.full_name || "—"}</span> },
    { key: "dob", header: t("Ηλικία", "Age"), hideOnMobile: true, render: (r) => {
      const a = ageOf(r.dob); return a != null ? `${a}${r.gender ? ` · ${r.gender === "F" ? t("Γ", "F") : t("Α", "M")}` : ""}` : "—"; },
      sortValue: (r) => ageOf(r.dob) ?? -1 },
    { key: "rx", header: t("Εκτελέσεις", "Dispensings"), align: "right", render: (r) => fmtNum(r.rx) },
    { key: "value", header: t("Αξία", "Value"), align: "right", render: (r) => <b>{fmtEur(r.value)}</b> },
    { key: "beneficiary", header: t("Πλήρωσε", "Paid"), align: "right", hideOnMobile: true, render: (r) => fmtEur(r.beneficiary) },
    { key: "last", header: t("Τελευταία επίσκεψη", "Last visit"), hideOnMobile: true, render: (r) => fmtDate(r.last) },
    { key: "status", header: t("Συνταγές", "Prescriptions"), render: (r) => r.status === "closed"
      ? <span className="text-xs text-slate-400">{t("καμία ανοιχτή", "none open")}</span>
      : <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status].cls}`}>{t(STATUS_STYLE[r.status].el, STATUS_STYLE[r.status].en)}</span>,
      sortValue: (r) => ["lost", "late", "soon", "upcoming", "closed"].indexOf(r.status) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πελάτες", "Customers")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Οι πελάτες με εκτελέσεις ΓεΣΥ στην περίοδο. Κλικ για την Καρτέλα πελάτη.", "Customers with GHS dispensings in the period. Click to open the customer card.")}</p>
        </div>
        <DateRangeFilter />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Όνομα ή κωδικός ΟΑΥ", "Name or HIO code")}
              className="w-72 max-w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm dark:border-slate-700 dark:bg-slate-900" />
          </div>
          <button className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">{t("Αναζήτηση", "Search")}</button>
          {term && <button type="button" onClick={() => { setQ(""); setTerm(""); }} className="text-xs text-slate-500">{t("Καθαρισμός", "Clear")}</button>}
        </form>
        <span className="ml-auto text-sm text-slate-500">{fmtNum(list.data?.total ?? 0)} {t("πελάτες", "customers")}</span>
        {rows.length > 0 && (
          <button onClick={() => downloadCsv("pelates-gesy", [
            { key: "full_name", header: t("Πελάτης", "Customer") },
            { key: "rx", header: t("Εκτελέσεις", "Dispensings") },
            { key: "value", header: t("Αξία (€)", "Value (€)"), value: (r: Row) => fmtMoney(r.value) },
            { key: "beneficiary", header: t("Πλήρωσε (€)", "Paid (€)"), value: (r: Row) => fmtMoney(r.beneficiary) },
            { key: "last", header: t("Τελευταία επίσκεψη", "Last visit"), value: (r: Row) => fmtDate(r.last) },
          ], rows)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        )}
      </div>
      <div className="rx-card p-2">
        <QueryState isLoading={list.isLoading} isError={list.isError} onRetry={() => list.refetch()}
          isEmpty={rows.length === 0} empty={term ? t("Κανένας πελάτης με αυτό το όνομα.", "No customer with that name.") : t("Κανένας πελάτης στην περίοδο.", "No customers in the period.")}>
          <DataTable pageSize={25} columns={cols} rows={rows} rowKey={(r) => r.patient_ref}
            onRowClick={(r) => router.push(`/cy/patients/${encodeURIComponent(r.patient_ref)}`)} />
        </QueryState>
      </div>
    </div>
  );
}
