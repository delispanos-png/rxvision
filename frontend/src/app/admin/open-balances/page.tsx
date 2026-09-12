"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Wallet, AlertTriangle, MailWarning, MailX, Send, X, Loader2 } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { fmtEur, fmtNum, fmtDate } from "@/lib/formatters";
import { KpiCard } from "@/components/kpi/KpiCard";

type Inv = { id: string; number: string; issue_date: string | null; total: number; description: string; days: number | null };
type Row = {
  tenant_id: string; tenant_name: string; email: string | null; status: string;
  open_cents: number; oldest_days: number; overdue: boolean;
  last_reminded_at: string | null; invoices: Inv[];
};
type Res = {
  items: Row[];
  summary: { total_cents: number; tenants: number; overdue_tenants: number; overdue_cents: number; no_email: number; due_after_days: number };
};

export default function OpenBalancesPage() {
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notify, setNotify] = useState(false);

  const q = useQuery({
    queryKey: ["admin", "open-balances"],
    queryFn: () => adminApi<Res>("/admin/open-balances"),
    retry: false,
  });
  const rows = useMemo(
    () => (q.data?.items ?? []).filter((r) => !onlyOverdue || r.overdue),
    [q.data, onlyOverdue]);
  const s = q.data?.summary;
  const selectable = rows.filter((r) => r.email);
  const allSel = selectable.length > 0 && selectable.every((r) => sel.has(r.tenant_id));

  const toggle = (id: string) =>
    setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="w-full">
      <h1 className="mb-1 text-xl font-bold text-slate-900 dark:text-slate-100">Ανοιχτά υπόλοιπα</h1>
      <p className="mb-6 text-sm text-slate-500">
        Ποιοι πελάτες χρωστούν, πόσα και από πότε — και υπενθύμιση εξόφλησης ώστε να μη διακοπούν οι υπηρεσίες τους.
      </p>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Συνολικό ανοιχτό" value={fmtEur(s?.total_cents ?? 0)} icon={Wallet} accent="violet" />
        <KpiCard label="Πελάτες με υπόλοιπο" value={fmtNum(s?.tenants ?? 0)} icon={MailWarning} accent="indigo" />
        <KpiCard label={`Ληξιπρόθεσμα (>${s?.due_after_days ?? 15} ημ.)`} value={fmtEur(s?.overdue_cents ?? 0)} icon={AlertTriangle} accent="rose" />
        <KpiCard label="Χωρίς email" value={fmtNum(s?.no_email ?? 0)} icon={MailX} accent="amber" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={onlyOverdue} onChange={(e) => setOnlyOverdue(e.target.checked)} />
          Μόνο ληξιπρόθεσμα
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={allSel}
            onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((r) => r.tenant_id)) : new Set())} />
          Επιλογή όλων ({selectable.length})
        </label>
        <button onClick={() => setNotify(true)} disabled={sel.size === 0}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          <Send className="h-4 w-4" /> Υπενθύμιση σε {sel.size}
        </button>
      </div>

      {q.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700">
          Κανένα ανοιχτό υπόλοιπο. 🎉
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full min-w-[840px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="px-3 py-2">Πελάτης</th>
                <th className="px-3 py-2">Κατάσταση</th>
                <th className="px-3 py-2 text-right">Υπόλοιπο</th>
                <th className="px-3 py-2 text-right">Παλαιότερο</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Τελ. υπενθύμιση</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <>
                  <tr key={r.tenant_id}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50 ${r.overdue ? "bg-rose-50/40 dark:bg-rose-950/10" : ""}`}
                    onClick={() => setOpen(open === r.tenant_id ? null : r.tenant_id)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" disabled={!r.email} checked={sel.has(r.tenant_id)}
                        onChange={() => toggle(r.tenant_id)} title={r.email ? "" : "Χωρίς email — δεν μπορεί να ειδοποιηθεί"} />
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">
                      {r.tenant_name}
                      <span className="ml-2 text-[11px] text-slate-400">{r.invoices.length} παραστ.</span>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.status}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">{fmtEur(r.open_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.overdue
                        ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">{r.oldest_days} ημ.</span>
                        : <span className="text-slate-500">{r.oldest_days} ημ.</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.email ?? <span className="font-semibold text-amber-600">λείπει</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.last_reminded_at ? fmtDate(r.last_reminded_at) : "—"}</td>
                  </tr>
                  {open === r.tenant_id && (
                    <tr key={r.tenant_id + "-d"} className="border-t border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-800/40">
                      <td></td>
                      <td colSpan={6} className="px-3 py-3">
                        <table className="w-full text-xs">
                          <tbody>
                            {r.invoices.map((i) => (
                              <tr key={i.id} className="border-b border-slate-200 last:border-0 dark:border-slate-700">
                                <td className="py-1.5 pr-4 font-mono text-slate-600 dark:text-slate-300">{i.number}</td>
                                <td className="py-1.5 pr-4 text-slate-500">{i.description}</td>
                                <td className="py-1.5 pr-4 text-slate-500">{i.issue_date ? fmtDate(i.issue_date) : "—"}</td>
                                <td className="py-1.5 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">{fmtEur(i.total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notify && <NotifyModal ids={[...sel]} onClose={() => setNotify(false)}
        onDone={() => { setNotify(false); setSel(new Set()); qc.invalidateQueries({ queryKey: ["admin", "open-balances"] }); }} />}
    </div>
  );
}

function NotifyModal({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ recipients: number; total_cents: number; skipped: { no_email: number; too_soon: number } } | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number; recipients: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const call = async (dry: boolean) => {
    setErr(null); setBusy(true);
    try {
      const r = await adminApi<Record<string, never> & { recipients: number; sent: number; failed: number; total_cents: number; skipped: { no_email: number; too_soon: number } }>(
        "/admin/open-balances/notify",
        { method: "POST", body: JSON.stringify({ tenant_ids: ids, note: note.trim() || null, dry_run: dry }) });
      if (dry) setPreview(r); else setResult(r);
    } catch { setErr(dry ? "Αποτυχία προεπισκόπησης." : "Αποτυχία αποστολής — έλεγξε τις ρυθμίσεις SMTP."); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Υπενθύμιση εξόφλησης</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {result ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Στάλθηκαν {result.sent} / {result.recipients}{result.failed ? ` · ${result.failed} απέτυχαν` : ""}
            </div>
            <button onClick={onDone} className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700">Κλείσιμο</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              Επιλεγμένοι: <b>{ids.length}</b>. Το email φεύγει από τον <b>κεντρικό λογαριασμό της πλατφόρμας</b> —
              δεν χρεώνεται το πορτοφόλι μηνυμάτων του πελάτη. Παραλείπεται όποιος ειδοποιήθηκε τις τελευταίες 7 ημέρες.
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-600 dark:text-slate-300">Προσωπικό σημείωμα (προαιρετικό)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                placeholder="π.χ. Αν υπάρχει κάποιο θέμα με το τιμολόγιο, πες μας να το δούμε."
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            </label>
            {preview && (
              <div className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200">
                Θα λάβουν <b>{preview.recipients}</b> · σύνολο <b>{fmtEur(preview.total_cents)}</b>
                {preview.skipped.too_soon ? ` · ${preview.skipped.too_soon} παραλείπονται (πρόσφατη υπενθύμιση)` : ""}
                {preview.skipped.no_email ? ` · ${preview.skipped.no_email} χωρίς email` : ""}
              </div>
            )}
            {err && <div className="text-sm text-rose-600">{err}</div>}
            <div className="flex items-center gap-2">
              <button onClick={() => call(true)} disabled={busy}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200">
                Προεπισκόπηση
              </button>
              <button onClick={() => call(false)} disabled={busy || !preview}
                title={preview ? "" : "Κάνε πρώτα προεπισκόπηση"}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Αποστολή
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
