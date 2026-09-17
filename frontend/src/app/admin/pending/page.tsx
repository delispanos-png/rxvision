"use client";

/* Εκκρεμείς εγγραφές — ΤΡΕΙΣ διαφορετικές καταστάσεις, όχι μία λίστα.
   Η παλιά σελίδα έλεγε «πλήρωσαν αλλά δεν ολοκλήρωσαν» για γραμμές που δεν είχαν πληρώσει
   καθόλου, και κρατούσε για μήνες απόπειρες φαρμακείων που τελικά έγιναν πελάτες. */

import { useQuery, useMutation } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { Clock, Loader2, Send, CreditCard, Landmark, ShoppingCart, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type Row = {
  id: string; pharmacy_name?: string; owner_email?: string; owner_name?: string;
  status?: string; kind?: string; stale?: boolean; amount_cents?: number;
  package_code?: string; payment_method?: string; created_at?: string; paid_at?: string; afm?: string;
};

const eur = (c?: number) => `${((c ?? 0) / 100).toFixed(2)} €`;
const fdate = (s?: string) => (s ? new Date(s).toLocaleString("el-GR",
  { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Athens" }) : "—");

export default function AdminPendingPage() {
  const q = useQuery({ queryKey: ["pending-registrations"], queryFn: () => adminApi<{ items: Row[] }>("/admin/pending-registrations") });
  const [sent, setSent] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (id: string) => adminApi(`/admin/pending-registrations/${id}/resend`, { method: "POST" }),
    onSuccess: (_d, id) => { setSent(id); setTimeout(() => setSent(null), 2500); },
  });

  const rows = q.data?.items ?? [];
  const paid = rows.filter((r) => r.kind === "paid_not_completed");
  const bank = rows.filter((r) => r.kind === "bank_pending");
  const abandoned = rows.filter((r) => r.kind === "abandoned");

  return (
    <div className="w-full px-4 py-6">
      <div className="mb-1 flex items-center gap-2">
        <Clock className="h-6 w-6 text-brand-600" />
        <h1 className="text-xl font-bold text-slate-900">Εκκρεμείς εγγραφές</h1>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        Τρεις διαφορετικές καταστάσεις, με διαφορετική επείγουσα ανάγκη η καθεμία. Όσοι τελικά
        έγιναν πελάτες δεν εμφανίζονται εδώ.
      </p>

      {q.isLoading ? <div className="text-slate-400">Φόρτωση…</div> : (
        <div className="space-y-6">
          {/* 1. ΤΟ ΕΠΕΙΓΟΝ: πλήρωσε και δεν μπήκε ποτέ μέσα */}
          <Section
            icon={<CreditCard className="h-4 w-4" />} tone="amber"
            title="Πλήρωσαν και δεν όρισαν κωδικό"
            hint="Έχουν χρεωθεί αλλά δεν έχουν λογαριασμό. Ξαναστείλε τους το link ολοκλήρωσης."
            empty="Κανένας. Κανείς δεν έχει πληρώσει χωρίς να πάρει λογαριασμό."
            rows={paid}
            action={(r) => (sent === r.id
              ? <span className="text-xs font-semibold text-emerald-600">✓ Στάλθηκε</span>
              : <button onClick={() => resend.mutate(r.id)} disabled={resend.isPending}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50">
                  {resend.isPending && resend.variables === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Επαναποστολή link
                </button>)}
          />

          {/* 2. ΤΡΑΠΕΖΙΚΗ ΚΑΤΑΘΕΣΗ: περιμένει ΕΜΑΣ */}
          <Section
            icon={<Landmark className="h-4 w-4" />} tone="sky"
            title="Περιμένουν έγκριση κατάθεσης"
            hint="Επέλεξαν τραπεζική κατάθεση. Έλεγξε τον λογαριασμό και ενέκρινε."
            empty="Καμία κατάθεση σε αναμονή."
            rows={bank}
            action={() => <span className="text-[11px] text-slate-400">έλεγξε την τράπεζα</span>}
          />

          {/* 3. ΕΓΚΑΤΑΛΕΙΜΜΕΝΟ ΤΑΜΕΙΟ: δεν πλήρωσαν — δουλειά πωλήσεων, όχι υποστήριξης */}
          <Section
            icon={<ShoppingCart className="h-4 w-4" />} tone="slate"
            title="Ξεκίνησαν και δεν πλήρωσαν"
            hint="Έφτασαν στο ταμείο και σταμάτησαν. Δεν χρωστάνε τίποτα — είναι υποψήφιοι πελάτες."
            empty="Κανένα εγκαταλειμμένο ταμείο."
            rows={abandoned}
            action={() => <span className="text-[11px] text-slate-400">δεν χρεώθηκε</span>}
            footer={
              <Link href="/admin/leads" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline">
                Δες τους στα Leads &amp; Conversions <ArrowRight className="h-3.5 w-3.5" />
              </Link>}
          />
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  amber: "border-amber-200 bg-amber-50/50", sky: "border-sky-200 bg-sky-50/40",
  slate: "border-slate-200 bg-white",
};

function Section({ icon, tone, title, hint, empty, rows, action, footer }: {
  icon: React.ReactNode; tone: string; title: string; hint: string; empty: string;
  rows: Row[]; action: (r: Row) => React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <section className={`rounded-2xl border p-4 ${TONE[tone] ?? TONE.slate}`}>
      <div className="mb-0.5 flex items-center gap-2 text-sm font-bold text-slate-800">
        {icon}{title}
        <span className="rounded-full bg-white px-2 text-xs font-bold text-slate-500 ring-1 ring-slate-200">{rows.length}</span>
      </div>
      <p className="mb-3 text-xs text-slate-500">{hint}</p>
      {!rows.length ? <p className="text-sm text-slate-400">{empty}</p> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="px-3 py-2 text-left">Φαρμακείο</th><th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-right">Ποσό</th><th className="px-3 py-2 text-left">Ημ/νία</th>
              <th className="px-3 py-2 text-right">Ενέργεια</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{r.pharmacy_name || "—"}</div>
                    {r.afm && <div className="text-[11px] text-slate-400">ΑΦΜ {r.afm}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.owner_email || "—"}</td>
                  <td className="px-3 py-2 text-right font-medium">{eur(r.amount_cents)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fdate(r.paid_at || r.created_at)}</td>
                  <td className="px-3 py-2 text-right">{action(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footer && !!rows.length && <div className="mt-2.5">{footer}</div>}
    </section>
  );
}
