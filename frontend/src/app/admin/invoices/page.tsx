"use client";

import { appConfirm } from "@/store/dialogStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { DateInput } from "@/components/ui/DateInput";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtEur, fmtDate, fmtMoney } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";
import { Receipt, Send, CheckCircle2, Clock, AlertTriangle, Ban } from "lucide-react";

type Invoice = {
  id: string; tenant_id: string; tenant_name: string | null; doc_type: string; series: string;
  number: number; full_number: string; issue_date: string; description: string;
  net_amount: number; vat_rate: number; vat_amount: number; total: number;
  aade_status: "transmitted" | "not_transmitted"; aade_mark: string | null; aade_transmitted_at: string | null;
  // Φάση 3 — αυτόματο κύκλωμα SoftOne → myDATA
  status?: "pending" | "blocked" | "issued" | "failed"; blocked_reason?: string | null;
  softone_findoc?: string | null; mydata_aa?: string | null;
  attempts?: number; last_error?: string | null; auto?: boolean; kind?: string | null;
};
type Tenant = { id: string; name: string };

/** Είναι ενημερωμένο το SoftOne; (findoc ή διαβίβαση ΑΑΔΕ ολοκληρωμένη) */
const isSynced = (i: Invoice) => i.aade_status === "transmitted" || !!i.softone_findoc;

/** Ένδειξη ενημέρωσης SoftOne — το κύριο χαρακτηριστικό «τι έχει περάσει στο SoftOne». */
function SoftoneBadge({ inv }: { inv: Invoice }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";
  if (isSynced(inv))
    return (
      <span className={`${base} bg-emerald-100 text-emerald-700`} title={inv.softone_findoc ? `findoc ${inv.softone_findoc}` : ""}>
        <CheckCircle2 className="h-3.5 w-3.5" /> Ενημερωμένο{inv.softone_findoc ? ` · ${inv.softone_findoc}` : ""}
      </span>
    );
  if (inv.status === "failed")
    return (
      <Tooltip label={inv.last_error || "Αποτυχία διαβίβασης"}>
        <span className={`${base} bg-rose-100 text-rose-700`}><AlertTriangle className="h-3.5 w-3.5" /> Απέτυχε{inv.attempts ? ` (×${inv.attempts})` : ""}</span>
      </Tooltip>
    );
  if (inv.status === "blocked")
    return (
      <Tooltip label={inv.blocked_reason || "Λείπουν προαπαιτούμενα (π.χ. ΑΦΜ/MTRL)"}>
        <span className={`${base} bg-slate-200 text-slate-600`}><Ban className="h-3.5 w-3.5" /> Μπλοκαρισμένο</span>
      </Tooltip>
    );
  return <span className={`${base} bg-amber-100 text-amber-700`}><Clock className="h-3.5 w-3.5" /> Εκκρεμεί</span>;
}

export default function InvoicesPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ mode: "create" | "edit" | "view"; inv?: Invoice } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "synced" | "unsynced">("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const invoices = useQuery({ queryKey: ["admin", "invoices"], queryFn: () => adminApi<{ items: Invoice[] }>("/admin/invoices"), retry: false });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants"), retry: false });
  const all = invoices.data?.items ?? [];
  const rows = filter === "all" ? all : all.filter((i) => (filter === "synced" ? isSynced(i) : !isSynced(i)));
  const unsyncedCount = all.filter((i) => !isSynced(i)).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "invoices"] });

  function errMsg(e: unknown): string {
    if (e instanceof ApiError) {
      const d = (e.problem as { detail?: { message?: string; error?: string } })?.detail;
      return d?.message || d?.error || "Σφάλμα.";
    }
    return "Σφάλμα.";
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    setNotice(null);
    try { await fn(); setNotice(ok); refresh(); }
    catch (e) { setNotice(`Σφάλμα: ${errMsg(e)}`); }
  }

  // Αποστολή / επαναποστολή στο SoftOne (→ myDATA/ΑΑΔΕ). Idempotent: αν έχει ήδη διαβιβαστεί, δεν ξαναστέλνει.
  const send = async (i: Invoice) => {
    const again = i.status === "failed" || (i.attempts ?? 0) > 0;
    const ok = await appConfirm(
      `${again ? "Επαναποστολή" : "Αποστολή"} του ${i.doc_type} ${i.full_number} στο SoftOne → myDATA/ΑΑΔΕ;\nΜετά την επιτυχή διαβίβαση κλειδώνει (δεν τροποποιείται/διαγράφεται).`,
      { title: again ? "Επαναποστολή στο SoftOne" : "Αποστολή στο SoftOne", confirmText: again ? "Επαναποστολή" : "Αποστολή" });
    if (!ok) return;
    setBusyId(i.id);
    try { await act(() => adminApi(`/admin/invoices/${i.id}/transmit`, { method: "POST" }), "Ενημερώθηκε το SoftOne ✓"); }
    finally { setBusyId(null); }
  };
  const del = async (i: Invoice) => { if (await appConfirm(`Διαγραφή του παραστατικού ${i.full_number};`, { title: "Διαγραφή παραστατικού", danger: true, confirmText: "Διαγραφή" })) act(() => adminApi(`/admin/invoices/${i.id}`, { method: "DELETE" }), "Διαγράφηκε."); };

  const columns: Column<Invoice>[] = [
    { key: "full_number", header: "Αρ.", render: (r) => <span className="font-medium">{r.doc_type} {r.full_number}</span> },
    { key: "tenant_name", header: "Πελάτης", render: (r) => r.tenant_name ?? r.tenant_id },
    { key: "issue_date", header: "Ημ/νία", render: (r) => fmtDate(r.issue_date) },
    { key: "total", header: "Σύνολο", align: "right", render: (r) => fmtEur(r.total) },
    { key: "softone", header: "SoftOne", render: (r) => <SoftoneBadge inv={r} /> },
    { key: "aade_mark", header: "ΑΑΔΕ MARK", render: (r) => r.aade_mark ? <code className="text-xs text-slate-600">{r.aade_mark}</code> : <span className="text-slate-300">—</span> },
    {
      key: "actions", header: "", align: "right",
      render: (r) => {
        const locked = isSynced(r);
        const busy = busyId === r.id;
        return (
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setModal({ mode: "view", inv: r })} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">Προβολή</button>
            <Tooltip label={locked ? "Ενημερωμένο SoftOne — κλειδωμένο" : ""}><button onClick={() => setModal({ mode: "edit", inv: r })} disabled={locked}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Edit</button></Tooltip>
            <button onClick={() => del(r)} disabled={locked}
              className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">Διαγραφή</button>
            {!locked && (
              <button onClick={() => send(r)} disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> {busy ? "Αποστολή…" : (r.status === "failed" || (r.attempts ?? 0) > 0) ? "Επαναποστολή" : "Αποστολή SoftOne"}
              </button>
            )}
          </div>
        );
      },
    },
  ];

  const fBtn = (v: typeof filter, label: string, n?: number) => (
    <button onClick={() => setFilter(v)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${filter === v ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
      {label}{n !== undefined && n > 0 ? ` (${n})` : ""}
    </button>
  );

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2"><Receipt className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">Παραστατικά</h1></div>
      <p className="mb-5 text-sm text-slate-500">Όλα τα παραστατικά που δημιουργήθηκαν (αυτόματα από χρεώσεις ή χειροκίνητα). Η στήλη <b>SoftOne</b> δείχνει ποια έχουν ενημερώσει το SoftOne → myDATA· για όσα δεν έχουν, μπορείς να τα <b>ξαναστείλεις</b>.</p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {fBtn("all", "Όλα", all.length)}
          {fBtn("unsynced", "Μη ενημερωμένα", unsyncedCount)}
          {fBtn("synced", "Ενημερωμένα")}
        </div>
        <button onClick={() => setModal({ mode: "create" })} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">+ Νέο παραστατικό</button>
      </div>
      {notice && <div className="mb-3 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">{notice}</div>}
      {invoices.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.id} empty="Δεν υπάρχουν παραστατικά." />}

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
    net_eur: inv ? fmtMoney(inv.net_amount) : "", vat_rate: String(inv?.vat_rate ?? 24),
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
      setError(e instanceof ApiError ? ((e.problem as { detail?: { message?: string } })?.detail?.message ?? "Σφάλμα.") : "Σφάλμα.");
    } finally { setBusy(false); }
  }

  const inp = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50";
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={mode === "create" ? "Νέο παραστατικό" : mode === "edit" ? `Επεξεργασία ${inv?.full_number}` : `Παραστατικό ${inv?.full_number}`}
    >
      <form onSubmit={submit}>
        {view && inv && isSynced(inv) && (
          <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Ενημερωμένο SoftOne{inv.softone_findoc ? <> · findoc: <code>{inv.softone_findoc}</code></> : null}
            {inv.aade_mark ? <> · ΑΑΔΕ MARK: <code>{inv.aade_mark}</code></> : null}
          </div>
        )}
        {view && inv && !isSynced(inv) && inv.last_error && (
          <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Τελευταίο σφάλμα SoftOne: {inv.last_error}</div>
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
            <DateInput disabled={view} value={form.issue_date} onChange={(v) => setForm({ ...form, issue_date: v })} /></label>
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
    </Modal>
  );
}
