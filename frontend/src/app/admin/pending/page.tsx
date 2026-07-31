"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Clock, Mail, Loader2, Send } from "lucide-react";
import { useState } from "react";

type Row = {
  id: string; pharmacy_name?: string; owner_email?: string; owner_name?: string;
  status?: string; amount_cents?: number; package_code?: string; payment_method?: string;
  created_at?: string; paid_at?: string; afm?: string;
};

const eur = (c?: number) => `${((c ?? 0) / 100).toFixed(2)} €`;
const fdate = (s?: string) => (s ? new Date(s).toLocaleString("el-GR", { dateStyle: "short", timeStyle: "short" }) : "—");
const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "Πλήρωσε — εκκρεμεί ολοκλήρωση", cls: "bg-amber-100 text-amber-700" },
  awaiting_payment: { label: "Αναμονή πληρωμής", cls: "bg-slate-100 text-slate-600" },
  awaiting_bank_approval: { label: "Αναμονή έγκρισης κατάθεσης", cls: "bg-slate-100 text-slate-600" },
};

export default function AdminPendingPage() {
  const q = useQuery({ queryKey: ["pending-registrations"], queryFn: () => adminApi<{ items: Row[] }>("/admin/pending-registrations") });
  const [sent, setSent] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (id: string) => adminApi(`/admin/pending-registrations/${id}/resend`, { method: "POST" }),
    onSuccess: (_d, id) => { setSent(id); setTimeout(() => setSent(null), 2500); },
  });
  const rows = q.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2"><Clock className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">Εκκρεμείς εγγραφές</h1></div>
      <p className="mb-5 text-sm text-slate-500">Εγγραφές που <b>πλήρωσαν αλλά δεν όρισαν κωδικό</b> (ή εκκρεμεί πληρωμή). Ξαναστείλε το link ολοκλήρωσης για να μη χαθεί ο πελάτης.</p>

      {q.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : rows.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400">Καμία εκκρεμής εγγραφή 🎉</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="px-3 py-2 text-left">Φαρμακείο</th><th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Κατάσταση</th><th className="px-3 py-2 text-right">Ποσό</th>
              <th className="px-3 py-2 text-left">Ημ/νία</th><th className="px-3 py-2 text-right">Ενέργεια</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const st = STATUS[r.status ?? ""] ?? { label: r.status ?? "—", cls: "bg-slate-100 text-slate-600" };
                return (
                  <tr key={r.id}>
                    <td className="px-3 py-2"><div className="font-medium text-slate-800">{r.pharmacy_name || "—"}</div>{r.afm && <div className="text-[11px] text-slate-400">ΑΦΜ {r.afm}</div>}</td>
                    <td className="px-3 py-2 text-slate-600">{r.owner_email || "—"}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${st.cls}`}>{st.label}</span></td>
                    <td className="px-3 py-2 text-right font-medium">{eur(r.amount_cents)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fdate(r.paid_at || r.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.status === "paid" ? (
                        sent === r.id ? <span className="text-xs font-semibold text-emerald-600">✓ Στάλθηκε</span> :
                        <button onClick={() => resend.mutate(r.id)} disabled={resend.isPending}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                          {resend.isPending && resend.variables === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Επαναποστολή link
                        </button>
                      ) : <span className="inline-flex items-center gap-1 text-[11px] text-slate-400"><Mail className="h-3 w-3" /> —</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
