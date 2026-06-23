"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appConfirm } from "@/store/dialogStore";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Modal } from "@/components/ui/Modal";

type Sub = {
  tenant_id: string; tenant: string; plan: string; status: string;
  billing_cycle?: string | null; seats: number; active_now?: number;
  mrr: number; started_at?: string | null; current_period_end: string | null;
  days_to_expiry: number | null; trial_ends_at: string | null; trial_days_left: number | null;
};
type Summary = { total: number; expiring_30d: number; expired: number; trials_ending_14d: number; past_due: number; mrr: number };
type Invoice = { id: string; full_number: string; doc_type: string; issue_date: string; total: number; aade_status: string; description: string };
type SubDetail = {
  tenant_id: string; tenant: string; plan: string; plan_name?: string; status: string;
  billing_cycle: string; sla?: string; seats: number; users: number; active_now: number;
  price_per_pharmacy?: number; mrr: number; extra_user_price?: number; extra_user_price_yearly?: number;
  started_at?: string | null; current_period_end?: string | null; trial_ends_at?: string | null;
  invoices: Invoice[];
};

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700", trial: "bg-sky-100 text-sky-700",
  past_due: "bg-red-100 text-red-700", suspended: "bg-slate-200 text-slate-600",
  cancelled: "bg-rose-100 text-rose-700",
};
const StatusBadge = ({ value }: { value: string }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-600"}`}>{value}</span>
);
const cycleEl = (c?: string | null) => (c === "yearly" ? "Ετήσια" : c === "monthly" ? "Μηνιαία" : "—");

function Expiry({ row }: { row: Sub }) {
  const d = row.days_to_expiry;
  if (d === null) return <span className="text-slate-400">—</span>;
  const label = d < 0 ? `ληγμένη πριν ${Math.abs(d)}η` : `σε ${d}η`;
  const cls = d < 0 ? "text-red-600 font-semibold" : d <= 30 ? "text-amber-600 font-medium" : "text-slate-600";
  return <span className={cls}>{fmtDate(row.current_period_end ?? "")} <span className="text-xs">({label})</span></span>;
}

const columns: Column<Sub>[] = [
  { key: "tenant", header: "Tenant" },
  { key: "plan", header: "Πλάνο" },
  { key: "status", header: "Κατάσταση", render: (r) => <StatusBadge value={r.status} /> },
  { key: "billing_cycle", header: "Κύκλος", render: (r) => cycleEl(r.billing_cycle) },
  { key: "active_now", header: "Ενεργοί", align: "right", hideOnMobile: true, render: (r) => (
    <span className={r.active_now ? "font-semibold text-emerald-600" : "text-slate-400"}>{r.active_now ?? 0} / {r.seats}</span>
  ) },
  { key: "mrr", header: "MRR", align: "right", render: (r) => fmtEur(r.mrr) },
  { key: "started_at", header: "Έναρξη", hideOnMobile: true, render: (r) => fmtDate(r.started_at ?? "") },
  { key: "current_period_end", header: "Λήξη", render: (r) => <Expiry row={r} /> },
];

export default function SubscriptionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "subscriptions"],
    queryFn: () => adminApi<{ items: Sub[]; summary: Summary }>("/admin/subscriptions"), retry: false,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = data?.items ?? [];
  const s = data?.summary;

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">Συνδρομές & λήξεις</h1>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <KpiCard label="Σύνολο" value={fmtNum(s?.total ?? 0)} />
        <KpiCard label="Λήγουν ≤30ημ" value={fmtNum(s?.expiring_30d ?? 0)} accent="amber" />
        <KpiCard label="Ληγμένες" value={fmtNum(s?.expired ?? 0)} accent="rose" />
        <KpiCard label="Trials (≤14ημ)" value={fmtNum(s?.trials_ending_14d ?? 0)} accent="sky" />
        <KpiCard label="MRR" value={fmtEur(s?.mrr ?? 0)} accent="violet" />
      </div>
      {isLoading ? <div className="text-slate-400">Φόρτωση…</div> : (
        <DataTable pageSize={20} columns={columns} rows={rows} rowKey={(r) => r.tenant_id}
          onRowClick={(r) => setOpenId(r.tenant_id)} />
      )}
      {openId && <SubDrawer tenantId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const lbl = "block text-xs font-medium text-slate-500";
const eur = (c?: number) => ((c ?? 0) / 100).toString();
const toCents = (e: string) => Math.round((parseFloat(e) || 0) * 100);

function SubDrawer({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: d, isLoading } = useQuery({
    queryKey: ["admin", "subscription", tenantId],
    queryFn: () => adminApi<SubDetail>(`/admin/subscriptions/${encodeURIComponent(tenantId)}`), retry: false,
  });
  const pkgsQ = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: { _id: string; name?: string }[] }>("/admin/packages"), retry: false });
  const slaListQ = useQuery({ queryKey: ["admin", "sla"], queryFn: () => adminApi<{ items: { _id: string; name?: string }[] }>("/admin/sla"), retry: false });
  const [f, setF] = useState({ billing_cycle: "monthly", price_per_pharmacy: "", current_period_end: "", started_at: "", trial_ends_at: "", seats: "", status: "", sla: "", plan: "", plan_name: "", extra_user_price: "", extra_user_price_yearly: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (d) setF({
      billing_cycle: d.billing_cycle || "monthly",
      price_per_pharmacy: eur(d.price_per_pharmacy),
      current_period_end: (d.current_period_end || "").slice(0, 10),
      started_at: (d.started_at || "").slice(0, 10),
      trial_ends_at: (d.trial_ends_at || "").slice(0, 10),
      seats: String(d.seats ?? 1), status: d.status || "", sla: d.sla || "", plan: d.plan || "",
      plan_name: d.plan_name || "", extra_user_price: eur(d.extra_user_price), extra_user_price_yearly: eur(d.extra_user_price_yearly),
    });
  }, [d]);

  async function save(extra?: Record<string, unknown>) {
    setBusy(true); setNotice(null);
    try {
      const body: Record<string, unknown> = {
        billing_cycle: f.billing_cycle, price_per_pharmacy: toCents(f.price_per_pharmacy),
        current_period_end: f.current_period_end || undefined, seats: parseInt(f.seats) || 1,
        started_at: f.started_at || undefined, trial_ends_at: f.trial_ends_at || undefined,
        status: f.status || undefined, sla: f.sla || undefined, plan: f.plan || undefined,
        plan_name: f.plan_name || undefined,
        extra_user_price: toCents(f.extra_user_price), extra_user_price_yearly: toCents(f.extra_user_price_yearly),
        ...extra,
      };
      await adminApi(`/admin/subscriptions/${encodeURIComponent(tenantId)}`, { method: "PATCH", body: JSON.stringify(body) });
      setNotice("Αποθηκεύτηκε ✓");
      qc.invalidateQueries({ queryKey: ["admin", "subscription", tenantId] });
      qc.invalidateQueries({ queryKey: ["admin", "subscriptions"] });
    } catch { setNotice("Σφάλμα — δοκιμάστε ξανά."); } finally { setBusy(false); }
  }
  async function suspend() {
    if (!(await appConfirm("Απενεργοποίηση συνδρομής λόγω μη πληρωμής; Ο πελάτης δεν θα μπορεί να συνδεθεί.", { title: "Απενεργοποίηση συνδρομής", danger: true, confirmText: "Απενεργοποίηση" }))) return;
    setF((s) => ({ ...s, status: "suspended" }));
    await save({ status: "suspended" });
  }

  return (
    <Modal open onClose={onClose} size="2xl">
      {isLoading || !d ? <div className="text-slate-400">Φόρτωση…</div> : (
        <div>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-900">{d.tenant}</h2>
            <StatusBadge value={d.status} />
          </div>
          {notice && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{notice}</div>}

          {/* snapshot */}
          <div className="mb-5 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-3">
            <div><div className="text-xs text-slate-500">Πλάνο</div><div className="font-medium">{d.plan_name || d.plan || "—"}</div></div>
            <div><div className="text-xs text-slate-500">Κύκλος</div><div className="font-medium">{cycleEl(d.billing_cycle)}</div></div>
            <div><div className="text-xs text-slate-500">MRR</div><div className="font-medium">{fmtEur(d.mrr)}</div></div>
            <div><div className="text-xs text-slate-500">Έναρξη</div><div className="font-medium">{fmtDate(d.started_at ?? "")}</div></div>
            <div><div className="text-xs text-slate-500">Λήξη</div><div className="font-medium">{fmtDate(d.current_period_end ?? "")}</div></div>
            <div><div className="text-xs text-slate-500">Ταυτόχρονοι χρήστες</div><div className="font-medium"><span className={d.active_now ? "text-emerald-600" : ""}>{d.active_now}</span> / {d.users} (θέσεις {d.seats})</div></div>
            <div><div className="text-xs text-slate-500">Κόστος επιπλέον χρήστη</div><div className="font-medium">{fmtEur(d.extra_user_price ?? 0)}/μ · {fmtEur(d.extra_user_price_yearly ?? 0)}/έ</div></div>
            <div><div className="text-xs text-slate-500">SLA</div><div className="font-medium">{d.sla || "—"}</div></div>
            <div><div className="text-xs text-slate-500">Trial λήξη</div><div className="font-medium">{d.trial_ends_at ? fmtDate(d.trial_ends_at) : "—"}</div></div>
          </div>

          {/* edit — όλα τα πεδία είναι επεξεργάσιμα (admin) */}
          <div className="mb-3 text-sm font-semibold text-slate-700">Επεξεργασία</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={lbl}>Πλάνο<select className={`mt-1 ${inp}`} value={f.plan} onChange={(e) => { const p = (pkgsQ.data?.items ?? []).find((x) => x._id === e.target.value); setF({ ...f, plan: e.target.value, plan_name: p?.name || f.plan_name }); }}>
              <option value="">—</option>
              {(pkgsQ.data?.items ?? []).map((p) => <option key={p._id} value={p._id}>{p.name || p._id}</option>)}
              {f.plan && !(pkgsQ.data?.items ?? []).some((p) => p._id === f.plan) && <option value={f.plan}>{f.plan_name || f.plan}</option>}
            </select></label>
            <label className={lbl}>Όνομα πλάνου<input className={`mt-1 ${inp}`} value={f.plan_name} onChange={(e) => setF({ ...f, plan_name: e.target.value })} /></label>
            <label className={lbl}>Κύκλος<select className={`mt-1 ${inp}`} value={f.billing_cycle} onChange={(e) => setF({ ...f, billing_cycle: e.target.value })}><option value="monthly">Μηνιαία</option><option value="yearly">Ετήσια</option></select></label>
            <label className={lbl}>Τιμή/φαρμακείο (€)<input type="number" className={`mt-1 ${inp}`} value={f.price_per_pharmacy} onChange={(e) => setF({ ...f, price_per_pharmacy: e.target.value })} /></label>
            <label className={lbl}>Κόστος επιπλέον χρήστη (€/μήνα)<input type="number" className={`mt-1 ${inp}`} value={f.extra_user_price} onChange={(e) => setF({ ...f, extra_user_price: e.target.value })} /></label>
            <label className={lbl}>Κόστος επιπλέον χρήστη (€/έτος)<input type="number" className={`mt-1 ${inp}`} value={f.extra_user_price_yearly} onChange={(e) => setF({ ...f, extra_user_price_yearly: e.target.value })} /></label>
            <label className={lbl}>Θέσεις<input type="number" className={`mt-1 ${inp}`} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></label>
            <label className={lbl}>Έναρξη<input type="date" className={`mt-1 ${inp}`} value={f.started_at} onChange={(e) => setF({ ...f, started_at: e.target.value })} /></label>
            <label className={lbl}>Λήξη συνδρομής<input type="date" className={`mt-1 ${inp}`} value={f.current_period_end} onChange={(e) => setF({ ...f, current_period_end: e.target.value })} /></label>
            <label className={lbl}>Λήξη Trial<input type="date" className={`mt-1 ${inp}`} value={f.trial_ends_at} onChange={(e) => setF({ ...f, trial_ends_at: e.target.value })} /></label>
            <label className={lbl}>SLA<select className={`mt-1 ${inp}`} value={f.sla} onChange={(e) => setF({ ...f, sla: e.target.value })}>
              <option value="">—</option>
              {(slaListQ.data?.items ?? []).map((s) => <option key={s._id} value={s._id}>{s.name || s._id}</option>)}
              {f.sla && !(slaListQ.data?.items ?? []).some((s) => s._id === f.sla) && <option value={f.sla}>{f.sla}</option>}
            </select></label>
            <label className={lbl}>Κατάσταση<select className={`mt-1 ${inp}`} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {["active", "trial", "past_due", "suspended", "cancelled"].map((x) => <option key={x} value={x}>{x}</option>)}
            </select></label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={() => save()} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "Αποθήκευση…" : "Αποθήκευση"}</button>
            <button onClick={suspend} disabled={busy} className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100">⛔ Απενεργοποίηση (μη πληρωμή)</button>
          </div>

          {/* invoices */}
          <div className="mt-6">
            <div className="mb-2 text-sm font-semibold text-slate-700">Παραστατικά ({d.invoices.length})</div>
            {d.invoices.length === 0 ? <div className="text-sm text-slate-400">Δεν έχουν εκδοθεί παραστατικά.</div> : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                    <th className="px-3 py-2 text-left">Αριθμός</th><th className="px-3 py-2 text-left">Τύπος</th>
                    <th className="px-3 py-2 text-left">Ημ/νία</th><th className="px-3 py-2 text-right">Σύνολο</th><th className="px-3 py-2 text-left">ΑΑΔΕ</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.invoices.map((iv) => (
                      <tr key={iv.id}>
                        <td className="px-3 py-2 font-medium">{iv.full_number}</td>
                        <td className="px-3 py-2">{iv.doc_type}</td>
                        <td className="px-3 py-2">{iv.issue_date}</td>
                        <td className="px-3 py-2 text-right">{fmtEur(iv.total)}</td>
                        <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] ${iv.aade_status === "transmitted" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{iv.aade_status === "transmitted" ? "Διαβιβάστηκε" : "Εκκρεμεί ΑΑΔΕ"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
