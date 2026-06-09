"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Salad, Search, Mail, Printer, Loader2, Check, X, User } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";

type Hit = { patient_id: string; name?: string | null; amka?: string | null; birth_year?: number | null; age_group?: string | null; last_seen?: string | null; mobile?: string | null; email?: string | null; consent?: boolean };
type Section = { title: string; drugs: string[]; favor: string; avoid: string; why: string };
type Plan = { patient_id: string; name?: string | null; email?: string | null; mobile?: string | null; sections: Section[] };

export default function NutritionPage() {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Hit | null>(null);

  const search = useQuery({ queryKey: ["pat-search", q], queryFn: () => api<{ items: Hit[] }>(`/patients/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2, retry: false });
  const plan = useQuery({ queryKey: ["nutrition", picked?.patient_id], queryFn: () => api<Plan>(`/advisor/nutrition/${picked!.patient_id}`), enabled: !!picked, retry: false });
  const email = useMutation({ mutationFn: () => api<{ to: string }>(`/advisor/nutrition/${picked!.patient_id}/email`, { method: "POST" }), onSuccess: (r) => alert("Στάλθηκε στο " + r.to + " ✅"), onError: (e: Error) => alert("Αποτυχία: " + e.message) });

  return (
    <ModuleGuard module="patient_analytics">
      <div className="mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 p-5 text-white shadow-lg print:hidden">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" /></span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/80">AI · Διατροφικές οδηγίες</span>
        </div>
        <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight"><Salad className="h-6 w-6" /> Σύμβουλος Διατροφής</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/90">Βρες έναν πελάτη και στείλε του εξατομικευμένες διατροφικές συμβουλές, βασισμένες στα φάρμακα & τις δραστικές που λαμβάνει — για καλύτερα αποτελέσματα στη θεραπεία του.</p>
      </div>

      {/* search */}
      <div className="mb-4 print:hidden">
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} placeholder="Αναζήτηση: όνομα, ΑΜΚΑ, τηλέφωνο ή email…"
            className="w-full rounded-xl border border-slate-300 py-3 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none" />
        </div>
        {q.trim().length >= 2 && !picked && (
          <div className="mt-2 max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            {search.isLoading ? <div className="p-3 text-sm text-slate-400">Αναζήτηση…</div> :
              (search.data?.items?.length ?? 0) === 0 ? <div className="p-3 text-sm text-slate-400">Καμία εγγραφή.</div> :
                search.data!.items.map((h) => (
                  <button key={h.patient_id} onClick={() => setPicked(h)} className="flex w-full items-center justify-between gap-3 border-b border-slate-50 px-4 py-2.5 text-left last:border-0 hover:bg-slate-50">
                    <span className="flex items-center gap-2"><User className="h-4 w-4 text-slate-400" /><span className="font-medium text-slate-800">{h.name || "—"}</span><span className="text-xs text-slate-400">{h.amka || ""}</span></span>
                    <span className="text-xs text-slate-400">{h.mobile || h.email || ""}</span>
                  </button>
                ))}
          </div>
        )}
      </div>

      {/* plan */}
      {picked && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{plan.data?.name || picked.name}</h2>
              <p className="text-sm text-slate-500">{picked.amka ? `ΑΜΚΑ ${picked.amka} · ` : ""}{plan.data?.email || "χωρίς email στην καρτέλα"}</p>
            </div>
            <div className="flex gap-2 print:hidden">
              <button onClick={() => setPicked(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /> Άλλος</button>
              <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Printer className="h-4 w-4" /> Εκτύπωση</button>
              <button onClick={() => email.mutate()} disabled={email.isPending || !plan.data?.email}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                {email.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : email.isSuccess ? <Check className="h-4 w-4" /> : <Mail className="h-4 w-4" />} Email στον ασθενή
              </button>
            </div>
          </div>

          {plan.isLoading ? <div className="text-slate-400">Δημιουργία πλάνου…</div> :
            (plan.data?.sections?.length ?? 0) === 0 ? <PanelCard title="Διατροφικές συμβουλές"><p className="text-sm text-slate-500">Δεν εντοπίστηκαν ειδικές οδηγίες για την τρέχουσα αγωγή.</p></PanelCard> : (
              <div className="grid gap-3 lg:grid-cols-2">
                {plan.data!.sections.map((s, i) => (
                  <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
                    <div className="text-base font-semibold text-emerald-700">{s.title}</div>
                    <div className="mt-0.5 text-xs text-slate-400">Σχετικά φάρμακα: {s.drugs.join(", ") || "—"}</div>
                    <div className="mt-3 text-sm text-slate-700"><b className="text-emerald-600">✓ Προτίμησε:</b> {s.favor}</div>
                    <div className="mt-1.5 text-sm text-slate-700"><b className="text-rose-600">✕ Πρόσεξε:</b> {s.avoid}</div>
                    <div className="mt-1.5 text-xs text-slate-500">{s.why}</div>
                  </div>
                ))}
              </div>
            )}
          <p className="mt-4 text-xs text-slate-400">Οι συμβουλές είναι γενικές & ενημερωτικές, δεν υποκαθιστούν ιατρική/διαιτολογική γνωμάτευση.</p>
        </div>
      )}
    </ModuleGuard>
  );
}
