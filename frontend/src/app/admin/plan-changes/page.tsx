"use client";

/* Αλλαγές πακέτου — ΓΝΩΣΗ, όχι ουρά έγκρισης.
   Την αλλαγή την κάνει ο πελάτης μόνος του και ισχύει στη λήξη της περιόδου του. Δεν του
   δίνουμε δικαιοδοσία και δεν του ζητάμε τίποτα· θέλουμε απλώς να ΞΕΡΟΥΜΕ τι αλλάζει, πότε,
   και πόσο πιάνει. Η μόνη ενέργεια που μένει είναι η επιβεβαίωση τραπεζικής κατάθεσης — και
   εμφανίζεται ΜΟΝΟ όταν υπάρχει τέτοια. */

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { adminApi } from "@/lib/adminClient";
import { ArrowUp, ArrowDown, Building2, Check, Loader2, TrendingDown, TrendingUp, History } from "lucide-react";

type Up = {
  tenant_id: string; tenant_name?: string; from_plan?: string; to_plan?: string; to_plan_name?: string;
  kind?: "upgrade" | "downgrade"; status?: string; method?: string; billing_cycle?: string;
  from_price?: number; to_price?: number; delta?: number;
  effective_at?: string | null; requested_by?: string; requested_at?: string;
};
type Hist = {
  _id: string; tenant_id: string; tenant_name?: string; at: string; kind?: string;
  from_plan?: string; to_plan?: string; to_plan_name?: string;
  from_price?: number; to_price?: number; delta?: number; source?: string; requested_by?: string;
};
type Broken = { tenant_id: string; tenant_name?: string; broken?: boolean; broken_reason?: string | null;
                method?: string; status?: string };
type Res = { items: Broken[]; upcoming: Up[]; monthly_delta: number; history: Hist[] };

const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format((c || 0) / 100);
const signed = (c?: number) => `${(c ?? 0) > 0 ? "+" : ""}${eur(c)}`;
const gr = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR",
  { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Athens" }) : "—");
const inDays = (s?: string | null) => {
  if (!s) return null;
  const d = Math.ceil((new Date(s).getTime() - Date.now()) / 86400000);
  return d <= 0 ? "άμεσα" : d === 1 ? "αύριο" : `σε ${d} μέρες`;
};
const CYCLE: Record<string, string> = { yearly: "ετήσια", monthly: "μηνιαία" };

export default function PlanChangesPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "plan-changes"], queryFn: () => adminApi<Res>("/admin/plan-changes"), retry: false, refetchInterval: 60000 });

  // `clear-broken` είναι ΞΕΧΩΡΙΣΤΗ διαδρομή από την ακύρωση: η ακύρωση κρατά έλεγχο κατάστασης
  // (για να μη σβηστεί πληρωμή στον αέρα) και γι' αυτό δεν μπορούσε ποτέ να πιάσει τις
  // χαλασμένες — το κουμπί «έπαιζε» χωρίς να κάνει τίποτα.
  const act = async (tid: string, action: "approve" | "clear-broken") => {
    const ok = action === "approve"
      ? await appConfirm("Επιβεβαίωση λήψης κατάθεσης & ενεργοποίηση της αναβάθμισης;", { title: "Έγκριση", confirmText: "Έγκριση" })
      : await appConfirm("Να καθαριστεί αυτή η χαλασμένη εγγραφή; Κρατάμε αντίγραφο.", { title: "Καθαρισμός", danger: true, confirmText: "Καθάρισε" });
    if (!ok) return;
    setBusy(tid);
    try {
      await adminApi(`/admin/plan-changes/${tid}/${action}`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["admin", "plan-changes"] });
    } catch {
      appAlert("Δεν έγινε τίποτα — η εγγραφή δεν βρέθηκε ή έχει ήδη καθαριστεί.");
    } finally { setBusy(null); }
  };

  const up = q.data?.upcoming ?? [];
  const hist = q.data?.history ?? [];
  const broken = (q.data?.items ?? []).filter((r) => r.broken);
  const bank = up.filter((r) => r.method === "bank" && r.status === "awaiting_payment");
  const delta = q.data?.monthly_delta ?? 0;

  return (
    <div className="w-full space-y-5">
      <header>
        <h1 className="text-xl font-bold text-slate-900">Αλλαγές πακέτου</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ποιοι πελάτες έχουν επιλέξει να ανανεώσουν σε άλλο πακέτο, και τι άλλαξε μέχρι τώρα.
          Την αλλαγή την κάνουν μόνοι τους — εδώ απλώς τη βλέπεις.
        </p>
      </header>

      {/* Επιβεβαίωση κατάθεσης — η ΜΟΝΗ ενέργεια που χρειάζεται άνθρωπο, και μόνο όταν υπάρχει */}
      {!!bank.length && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-900">
            <Building2 className="h-4 w-4" />Περιμένουν επιβεβαίωση κατάθεσης ({bank.length})
          </h2>
          {bank.map((r) => (
            <div key={r.tenant_id} className="flex flex-wrap items-center gap-2 border-t border-amber-100 py-2 text-sm">
              <span className="font-semibold text-slate-800">{r.tenant_name || r.tenant_id}</span>
              <span className="text-slate-600">→ {r.to_plan_name} · {eur(r.to_price)}</span>
              <button onClick={() => act(r.tenant_id, "approve")} disabled={busy === r.tenant_id}
                className="ml-auto inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy === r.tenant_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Μπήκαν τα χρήματα
              </button>
            </div>
          ))}
        </section>
      )}

      {/* ΕΡΧΟΝΤΑΙ ΣΤΗΝ ΑΝΑΝΕΩΣΗ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-slate-800">Έρχονται στην ανανέωση</h2>
          <span className="rounded-full bg-slate-100 px-2 text-xs font-bold text-slate-500">{up.length}</span>
          {!!up.length && (
            <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${delta < 0 ? "bg-rose-100 text-rose-700" : delta > 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
              {delta < 0 ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
              {signed(delta)}/μήνα όταν ισχύσουν όλες
            </span>
          )}
        </div>
        {!up.length ? (
          <p className="text-sm text-slate-400">Κανένας πελάτης δεν έχει προγραμματίσει αλλαγή πακέτου.</p>
        ) : (
          <div className="mt-2 divide-y divide-slate-100">
            {up.map((r) => (
              <div key={r.tenant_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <span className="min-w-[180px] flex-1 font-semibold text-slate-800">{r.tenant_name || r.tenant_id}</span>
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  {r.kind === "upgrade" ? <ArrowUp className="h-3.5 w-3.5 text-emerald-600" /> : <ArrowDown className="h-3.5 w-3.5 text-amber-600" />}
                  {r.from_plan} → <b className="text-slate-800">{r.to_plan_name || r.to_plan}</b>
                </span>
                <span className={`font-bold tabular-nums ${(r.delta ?? 0) < 0 ? "text-rose-600" : "text-emerald-600"}`}>{signed(r.delta)}</span>
                <span className="text-xs text-slate-400">{CYCLE[r.billing_cycle ?? ""] ?? r.billing_cycle}</span>
                <span className="text-xs text-slate-500">ισχύει {gr(r.effective_at)} <span className="text-slate-400">({inDays(r.effective_at)})</span></span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ΤΙ ΕΧΕΙ ΑΛΛΑΞΕΙ */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
          <History className="h-4 w-4" />Τι έχει αλλάξει <span className="text-xs font-normal text-slate-400">(τελευταίοι 12 μήνες)</span>
        </h2>
        {!hist.length ? (
          <p className="text-sm text-slate-400">Καμία αλλαγή πακέτου ακόμη. Από εδώ και πέρα καταγράφεται κάθε μία.</p>
        ) : (
          <div className="mt-2 divide-y divide-slate-100">
            {hist.map((h) => (
              <div key={h._id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <span className="w-20 shrink-0 text-xs text-slate-400">{gr(h.at)}</span>
                <span className="min-w-[160px] flex-1 font-semibold text-slate-800">{h.tenant_name || h.tenant_id}</span>
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  {h.kind === "upgrade" ? <ArrowUp className="h-3.5 w-3.5 text-emerald-600" /> : <ArrowDown className="h-3.5 w-3.5 text-amber-600" />}
                  {h.from_plan} → <b className="text-slate-800">{h.to_plan_name || h.to_plan}</b>
                </span>
                <span className={`font-bold tabular-nums ${(h.delta ?? 0) < 0 ? "text-rose-600" : "text-emerald-600"}`}>{signed(h.delta)}</span>
                <span className="text-xs text-slate-400">{h.requested_by || h.source}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Χαλασμένες εγγραφές — δεν είναι αιτήματα, δεν θα εφαρμοστούν ποτέ */}
      {!!broken.length && (
        <section className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4">
          <h2 className="text-sm font-bold text-rose-900">Χαλασμένες εγγραφές ({broken.length})</h2>
          <p className="mb-2 text-xs text-rose-700">
            Κατάλοιπα παλιότερης μορφής ή πακέτο που δεν υπάρχει. Δεν πρόκειται να εφαρμοστούν —
            καθάρισέ τες για να μη μπερδεύουν.
          </p>
          {broken.map((r) => (
            <div key={r.tenant_id} className="flex flex-wrap items-center gap-2 border-t border-rose-100 py-2 text-sm">
              <span className="font-semibold text-slate-800">{r.tenant_name || r.tenant_id}</span>
              <span className="text-rose-700">{r.broken_reason}</span>
              <button onClick={() => act(r.tenant_id, "clear-broken")} disabled={busy === r.tenant_id}
                className="ml-auto rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                {busy === r.tenant_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Καθάρισέ το"}
              </button>
            </div>
          ))}
        </section>
      )}

      <p className="text-[11px] text-slate-400">
        Ο τραπεζικός λογαριασμός και οι τρόποι πληρωμής ρυθμίζονται στο{" "}
        <Link href="/admin/payments" className="text-brand-600 hover:underline">Τρόποι πληρωμής</Link>.
      </p>
    </div>
  );
}
