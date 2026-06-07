"use client";

import { appConfirm } from "@/store/dialogStore";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";

type Invoice = {
  id: string; tenant_id: string; tenant_name: string | null; doc_type: string; series: string;
  number: number; full_number: string; issue_date: string; description: string;
  net_amount: number; vat_rate: number; vat_amount: number; total: number;
  aade_status: "transmitted" | "not_transmitted"; aade_mark: string | null; aade_transmitted_at: string | null;
};
type Tenant = { id: string; name: string };

function AadeBadge({ v }: { v: string }) {
  return v === "transmitted"
    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">Διαβιβασμένο ΑΑΔΕ</span>
    : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Μη διαβιβασμένο</span>;
}

export default function Invoices() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ mode: "create" | "edit" | "view"; inv?: Invoice } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invoices = useQuery({ queryKey: ["admin", "invoices"], queryFn: () => adminApi<{ items: Invoice[] }>("/admin/invoices"), retry: false });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const rows = invoices.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "invoices"] });

  async function act(fn: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try { await fn(); setNotice(ok); refresh(); }
    catch (e) {
      const m = e instanceof ApiError ? (e.problem?.detail?.message ?? JSON.stringify(e.problem)) : "Σφάλμα.";
      setNotice(`Σφάλμα: ${m}`);
    }
  }
  const transmit = async (i: Invoice) => { if (await appConfirm(`Διαβίβαση του ${i.full_number} στην ΑΑΔΕ; Μετά δεν τροποποιείται/διαγράφεται.`, { title: "Διαβίβαση στην ΑΑΔΕ", confirmText: "Διαβίβαση" })) act(() => adminApi(`/admin/invoices/${i.id}/transmit`, { method: "POST" }), "Διαβιβάστηκε στην ΑΑΔΕ ✓"); };
  const del = async (i: Invoice) => { if (await appConfirm(`Διαγραφή του παραστατικού ${i.full_number};`, { title: "Διαγραφή παραστατικού", danger: true, confirmText: "Διαγραφή" })) act(() => adminApi(`/admin/invoices/${i.id}`, { method: "DELETE" }), "Διαγράφηκε."); };

  const columns: Column<Invoice>[] = [
    { key: "full_number", header: "Αρ.", render: (r) => <span className="font-medium">{r.doc_type} {r.full_number}</span> },
    { key: "tenant_name", header: "Πελάτης", render: (r) => r.tenant_name ?? r.tenant_id },
    { key: "issue_date", header: "Ημ/νία", render: (r) => fmtDate(r.issue_date) },
    { key: "total", header: "Σύνολο", align: "right", render: (r) => fmtEur(r.total) },
    { key: "aade_status", header: "ΑΑΔΕ", render: (r) => <AadeBadge v={r.aade_status} /> },
    {
      key: "actions", header: "", align: "right",
      render: (r) => {
        const locked = r.aade_status === "transmitted";
        return (
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setModal({ mode: "view", inv: r })} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Προβολή</button>
            <button onClick={() => setModal({ mode: "edit", inv: r })} disabled={locked} title={locked ? "Διαβιβασμένο — κλειδωμένο" : ""}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Edit</button>
            <button onClick={() => del(r)} disabled={locked}
              className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">Διαγραφή</button>
            {!locked && <button onClick={() => transmit(r)} className="rounded-md border border-emerald-300 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50">Διαβίβαση ΑΑΔΕ</button>}
          </div>
        );
      },
    },
  ];

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Παραστατικά</h2>
        <button onClick={() => setModal({ mode: "create" })} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">+ Νέο παραστατικό</button>
      </div>
      {notice && <div className="mb-3 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}
      {invoices.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} empty="Δεν υπάρχουν παραστατικά." />}

      {modal && <InvoiceModal modal={modal} tenants={tenants.data?.items ?? []} onClose={() => setModal(null)} onDone={(m) => { setNotice(m); refresh(); setModal(null); }} />}
    </div>
  );
}

function InvoiceModal({ modal, tenants, onClose, onDone }:
  { modal: { mode: "create" | "edit" | "view"; inv?: Invoice }; tenants: Tenant[]; onClose: () => void; onDone: (msg: string) => void }) {
  const { mode, inv } = modal;
  const view = mode === "view";
  const [form, setForm] = useState({
    tenant_id: inv?.tenant_id ?? tenants[0]?.id ?? "",
    doc_type: inv?.doc_type ?? "ΤΠΥ", series: inv?.series ?? "Α",
    issue_date: inv?.issue_date ?? new Date().toISOString().slice(0, 10),
    description: inv?.description ?? "",
    net_eur: inv ? (inv.net_amount / 100).toFixed(2) : "", vat_rate: String(inv?.vat_rate ?? 24),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const net = Math.round(parseFloat(form.net_eur || "0") * 100);
  const vat = Math.round(net * (parseFloat(form.vat_rate || "0") / 100));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = { doc_type: form.doc_type, series: form.series, issue_date: form.issue_date,
        description: form.description, net_amount: net, vat_rate: parseFloat(form.vat_rate || "0") };
      if (mode === "create") await adminApi("/admin/invoices", { method: "POST", body: JSON.stringify({ tenant_id: form.tenant_id, ...payload }) });
      else await adminApi(`/admin/invoices/${inv!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      onDone(mode === "create" ? "Δημιουργήθηκε παραστατικό ✓" : "Αποθηκεύτηκε ✓");
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem?.detail?.message ?? JSON.stringify(e.problem)) : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <form onSubmit={submit} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-bold text-slate-900">
          {mode === "create" ? "Νέο παραστατικό" : mode === "edit" ? `Επεξεργασία ${inv?.full_number}` : `Παραστατικό ${inv?.full_number}`}
        </h2>
        {view && inv?.aade_status === "transmitted" && (
          <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Διαβιβασμένο ΑΑΔΕ · MARK: <code>{inv.aade_mark}</code></div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="col-span-2 block text-sm"><span className="mb-1 block text-slate-600">Πελάτης</span>
            <select disabled={view || mode === "edit"} value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })} className={inp}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Τύπος</span>
            <input disabled={view} value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Σειρά</span>
            <input disabled={view} value={form.series} onChange={(e) => setForm({ ...form, series: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Ημ/νία</span>
            <input type="date" disabled={view} value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">ΦΠΑ %</span>
            <input type="number" step="any" disabled={view} value={form.vat_rate} onChange={(e) => setForm({ ...form, vat_rate: e.target.value })} className={inp} /></label>
          <label className="col-span-2 block text-sm"><span className="mb-1 block text-slate-600">Περιγραφή</span>
            <input disabled={view} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inp} /></label>
          <label className="block text-sm"><span className="mb-1 block text-slate-600">Καθαρή αξία (€)</span>
            <input type="number" step="0.01" disabled={view} value={form.net_eur} onChange={(e) => setForm({ ...form, net_eur: e.target.value })} className={inp} /></label>
          <div className="text-sm"><span className="mb-1 block text-slate-600">ΦΠΑ / Σύνολο</span>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700">{fmtEur(view && inv ? inv.vat_amount : vat)} / <b>{fmtEur(view && inv ? inv.total : net + vat)}</b></div></div>
        </div>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">{view ? "Κλείσιμο" : "Άκυρο"}</button>
          {!view && <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "…" : "Αποθήκευση"}</button>}
        </div>
      </form>
    </div>
  );
}
