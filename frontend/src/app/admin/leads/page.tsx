"use client";

import { useState } from "react";
import { appConfirm } from "@/store/dialogStore";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Send, Trash2, Loader2, Save, Mail, Trash } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Lead = {
  _id: string; afm?: string | null; email?: string | null; phone?: string | null;
  contact_name?: string | null; pharmacy_name?: string | null; country?: string;
  status: string; offers_sent?: number; last_offer_at?: string | null;
  trial_expired?: string | null; purged_at?: string | null; reason?: string;
};
type LeadCfg = { purge_days: number; purge_enabled: boolean; offer_subject: string; offer_body: string };
type LeadsRes = { items: Lead[]; counts: Record<string, number>; config: LeadCfg };
type PurgeRes = { candidates: number; purged: number; purge_days: number; enabled: boolean; dry_run: boolean };

const STATUS: Record<string, { label: string; cls: string }> = {
  lead: { label: "Νέο lead", cls: "bg-sky-100 text-sky-700" },
  contacted: { label: "Επικοινωνήθηκε", cls: "bg-amber-100 text-amber-700" },
  converted: { label: "Έγινε πελάτης", cls: "bg-emerald-100 text-emerald-700" },
  unsubscribed: { label: "Διαγραφή", cls: "bg-slate-200 text-slate-500" },
};
const FILTERS: [string, string][] = [["all", "Όλα"], ["lead", "Νέα"], ["contacted", "Επικοινωνήθηκαν"], ["converted", "Πελάτες"], ["unsubscribed", "Διαγραφές"]];
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");

export default function AdminLeadsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const q = useQuery({ queryKey: ["admin-leads", filter], queryFn: () => adminApi<LeadsRes>(`/admin/leads${filter !== "all" ? `?status=${filter}` : ""}`), retry: false });
  const inv = () => qc.invalidateQueries({ queryKey: ["admin-leads"] });
  const [busyId, setBusyId] = useState<string | null>(null);

  const offer = useMutation({ mutationFn: (id: string) => { setBusyId(id); return adminApi(`/admin/leads/${encodeURIComponent(id)}/offer`, { method: "POST", body: JSON.stringify({}) }); }, onSettled: () => setBusyId(null), onSuccess: inv });
  const setStatus = useMutation({ mutationFn: (v: { id: string; status: string }) => adminApi(`/admin/leads/${encodeURIComponent(v.id)}`, { method: "PATCH", body: JSON.stringify({ status: v.status }) }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: string) => adminApi(`/admin/leads/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: inv });
  const bulk = useMutation({ mutationFn: () => adminApi(`/admin/leads/offer-bulk`, { method: "POST", body: JSON.stringify({}) }), onSuccess: inv });

  // config + manual purge
  const cfg = q.data?.config;
  const [days, setDays] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [subj, setSubj] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const saveCfg = useMutation({
    mutationFn: () => adminApi(`/admin/leads-config`, { method: "PUT", body: JSON.stringify({ purge_days: days ? Number(days) : undefined, purge_enabled: enabled ?? undefined, offer_subject: subj || undefined, offer_body: body || undefined }) }),
    onSuccess: () => { setDays(""); setEnabled(null); setSubj(""); setBody(""); inv(); },
  });
  const [purge, setPurge] = useState<PurgeRes | null>(null);
  const runPurge = useMutation({
    mutationFn: (dry: boolean) => adminApi<PurgeRes>(`/admin/trials/purge?dry_run=${dry}`, { method: "POST" }),
    onSuccess: (r) => { setPurge(r); if (!r.dry_run) inv(); },
  });

  const items = q.data?.items ?? [];
  const counts = q.data?.counts ?? {};

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Users className="h-6 w-6 text-brand-600" /> Leads — πρώην δοκιμαστικοί</h1>
        <p className="mt-1 text-sm text-slate-500">Φαρμακεία που δοκίμασαν το RxVision & δεν έγιναν πελάτες. Κρατάμε το ΑΦΜ (μπλοκ επανα-trial) και τους στέλνουμε προσφορές για να τους μετατρέψουμε.</p>
      </div>

      {/* config + purge */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">⚙️ Ρυθμίσεις κύκλου trial</h3>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-xs text-slate-500">Διαγραφή trial μετά από (ημέρες λήξης)
            <input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder={String(cfg?.purge_days ?? 20)} className="mt-1 block w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-medium text-slate-600">
            <input type="checkbox" checked={enabled ?? cfg?.purge_enabled ?? true} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Αυτόματη διαγραφή ενεργή
          </label>
          <button onClick={() => saveCfg.mutate()} disabled={saveCfg.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"><Save className="h-3.5 w-3.5" /> Αποθήκευση</button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => runPurge.mutate(true)} disabled={runPurge.isPending} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">Προεπισκόπηση διαγραφής</button>
            <button onClick={async () => { if (await appConfirm(`Οριστική διαγραφή ${purge?.candidates ?? ""} ληγμένων trials; (κρατάμε τα ΑΦΜ στα leads)`, { danger: true })) runPurge.mutate(false); }} disabled={runPurge.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"><Trash className="h-3.5 w-3.5" /> Εκτέλεση τώρα</button>
          </div>
        </div>
        {purge && <p className="mt-2 text-xs text-slate-500">{purge.dry_run ? `Θα διαγραφούν ${purge.candidates} λογαριασμοί (ληγμένα trials >${purge.purge_days} ημ.).` : `Διαγράφηκαν ${purge.purged} λογαριασμοί — τα ΑΦΜ αρχειοθετήθηκαν στα leads.`}</p>}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-slate-500">Πρότυπο προσφοράς (email)</summary>
          <div className="mt-2 space-y-2">
            <input value={subj} onChange={(e) => setSubj(e.target.value)} placeholder={cfg?.offer_subject} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={cfg?.offer_body} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <span className="text-[11px] text-slate-400">Χρησιμοποίησε {"{name}"} για το όνομα. Αποθηκεύεται με το κουμπί «Αποθήκευση» πάνω.</span>
          </div>
        </details>
      </div>

      {/* filters + bulk */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={`rounded-full px-3 py-1 text-xs font-medium ${filter === k ? "bg-brand-600 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{l}{counts[k] ? ` (${counts[k]})` : k === "all" && counts.total ? ` (${counts.total})` : ""}</button>
        ))}
        <button onClick={async () => { if (await appConfirm("Αποστολή προσφοράς σε ΟΛΑ τα νέα leads;")) bulk.mutate(); }} disabled={bulk.isPending} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{bulk.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Προσφορά σε όλα τα νέα</button>
      </div>

      {/* table */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
            <th className="px-3 py-2">Φαρμακείο</th><th className="px-3 py-2">ΑΦΜ</th><th className="px-3 py-2">Επικοινωνία</th>
            <th className="px-3 py-2">Κατάσταση</th><th className="px-3 py-2 text-center">Προσφορές</th><th className="px-3 py-2">Λήξη trial</th><th className="px-3 py-2 text-right">Ενέργειες</th>
          </tr></thead>
          <tbody>
            {q.isLoading ? <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Φόρτωση…</td></tr>
              : items.length === 0 ? <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Κανένα lead ακόμη.</td></tr>
              : items.map((l) => (
                <tr key={l._id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium text-slate-800">{l.pharmacy_name || l.contact_name || l._id}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{l.afm || "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{l.email || <span className="text-slate-300">χωρίς email</span>}{l.phone ? <div className="text-slate-400">{l.phone}</div> : null}</td>
                  <td className="px-3 py-2">
                    <select value={l.status} onChange={(e) => setStatus.mutate({ id: l._id, status: e.target.value })} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[l.status]?.cls || "bg-slate-100 text-slate-500"}`}>
                      {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums text-slate-600">{l.offers_sent || 0}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fmt(l.trial_expired)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => offer.mutate(l._id)} disabled={!l.email || busyId === l._id} title={l.email ? "Στείλε προσφορά" : "Χωρίς email"} className="mr-2 inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-40">{busyId === l._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Προσφορά</button>
                    <button onClick={async () => { if (await appConfirm(`Διαγραφή lead ${l.pharmacy_name || l._id}; (το ΑΦΜ δεν θα μπλοκάρει πια)`, { danger: true })) del.mutate(l._id); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
