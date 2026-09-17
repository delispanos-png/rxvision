"use client";

/* Κύκλος ζωής λογαριασμού — τι λήγει, τι κρατιέται, τι διαγράφεται και πότε.
   Η σελίδα απαντά σε δύο ερωτήσεις: «χάνω πελάτη;» και «πόσο χώρο κρατάω για λογαριασμούς
   που δεν υπάρχουν πια;». Η διαγραφή είναι μη αναστρέψιμη, οπότε εδώ πρέπει να φαίνεται
   ΠΡΙΝ συμβεί — όχι μετά. */

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { Trash2, Clock, AlertTriangle, Database, Settings2, Loader2, Play } from "lucide-react";

type Row = {
  tenant_id: string; tenant_name?: string; plan?: string; is_trial?: boolean;
  stage: string; stage_label: string; expired_at?: string | null; delete_at?: string | null;
  days_left?: number | null; notices?: string[]; final_notice_at?: string | null;
  can_delete?: boolean; blocked?: string | null; executions?: number;
};
type Cfg = { enabled: boolean; trial_delete_days: number; paid_delete_days: number;
             final_notice_days: number; notice_days: number[] };
type Res = { items: Row[]; config: Cfg; freeable_executions: number };

const gr = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR",
  { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Athens" }) : "—");
const TONE: Record<string, string> = {
  grace: "bg-amber-100 text-amber-700",
  expired: "bg-slate-100 text-slate-600",
  final_notice: "bg-orange-100 text-orange-700",
  deletable: "bg-rose-100 text-rose-700",
};

export default function LifecyclePage() {
  const qc = useQueryClient();
  const [cfgOpen, setCfgOpen] = useState(false);
  const q = useQuery({ queryKey: ["admin", "lifecycle"], queryFn: () => adminApi<Res>("/admin/lifecycle") });
  const run = useMutation({
    mutationFn: (dry: boolean) => adminApi<{ notices_sent: number; deleted: string[]; blocked: { name: string; why: string }[] }>(
      `/admin/lifecycle/run?dry_run=${dry}`, { method: "POST" }),
    onSuccess: (r, dry) => {
      qc.invalidateQueries({ queryKey: ["admin", "lifecycle"] });
      appAlert(dry
        ? `Δοκιμή χωρίς αλλαγές: θα έφευγαν ${r.notices_sent} ειδοποιήσεις, θα διαγράφονταν ${r.deleted.length}.`
        : `Στάλθηκαν ${r.notices_sent} ειδοποιήσεις. Διαγράφηκαν ${r.deleted.length} λογαριασμοί.`);
    },
  });

  const rows = q.data?.items ?? [];
  const c = q.data?.config;
  const soon = rows.filter((r) => (r.days_left ?? 999) <= (c?.final_notice_days ?? 7));

  return (
    <div className="w-full space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Κύκλος ζωής λογαριασμού</h1>
          <p className="mt-1 text-sm text-slate-500">
            Τι λήγει, μέχρι πότε κρατάμε τα δεδομένα και πότε διαγράφονται οριστικά.
            Κανείς δεν διαγράφεται χωρίς να έχει λάβει τελική προειδοποίηση.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setCfgOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"><Settings2 className="h-4 w-4" />Ρυθμίσεις</button>
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Δοκιμή χωρίς αλλαγές
          </button>
        </div>
      </header>

      {!!soon.length && (
        <section className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-rose-900">
            <AlertTriangle className="h-4 w-4" />Διαγράφονται σύντομα ({soon.length})
          </h2>
          <p className="mt-1 text-xs text-rose-700">
            Αν κάποιος από αυτούς είναι ακόμη υποψήφιος πελάτης, κάλεσέ τον{" "}
            <Link href="/admin/leads" className="font-semibold underline">από τα Leads</Link> πριν χαθούν τα δεδομένα του.
          </p>
          {soon.map((r) => (
            <div key={r.tenant_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rose-100 py-2 text-sm">
              <span className="font-semibold text-slate-800">{r.tenant_name}</span>
              <span className="text-rose-700">διαγραφή {gr(r.delete_at)} — σε {r.days_left} ημέρες</span>
              <span className="text-xs text-slate-500">{(r.executions ?? 0).toLocaleString("el-GR")} εκτελέσεις</span>
            </div>
          ))}
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          <Clock className="h-3.5 w-3.5" />Όλοι οι λογαριασμοί εκτός κανονικής λειτουργίας
          <span className="ml-auto inline-flex items-center gap-1 normal-case text-slate-500">
            <Database className="h-3.5 w-3.5" />
            {(q.data?.freeable_executions ?? 0).toLocaleString("el-GR")} εκτελέσεις έτοιμες να ελευθερωθούν
          </span>
        </div>
        {q.isLoading && <p className="p-8 text-center text-sm text-slate-400">Φόρτωση…</p>}
        {!q.isLoading && !rows.length && (
          <p className="p-8 text-center text-sm text-slate-400">Όλοι οι λογαριασμοί είναι σε κανονική λειτουργία.</p>
        )}
        {rows.map((r) => (
          <div key={r.tenant_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-50 px-4 py-2.5 text-sm last:border-0">
            <span className="min-w-[180px] flex-1 font-semibold text-slate-800">{r.tenant_name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE[r.stage] ?? TONE.expired}`}>{r.stage_label}</span>
            <span className="text-xs text-slate-500">{r.is_trial ? "δοκιμαστική" : "πληρωμένη"}</span>
            <span className="text-xs text-slate-500">έληξε {gr(r.expired_at)}</span>
            <span className="text-xs font-semibold text-slate-700">
              {r.delete_at ? <>διαγραφή {gr(r.delete_at)}{r.days_left != null && <span className="text-slate-400"> (σε {r.days_left}μ)</span>}</> : "—"}
            </span>
            <span className="text-xs tabular-nums text-slate-400">{(r.executions ?? 0).toLocaleString("el-GR")} εκτ.</span>
            {r.blocked && <span className="text-[11px] font-semibold text-amber-700">⛔ {r.blocked}</span>}
            {!!(r.notices ?? []).length && <span className="text-[11px] text-slate-400">{r.notices!.length} ειδοποιήσεις</span>}
          </div>
        ))}
      </section>

      {c && (
        <p className="text-[11px] text-slate-400">
          Δοκιμαστική: διαγραφή <b>{c.trial_delete_days}</b> ημέρες μετά τη λήξη · Πληρωμένη: <b>{c.paid_delete_days}</b> ημέρες ·
          Τελική προειδοποίηση <b>{c.final_notice_days}</b> ημέρες πριν · Ειδοποιήσεις στις ημέρες {c.notice_days.join(", ")} μετά τη λήξη.
        </p>
      )}

      {cfgOpen && c && <CfgModal cfg={c} onClose={() => { setCfgOpen(false); qc.invalidateQueries({ queryKey: ["admin", "lifecycle"] }); }} />}
    </div>
  );
}

function CfgModal({ cfg, onClose }: { cfg: Cfg; onClose: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => adminApi("/admin/lifecycle", { method: "PUT", body: JSON.stringify(
      Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "").map(([k, x]) => [k, Number(x)]))) }),
    onSuccess: onClose,
  });
  const F: [keyof Cfg, string][] = [
    ["trial_delete_days", "Διαγραφή δοκιμαστικής — ημέρες μετά τη λήξη"],
    ["paid_delete_days", "Διαγραφή πληρωμένης που έφυγε — ημέρες μετά τη λήξη"],
    ["final_notice_days", "Πόσες ημέρες πριν τη διαγραφή φεύγει η τελική προειδοποίηση"],
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-bold text-slate-900">Ρυθμίσεις κύκλου ζωής</h3>
        <p className="mb-4 text-xs text-slate-500">
          Η διαγραφή είναι οριστική. Το μεγαλύτερο παράθυρο για τους πληρωμένους είναι σκόπιμο:
          τα δεδομένα είναι δικά τους και ένας πελάτης που πλήρωνε αξίζει χρόνο να επιστρέψει.
        </p>
        <div className="space-y-3">
          {F.map(([k, label]) => (
            <label key={k} className="block">
              <span className="text-xs font-semibold text-slate-600">{label}</span>
              <input type="number" value={v[k] ?? ""} placeholder={String(cfg[k])}
                onChange={(e) => setV({ ...v, [k]: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600">Άκυρο</button>
          <button onClick={async () => {
            if (await appConfirm("Αποθήκευση; Τα νούμερα αυτά καθορίζουν πότε διαγράφονται οριστικά δεδομένα πελατών.", { title: "Επιβεβαίωση", confirmText: "Αποθήκευση" })) save.mutate();
          }} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
            <Trash2 className="h-4 w-4" />Αποθήκευση
          </button>
        </div>
      </div>
    </div>
  );
}
