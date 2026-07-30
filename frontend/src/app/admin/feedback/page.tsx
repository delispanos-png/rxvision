"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { MessageSquare, Ticket, Check, Loader2, ChevronDown } from "lucide-react";

type Answers = {
  strong_points?: string; weak_points?: string; would_choose?: string; pricing_view?: string;
  churn_reason?: string; most_useful?: string; missing?: string; nps?: number;
  competitor?: string; contact_ok?: boolean; contact_phone?: string;
};
type Fb = {
  _id: string; tenant_id: string; pharmacy_name?: string; owner_email?: string;
  status: string; created_at?: string; submitted_at?: string; answers?: Answers; coupon_code?: string;
};

const A_LABELS: [keyof Answers, string][] = [
  ["strong_points", "Δυνατά σημεία"], ["weak_points", "Αδύνατα σημεία"], ["would_choose", "Τι θα το επέλεγε"],
  ["churn_reason", "Λόγος μη-ανανέωσης"], ["pricing_view", "Άποψη κόστους"], ["most_useful", "Πιο χρήσιμο"],
  ["missing", "Τι έλειπε"], ["nps", "NPS (0–10)"], ["competitor", "Άλλο εργαλείο"],
];

function Row({ f }: { f: Fb }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(20);
  const [days, setDays] = useState(14);
  const [couponForm, setCouponForm] = useState(false);
  const send = useMutation({
    mutationFn: () => adminApi(`/admin/feedback/${f._id}/coupon`, { method: "POST", body: JSON.stringify({ discount_pct: pct, days }) }),
    onSuccess: () => { setCouponForm(false); qc.invalidateQueries({ queryKey: ["admin", "feedback"] }); },
  });
  const submitted = f.status === "submitted";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-slate-900">{f.pharmacy_name || f.tenant_id}</div>
          <div className="text-xs text-slate-400">{f.owner_email} · {submitted ? `απάντησε ${f.submitted_at?.slice(0, 10)}` : "στάλθηκε, χωρίς απάντηση"}</div>
        </div>
        <div className="flex items-center gap-2">
          {f.coupon_code && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Coupon: {f.coupon_code}</span>}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${submitted ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>{submitted ? "Απαντήθηκε" : "Εκκρεμεί"}</span>
          {submitted && <button onClick={() => setOpen((o) => !o)} className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} /></button>}
        </div>
      </div>

      {open && submitted && (
        <dl className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm">
          {A_LABELS.map(([k, label]) => (f.answers?.[k] !== undefined && f.answers?.[k] !== "" && f.answers?.[k] !== null) && (
            <div key={k} className="flex gap-2"><dt className="w-40 shrink-0 text-xs font-medium text-slate-500">{label}</dt><dd className="text-slate-800">{String(f.answers?.[k])}</dd></div>
          ))}
          {f.answers?.contact_ok && <div className="flex gap-2"><dt className="w-40 shrink-0 text-xs font-medium text-emerald-600">📞 Θέλει επικοινωνία</dt><dd className="text-slate-800">{f.answers?.contact_phone || "—"}</dd></div>}
        </dl>
      )}

      <div className="mt-3 border-t border-slate-100 pt-3">
        {!couponForm ? (
          <button onClick={() => setCouponForm(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"><Ticket className="h-3.5 w-3.5" /> {f.coupon_code ? "Νέο coupon" : "Στείλε εκπτωτικό coupon"}</button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">Έκπτωση %<input type="number" min={1} max={90} value={pct} onChange={(e) => setPct(Math.min(90, Math.max(1, parseInt(e.target.value) || 1)))} className="mt-1 block w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label className="text-xs text-slate-500">Ισχύς (ημέρες)<input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.min(365, Math.max(1, parseInt(e.target.value) || 1)))} className="mt-1 block w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <button disabled={send.isPending} onClick={() => send.mutate()} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Στείλε ({pct}%)</button>
            <button onClick={() => setCouponForm(false)} className="text-xs text-slate-400 hover:text-slate-600">Άκυρο</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminFeedbackPage() {
  const q = useQuery({ queryKey: ["admin", "feedback"], queryFn: () => adminApi<{ items: Fb[] }>("/admin/feedback"), retry: false });
  const items = q.data?.items || [];
  const answered = items.filter((f) => f.status === "submitted").length;
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2"><MessageSquare className="h-6 w-6 text-brand-600" /><h1 className="text-xl font-bold text-slate-900">Αξιολογήσεις δοκιμαστικών</h1></div>
      <p className="mb-5 text-sm text-slate-500">Φαρμακεία με ληγμένο trial που δεν ανανέωσαν — γνώμες & χειροκίνητα εκπτωτικά coupons. <b>{answered}</b>/{items.length} απαντήθηκαν.</p>
      {q.isLoading ? <div className="grid place-items-center py-20"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
        : items.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400">Δεν υπάρχουν ακόμη αξιολογήσεις.</div>
        : <div className="space-y-3">{items.map((f) => <Row key={f._id} f={f} />)}</div>}
    </div>
  );
}
