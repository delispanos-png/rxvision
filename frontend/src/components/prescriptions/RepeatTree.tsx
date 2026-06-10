"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { GitBranch, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { fmtEur, fmtDate } from "@/lib/formatters";

type Exec = { external_id: string; exec_no: number; executed_at: string | null; status: string | null; amount_total: number; repeat_total: number; icd10: string[] };
type Tree = { barcode: string; total: number; done: number; executions: Exec[]; next_expected: string | null };

export function RepeatTree({ externalId }: { externalId: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ["rx-repeats", externalId], queryFn: () => api<Tree>(`/prescriptions/repeats/${encodeURIComponent(externalId)}`) });
  const t = q.data;
  if (!t) return null;
  if (t.total <= 1 && t.executions.length <= 1) return null; // single-shot rx → no tree to show

  return (
    <div className="rx-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><GitBranch className="h-4 w-4 text-brand-600" /> Δέντρο συνταγής — επαναλήψεις</h3>
        <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">{t.done}/{t.total} εκτελέσεις</span>
      </div>
      <div className="mb-3 font-mono text-xs text-slate-400">℞ {t.barcode}</div>

      <div className="relative pl-6">
        {/* the trunk */}
        <div className="absolute bottom-2 left-[9px] top-2 w-0.5 bg-slate-200 dark:bg-slate-700" />
        {t.executions.map((e) => {
          const done = e.status === "executed";
          const isCurrent = e.external_id === externalId;
          return (
            <button
              key={e.external_id}
              onClick={() => router.push(`/prescriptions/${encodeURIComponent(e.external_id)}`)}
              className={`group relative mb-2 flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition ${isCurrent ? "border-brand-400 bg-brand-50/60 dark:border-brand-600 dark:bg-brand-950/40" : "border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-800/50"}`}
            >
              {/* node dot */}
              <span className={`absolute -left-[19px] grid h-4 w-4 place-items-center rounded-full ring-2 ring-white dark:ring-slate-900 ${done ? "bg-emerald-500" : "bg-amber-500"}`}>
                {done ? <CheckCircle2 className="h-3 w-3 text-white" /> : <AlertCircle className="h-3 w-3 text-white" />}
              </span>
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold ${isCurrent ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>{e.exec_no}/{t.total}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                  {e.executed_at ? fmtDate(e.executed_at) : "—"}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{done ? "Εκτελεσμένη" : "Μερική"}</span>
                  {isCurrent && <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">τρέχουσα</span>}
                </div>
                {e.icd10?.length > 0 && <div className="mt-0.5 truncate text-xs text-slate-400">{e.icd10.join(", ")}</div>}
              </div>
              <span className="shrink-0 text-sm font-semibold text-slate-700 dark:text-slate-200">{fmtEur(e.amount_total)}</span>
            </button>
          );
        })}

        {/* future node */}
        {t.next_expected && (
          <div className="relative flex items-center gap-3 rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-600">
            <span className="absolute -left-[19px] grid h-4 w-4 place-items-center rounded-full bg-slate-300 ring-2 ring-white dark:bg-slate-600 dark:ring-slate-900"><Clock className="h-3 w-3 text-white" /></span>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-bold text-slate-400 dark:bg-slate-800">{Math.min(t.done + 1, t.total)}/{t.total}</span>
            <div className="flex-1 text-sm text-slate-500">Επόμενη αναμενόμενη — <b className="text-slate-700 dark:text-slate-200">{fmtDate(t.next_expected)}</b></div>
            <span className="text-xs text-slate-400">πρόβλεψη</span>
          </div>
        )}
      </div>
    </div>
  );
}
