"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { GitBranch, CheckCircle2, XCircle, Clock, AlertCircle, PhoneCall } from "lucide-react";
import { fmtEur, fmtDate } from "@/lib/formatters";

type Part = { external_id: string; executed_at: string | null; status: string | null; amount_total: number };
type Repeat = { barcode: string; executed_at: string | null; status: string | null; amount_total: number; icd10: string[]; parts: Part[] };
type Slot = { index: number; opening: string | null; state: "executed" | "available" | "lost" | "future"; repeat: Repeat | null };
type Chain = { root: string; is_chain: boolean; plan_incomplete: boolean; interval_months: number | null; total: number; executed_count: number; valid_from: string | null; valid_until: string | null; slots: Slot[] };

const CADENCE: Record<number, string> = { 1: "μηνιαία", 2: "δίμηνη", 3: "τρίμηνη", 4: "τετράμηνη", 6: "εξάμηνη" };

const STATE: Record<string, { label: string; cls: string; dot: string; Icon: typeof CheckCircle2 }> = {
  executed:  { label: "Εκτελεσμένη", cls: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500", Icon: CheckCircle2 },
  available: { label: "Διαθέσιμη τώρα", cls: "bg-sky-100 text-sky-700",       dot: "bg-sky-500",     Icon: AlertCircle },
  lost:      { label: "Χαμένη",       cls: "bg-rose-100 text-rose-700",       dot: "bg-rose-500",    Icon: XCircle },
  future:    { label: "Μελλοντική",   cls: "bg-slate-100 text-slate-500",     dot: "bg-slate-400",   Icon: Clock },
};

const STATE_LABEL_EN: Record<string, string> = {
  executed: "Executed", available: "Available now", lost: "Lost", future: "Upcoming",
};

export function RepeatTree({ externalId }: { externalId: string }) {
  const t = useT();
  const router = useRouter();
  const q = useQuery({ queryKey: ["rx-chain", externalId], queryFn: () => api<Chain>(`/prescriptions/repeats/${encodeURIComponent(externalId)}`) });
  const tree = q.data;
  if (!tree || !tree.is_chain) return null;

  const lost = tree.slots.filter((s) => s.state === "lost").length;
  const available = tree.slots.filter((s) => s.state === "available").length;

  return (
    <div className="rx-card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><GitBranch className="h-4 w-4 text-brand-600" /> {t("Επαναλαμβανόμενη συνταγή — δέντρο επαναλήψεων", "Repeat prescription — repeats tree")}</h3>
        <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">{tree.executed_count} {t("εκτελεσμένες", "executed")}</span>
          {available > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-700">{available} {t("διαθέσιμες", "available")}</span>}
          {lost > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">{lost} {t("χαμένες", "lost")}</span>}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-300">{tree.total} {t("σύνολο", "total")}</span>
        </div>
      </div>
      <div className="mb-3 font-mono text-xs text-slate-400">℞ root {tree.root}{tree.interval_months && CADENCE[tree.interval_months] ? ` · ${t(CADENCE[tree.interval_months], `${tree.interval_months}-monthly`)}` : ""}{tree.valid_from && tree.valid_until ? ` · ${t("ισχύς", "valid")} ${fmtDate(tree.valid_from)} → ${fmtDate(tree.valid_until)}` : ""}</div>

      {tree.plan_incomplete && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <AlertCircle className="h-4 w-4 shrink-0" /> {t("Αυτή είναι επανάληψη μιας αλυσίδας συνταγών — προς το παρόν έχουμε μόνο αυτή την εκτέλεση. Το πλήρες ιστορικό επαναλήψεων (πόσες από πόσες) θα συμπληρωθεί με τον πλήρη συγχρονισμό ΗΔΙΚΑ.", "This is a repeat in a prescription chain — for now we only hold this execution. The full repeat history will be filled in after the complete ΗΔΙΚΑ sync.")}
        </div>
      )}

      {lost > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <PhoneCall className="h-4 w-4 shrink-0" /> <b>{lost}</b> {t("χαμένη/ες επανάληψη/εις — ευκαιρία recall: ο ασθενής έχασε αγωγή + χαμένος τζίρος.", "lost repeat(s) — recall opportunity: the patient missed treatment + lost revenue.")}
        </div>
      )}

      <div className="relative pl-6">
        <div className="absolute bottom-2 left-[9px] top-2 w-0.5 bg-slate-200 dark:bg-slate-700" />
        {tree.slots.map((s) => {
          const st = STATE[s.state];
          const r = s.repeat;
          const isCurrent = r?.parts.some((p) => p.external_id === externalId);
          return (
            <div key={s.index} className={`relative mb-2 rounded-xl border p-2.5 ${isCurrent ? "border-brand-400 bg-brand-50/60 dark:border-brand-600 dark:bg-brand-950/40" : "border-slate-100 dark:border-slate-800"}`}>
              <span className={`absolute -left-[19px] top-3 grid h-4 w-4 place-items-center rounded-full ring-2 ring-white dark:ring-slate-900 ${st.dot}`}>
                <st.Icon className="h-3 w-3 text-white" />
              </span>
              <button
                onClick={() => r && router.push(`/prescriptions/${encodeURIComponent(r.parts[0].external_id)}`)}
                disabled={!r}
                className="flex w-full items-center gap-3 text-left disabled:cursor-default"
              >
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold ${r ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-400 dark:bg-slate-800"}`}>{s.index + 1}/{tree.total}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                    {r?.executed_at ? fmtDate(r.executed_at) : `${t("έναρξη", "starts")} ${s.opening ? fmtDate(s.opening) : "—"}`}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{t(st.label, STATE_LABEL_EN[s.state] ?? st.label)}</span>
                    {r && r.status !== "executed" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">{t("μερική", "partial")}</span>}
                    {isCurrent && <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">{t("τρέχουσα", "current")}</span>}
                  </div>
                  {r?.icd10?.length ? <div className="mt-0.5 truncate text-xs text-slate-400">{r.icd10.join(", ")}</div> : null}
                </div>
                {r && <span className="shrink-0 text-sm font-semibold text-slate-700 dark:text-slate-200">{fmtEur(r.amount_total)}</span>}
              </button>

              {/* nested partial executions */}
              {r && r.parts.length > 1 && (
                <div className="mt-2 ml-12 space-y-1 border-l border-dashed border-slate-200 pl-3 dark:border-slate-700">
                  {r.parts.map((p, k) => (
                    <div key={p.external_id} className="flex items-center justify-between text-xs text-slate-500">
                      <span>{t("Μερική εκτέλεση", "Partial execution")} {k + 1}: {p.executed_at ? fmtDate(p.executed_at) : "—"}</span>
                      <span className="font-medium text-slate-600 dark:text-slate-300">{fmtEur(p.amount_total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
