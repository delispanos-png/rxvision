"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Zap, Clock, Check } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { QueryState } from "@/components/ui/QueryState";

type Row = { id: string; title: string; channel: string; status: string; when: string;
             scheduled: boolean; automation: boolean; recipients: number; sent: number };

const dt = (s: string) => new Date(s).toLocaleDateString("el-GR", { weekday: "short", day: "2-digit", month: "short" });

/** Ημερολόγιο επικοινωνίας: υπάρχει για να ΜΗΝ στέλνεις πολλά. Βλέπεις με μια ματιά πόσο συχνά
 *  ενοχλείς τον κόσμο — και μια εβδομάδα με τέσσερα μηνύματα φαίνεται αμέσως. */
export default function CommsCalendarPage() {
  const t = useT();
  const q = useQuery({ queryKey: ["comms", "calendar"], queryFn: () => api<{ items: Row[] }>("/communications/calendar?days=60") });
  const rows = q.data?.items ?? [];
  const byDay = rows.reduce<Record<string, Row[]>>((acc, r) => {
    const k = (r.when || "").slice(0, 10);
    (acc[k] = acc[k] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).sort().reverse();

  return (
    <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
      {!rows.length ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="text-3xl" aria-hidden>📅</div>
          <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{t("Καθαρός μήνας.", "A clear month.")}</p>
          <p className="mt-1 text-xs text-slate-400">{t("Κανείς δεν θα λάβει μήνυμα από σένα.", "Nobody will hear from you.")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {days.map((d) => (
            <div key={d} className="flex gap-4">
              <div className="w-24 shrink-0 pt-1 text-xs font-semibold uppercase text-slate-400">{dt(d)}</div>
              <div className="min-w-0 flex-1 space-y-2">
                {byDay[d].map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    {r.automation ? <Zap className="h-4 w-4 shrink-0 text-amber-500" />
                      : r.scheduled && r.status === "queued" ? <Clock className="h-4 w-4 shrink-0 text-sky-500" />
                      : <Check className="h-4 w-4 shrink-0 text-emerald-500" />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{r.title}</span>
                    <span className="text-[11px] uppercase text-slate-400">{r.channel}</span>
                    <span className="text-xs text-slate-500">
                      {r.status === "queued" && r.scheduled ? t("θα σταλεί", "scheduled")
                        : t(`${r.sent} από ${r.recipients}`, `${r.sent} of ${r.recipients}`)}
                    </span>
                  </div>
                ))}
                {byDay[d].length >= 3 && (
                  <p className="text-[11px] text-amber-600">
                    {t(`${byDay[d].length} μηνύματα την ίδια μέρα — σκέψου αν χρειάζονται όλα.`,
                      `${byDay[d].length} messages on one day — consider trimming.`)}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </QueryState>
  );
}
