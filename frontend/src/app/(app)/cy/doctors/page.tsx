"use client";

/* RxVision Κύπρος: Γιατροί (όπως στην Ελλάδα). Ποιοι συνταγογραφούν στους πελάτες μου και
   τι αξία φέρνουν στην περίοδο του κοινού φίλτρου. Κλικ → Καρτέλα γιατρού.
   Το XML ΓεΣΥ δεν έχει ειδικότητα, μόνο κωδικό, όνομα και τηλέφωνα. */

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { QueryState } from "@/components/ui/QueryState";
import { DateRangeFilter } from "@/components/filters/DateRangeFilter";
import { useUiStore } from "@/store/uiStore";
import { fmtEur, fmtNum } from "@/lib/formatters";
import { useT } from "@/store/prefStore";

type Row = { doctor_id: string | null; name: string | null; phones: string[]; dispensings: number; prescriptions: number;
  patients: number; total_cents: number; hio_cents: number; share_pct: number; top_items: string[] };

export default function CyDoctorsPage() {
  const t = useT();
  const router = useRouter();
  const { dateFrom, dateTo } = useUiStore();
  const q = useQuery({ queryKey: ["cy", "doctors", dateFrom, dateTo],
    queryFn: () => api<{ items: Row[] }>(`/cy/doctors?date_from=${dateFrom}&date_to=${dateTo}`) });
  const rows = q.data?.items ?? [];
  const cols: Column<Row>[] = [
    { key: "name", header: t("Γιατρός", "Doctor"), render: (r) => <div><div className="font-medium">{r.name || "—"}</div>
      <div className="text-xs text-slate-400">{r.doctor_id}{r.phones.length ? ` · ${r.phones.join(", ")}` : ""}</div></div> },
    { key: "patients", header: t("Πελάτες", "Customers"), align: "right", render: (r) => fmtNum(r.patients) },
    { key: "prescriptions", header: t("Συνταγές", "Prescriptions"), align: "right", hideOnMobile: true, render: (r) => fmtNum(r.prescriptions) },
    { key: "dispensings", header: t("Εκτελέσεις", "Dispensings"), align: "right", hideOnMobile: true, render: (r) => fmtNum(r.dispensings) },
    { key: "top_items", header: t("Συχνότερα", "Most frequent"), sortable: false, hideOnMobile: true,
      render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300">{r.top_items.slice(0, 3).join(" · ")}</span> },
    { key: "total_cents", header: t("Αξία", "Value"), align: "right",
      render: (r) => <div><div className="font-medium">{fmtEur(r.total_cents)}</div><div className="text-xs text-slate-400">{r.share_pct}%</div></div> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Γιατροί", "Doctors")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("Ποιοι γιατροί συνταγογραφούν στους πελάτες σου και τι αξία φέρνουν στο φαρμακείο. Κλικ για την καρτέλα του γιατρού.",
            "Which doctors prescribe for your customers and what value they bring. Click to open the doctor's card.")}</p>
        </div>
        <DateRangeFilter />
      </div>
      <div className="rx-card p-2">
        <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()} isEmpty={rows.length === 0}
          empty={t("Κανένας γιατρός στην περίοδο.", "No doctors in the period.")}>
          <DataTable pageSize={25} columns={cols} rows={rows} rowKey={(r, i) => r.doctor_id ?? `x${i}`}
            onRowClick={(r) => r.doctor_id && router.push(`/cy/doctors/${encodeURIComponent(r.doctor_id)}`)} />
        </QueryState>
      </div>
    </div>
  );
}
