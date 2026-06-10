"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Phone, MessageSquare, Mail, Megaphone, ChevronRight, Users } from "lucide-react";
import { api } from "@/lib/apiClient";
import { fmtNum, fmtDate } from "@/lib/formatters";
import { Modal } from "@/components/ui/Modal";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ExportMenu } from "@/components/export/ExportMenu";

export type Xsell = { atc: string; class: string; sell: string; why: string; reach: number };
type Pat = {
  patient_id: string; name?: string | null; amka?: string | null; age_group?: string | null;
  sex?: string | null; birth_year?: number | null; times: number; last: string;
  drugs?: (string | null)[]; mobile?: string | null; phone?: string | null; email?: string | null; consent?: boolean;
};

export function CrossSellCard({ x }: { x: Xsell }) {
  const [open, setOpen] = useState(false);
  const pats = useQuery({ queryKey: ["xsell-pat", x.atc], queryFn: () => api<{ items: Pat[] }>(`/advisor/cross-sell-patients?atc=${encodeURIComponent(x.atc)}`), enabled: open, retry: false });
  const rows = pats.data?.items ?? [];

  const cols: Column<Pat>[] = [
    { key: "name", header: "Ασθενής", render: (r) => r.name || "—" },
    { key: "age", header: "Ηλικία", hideOnMobile: true, render: (r) => r.birth_year ? `${new Date().getFullYear() - r.birth_year}` : (r.age_group || "—") },
    { key: "times", header: "Εκτελ.", align: "right", render: (r) => fmtNum(r.times), sortValue: (r) => r.times },
    { key: "last", header: "Τελευταία", hideOnMobile: true, render: (r) => fmtDate(r.last), sortValue: (r) => r.last },
    { key: "drugs", header: "Φάρμακα", hideOnMobile: true, render: (r) => (r.drugs ?? []).filter(Boolean).join(", ") || "—" },
    {
      key: "contact", header: "Επικοινωνία", fullWidthOnMobile: true,
      render: (r) => {
        const tel = r.mobile || r.phone;
        const has = tel || r.email;
        if (!has) return <span className="text-xs text-slate-300">— χωρίς στοιχεία</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            {tel && <a href={`tel:${tel}`} onClick={(e) => e.stopPropagation()} title="Κλήση" aria-label="Κλήση" className="rounded-lg border border-slate-200 p-1.5 text-emerald-600 hover:bg-emerald-50"><Phone className="h-3.5 w-3.5" /></a>}
            {r.mobile && <a href={`sms:${r.mobile}`} onClick={(e) => e.stopPropagation()} title="SMS" aria-label="SMS" className="rounded-lg border border-slate-200 p-1.5 text-brand-600 hover:bg-brand-50"><MessageSquare className="h-3.5 w-3.5" /></a>}
            {r.email && <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} title="Email" aria-label="Email" className="rounded-lg border border-slate-200 p-1.5 text-amber-600 hover:bg-amber-50"><Mail className="h-3.5 w-3.5" /></a>}
            {r.consent && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">συγκατάθεση</span>}
          </span>
        );
      },
    },
  ];
  const withContact = rows.filter((r) => r.mobile || r.phone || r.email).length;

  return (
    <>
      <button onClick={() => setOpen(true)} className="group w-full rounded-2xl border border-brand-200 bg-brand-50/40 p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-lg dark:border-brand-800/50 dark:bg-brand-950/30 dark:hover:border-brand-700">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-800">{x.class}</span>
          <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-bold text-brand-700">{fmtNum(x.reach)} ασθενείς</span>
        </div>
        <div className="mt-1.5 text-sm font-medium text-brand-700">→ {x.sell}</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{x.why}</p>
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 opacity-0 transition group-hover:opacity-100">Δες ασθενείς & επικοινώνησε <ChevronRight className="h-3.5 w-3.5" /></span>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={x.class} size="3xl">
        <div className="-mt-2 mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-500"><Users className="mr-1 inline h-4 w-4" />{fmtNum(rows.length)} ασθενείς · <b className="text-slate-700">{withContact}</b> με στοιχεία επικοινωνίας · προτεινόμενο: <b className="text-brand-700">{x.sell}</b></div>
          <div className="flex gap-2">
            <ExportMenu filename={`asthenis-${x.atc}`} title={`Ασθενείς — ${x.class}`} rows={rows} columns={[
              { key: "name", header: "Ασθενής" }, { key: "amka", header: "ΑΜΚΑ" },
              { key: "times", header: "Εκτελέσεις" }, { key: "last", header: "Τελευταία", value: (r: Pat) => fmtDate(r.last) },
              { key: "mobile", header: "Κινητό" }, { key: "email", header: "Email" },
            ]} />
            <Link href={`/communications?segment=substance&value=${encodeURIComponent(x.atc)}&subject=${encodeURIComponent(x.class)}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
              <Megaphone className="h-4 w-4" /> Δημιουργία καμπάνιας
            </Link>
          </div>
        </div>
        {pats.isLoading ? <div className="py-8 text-center text-slate-400">Άντληση ασθενών…</div> :
          <DataTable pageSize={12} columns={cols} rows={rows} rowKey={(r) => r.patient_id} empty="Καμία εγγραφή." />}
      </Modal>
    </>
  );
}
